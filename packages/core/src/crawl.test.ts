/**
 * Crawler, extraction, robots and rule fixes, exercised against real local HTTP
 * servers (vitest sets ALLOW_PRIVATE_NETWORK=1 so 127.0.0.1 is reachable).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { crawl, decodeHtml, type CrawlResult } from "./crawler.js";
import { extract } from "./extract.js";
import { crawlDelayFor, isAllowed, parseRobots, parseSitemap } from "./robots.js";
import { resolveRedirects } from "./redirects.js";
import { normalizeUrl } from "./url.js";
import { groupFindings, runRules, slugify, type AnalyzedPage, type Finding } from "./rules/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type Spec = { status?: number; headers?: Record<string, string>; body?: string | Buffer; delayMs?: number };

const html = (body: string, head = "") =>
  `<!doctype html><html lang="fa"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

async function serve(routes: Record<string, Spec | Handler>) {
  const log: Array<{ path: string; at: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let base = "";
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    log.push({ path, at: Date.now() });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.on("close", () => inFlight--);
    const route = routes[path] ?? routes[path.split("?")[0]!];
    if (!route) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("<h1>404</h1>"));
      return;
    }
    if (typeof route === "function") return route(req, res);
    if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
    const headers = Object.fromEntries(
      Object.entries({ "content-type": "text/html; charset=utf-8", ...route.headers }).map(([k, v]) => [
        k,
        v.replaceAll("{{BASE}}", base),
      ]),
    );
    res.writeHead(route.status ?? 200, headers);
    const body = route.body ?? "";
    res.end(typeof body === "string" ? body.replaceAll("{{BASE}}", base) : body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  servers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return {
    base,
    log,
    paths: () => log.map((l) => l.path),
    maxInFlight: () => maxInFlight,
  };
}

const noRobots: Spec = { status: 404, body: "" };

/** The same mapping the pipeline does, so rules run on what a real run would give them. */
function analyzed(result: CrawlResult): AnalyzedPage[] {
  const redirects = resolveRedirects(result.pages);
  return result.pages.map((p) => ({
    url: p.url,
    normalizedUrl: p.normalizedUrl,
    depth: p.depth,
    statusCode: p.statusCode,
    responseMs: p.responseMs,
    title: p.extracted?.title ?? null,
    titleLength: p.extracted?.titleLength ?? 0,
    metaDescription: p.extracted?.metaDescription ?? null,
    metaDescriptionLength: p.extracted?.metaDescriptionLength ?? 0,
    h1s: p.extracted?.h1s ?? [],
    canonical: p.extracted?.canonical ?? null,
    robotsMeta: p.extracted?.robotsMeta ?? null,
    xRobotsTag: p.xRobotsTag,
    indexable: p.indexable,
    noindexReason: p.noindexReason,
    lang: p.extracted?.lang ?? null,
    wordCount: p.extracted?.wordCount ?? 0,
    imagesTotal: p.extracted?.imagesTotal ?? 0,
    imagesMissingAlt: p.extracted?.imagesMissingAlt ?? 0,
    imagesWithoutAlt: p.extracted?.imagesWithoutAlt ?? [],
    links: p.extracted?.links ?? [],
    internalLinksOut: p.extracted?.internalLinksOut ?? 0,
    externalLinksOut: p.extracted?.externalLinksOut ?? 0,
    internalLinksIn: result.inboundLinks.get(p.normalizedUrl) ?? 0,
    inSitemap: p.inSitemap,
    redirectTarget: p.redirectTarget,
    redirectChain: redirects.get(p.normalizedUrl)?.chain ?? [],
    redirectLoop: redirects.get(p.normalizedUrl)?.loop ?? false,
    textHash: p.extracted?.textHash ?? null,
  }));
}

function rulesFor(result: CrawlResult, baseUrl: string): Finding[] {
  return runRules({
    project: { id: "p", baseUrl, locale: "fa" },
    pages: analyzed(result),
    sitemapUrls: result.sitemapUrls,
    robots: result.robots,
    userAgent: "SeoTableBot/0.4",
  }).findings;
}

const page = (title: string, body = "", head = "") =>
  html(`<h1>${title}</h1><p>${"متن کافی برای صفحه. ".repeat(40)}</p>${body}`, `<title>${title}</title>${head}`);

const baseOpts = { pageCap: 100, requestsPerSecond: 200, userAgent: "SeoTableBot/0.4" };

describe("trailing slashes and redirects", () => {
  it("fetches /blog/ after /blog → /blog/ and reports no loop", async () => {
    const site = await serve({
      "/robots.txt": noRobots,
      "/": { body: page("خانه", `<a href="/blog">بلاگ</a>`) },
      "/blog": { status: 301, headers: { location: "{{BASE}}/blog/" } },
      "/blog/": { body: page("بلاگ", `<a href="/">خانه</a>`) },
    });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    const blog = result.pages.find((p) => p.normalizedUrl === `${site.base}/blog`);
    const blogSlash = result.pages.find((p) => p.normalizedUrl === `${site.base}/blog/`);
    expect(blog?.statusCode).toBe(301);
    expect(blog?.redirectTarget).toBe(`${site.base}/blog/`);
    expect(blogSlash?.statusCode).toBe(200);
    expect(site.paths()).toContain("/blog/");

    const findings = rulesFor(result, site.base);
    expect(findings.filter((f) => f.ruleId === "rule.index.redirect_chain")).toEqual([]);
    // Links to /blog count for /blog/, so the real page is not an orphan.
    expect(result.inboundLinks.get(`${site.base}/blog/`)).toBe(1);
    expect(findings.some((f) => f.ruleId === "rule.links.orphan" && f.url.endsWith("/blog/"))).toBe(false);
  });

  it("follows a redirect that only changes escape case, and still reports a real self-redirect", async () => {
    const site = await serve({
      "/robots.txt": noRobots,
      "/": { body: page("خانه", `<a href="/p%c3%a9">p</a><a href="/self">self</a>`) },
      "/p%c3%a9": { status: 301, headers: { location: "/p%C3%A9" } },
      "/p%C3%A9": { body: page("صفحه") },
      "/self": { status: 301, headers: { location: "/self" } },
    });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    const p = result.pages.find((x) => x.normalizedUrl === `${site.base}/p%C3%A9`);
    expect(p?.statusCode).toBe(200);
    const loops = rulesFor(result, site.base).filter((f) => f.ruleId === "rule.index.redirect_chain");
    expect(loops.map((f) => f.url)).toEqual([`${site.base}/self`]);
  });
});

describe("concurrency and politeness", () => {
  it("keeps several requests in flight", async () => {
    const links = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">${i}</a>`).join("");
    const routes: Record<string, Spec> = { "/robots.txt": noRobots, "/": { body: page("خانه", links) } };
    for (let i = 0; i < 12; i++) routes[`/p${i}`] = { body: page(`صفحه ${i}`), delayMs: 200 };
    const site = await serve(routes);
    const t0 = Date.now();
    const result = await crawl({ ...baseOpts, baseUrl: site.base, concurrency: 4 });
    expect(result.pages).toHaveLength(13);
    expect(site.maxInFlight()).toBeGreaterThanOrEqual(3);
    // 12 × 200 ms serially would be 2.4 s.
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("spaces requests by Crawl-delay once for the whole crawl, not once per worker", async () => {
    const links = Array.from({ length: 3 }, (_, i) => `<a href="/p${i}">${i}</a>`).join("");
    const routes: Record<string, Spec> = {
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 0.4\n" },
      "/": { body: page("خانه", links) },
    };
    for (let i = 0; i < 3; i++) routes[`/p${i}`] = { body: page(`صفحه ${i}`) };
    const site = await serve(routes);
    await crawl({ ...baseOpts, baseUrl: site.base, concurrency: 4 });
    const pageHits = site.log.filter((l) => l.path !== "/robots.txt");
    expect(pageHits.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < pageHits.length; i++) {
      const gap = pageHits[i]!.at - pageHits[i - 1]!.at;
      expect(gap).toBeGreaterThanOrEqual(380);
      // Not multiplied by the four workers.
      expect(gap).toBeLessThan(800);
    }
  });

  it("uses the specific group's Crawl-delay without inheriting *'s", () => {
    const robots = parseRobots("User-agent: *\nCrawl-delay: 5\n\nUser-agent: SeoTableBot\nDisallow: /x\n");
    expect(crawlDelayFor(robots, "SeoTableBot/0.4")).toBeNull();
    expect(crawlDelayFor(robots, "OtherBot/1.0")).toBe(5);
  });
});

describe("charset and content type", () => {
  // سلام in windows-1256
  const cp1256 = Buffer.from([0xd3, 0xe1, 0xc7, 0xe3]);

  it("decodes by header, BOM and <meta>", () => {
    expect(new TextDecoder("windows-1256").decode(cp1256)).toBe("سلام");
    const doc = Buffer.concat([Buffer.from("<html><head><title>"), cp1256, Buffer.from("</title></head></html>")]);
    expect(decodeHtml(doc, "text/html; charset=windows-1256")).toContain("سلام");
    const withMeta = Buffer.concat([
      Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1256"><title>'),
      cp1256,
      Buffer.from("</title></head></html>"),
    ]);
    expect(decodeHtml(withMeta, "text/html")).toContain("سلام");
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<title>سلام</title>")]);
    expect(decodeHtml(bom, "text/html; charset=windows-1256")).toBe("<title>سلام</title>");
  });

  it("crawls a windows-1256 page and a PDF correctly", async () => {
    const doc = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1256"><title>'),
      cp1256,
      Buffer.from('</title></head><body><a href="/file">f</a></body></html>'),
    ]);
    const site = await serve({
      "/robots.txt": noRobots,
      "/": { headers: { "content-type": "text/html" }, body: doc },
      "/file": { headers: { "content-type": "application/pdf" }, body: Buffer.from("%PDF-1.4 ...") },
    });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    const home = result.pages.find((p) => p.normalizedUrl === `${site.base}/`)!;
    expect(home.extracted?.title).toBe("سلام");
    expect(home.bodyBytes).toBe(doc.length);
    const pdf = result.pages.find((p) => p.normalizedUrl === `${site.base}/file`)!;
    expect(pdf.statusCode).toBe(200);
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.noindexReason).toBe("non_html");
    const onPdf = rulesFor(result, site.base).filter((f) => f.url === pdf.normalizedUrl);
    expect(onPdf).toEqual([]);
  });
});

describe("robots.txt", () => {
  it("treats a 5xx robots.txt as a complete disallow and says why", async () => {
    const site = await serve({
      "/robots.txt": { status: 503, body: "" },
      "/": { body: page("خانه") },
    });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    expect(result.robots.unreachable).toBe(true);
    expect(result.pages).toEqual([]);
    expect(site.paths().filter((p) => p !== "/robots.txt")).toEqual([]);
    const ids = rulesFor(result, site.base).map((f) => f.ruleId);
    expect(ids).toContain("rule.robots.unreachable");
    expect(ids).not.toContain("rule.robots.missing");
    expect(ids).not.toContain("rule.sitemap.missing");
  });

  it("treats a 404 robots.txt as allow-all", async () => {
    const site = await serve({ "/robots.txt": noRobots, "/": { body: page("خانه") } });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    expect(result.robots.missing).toBe(true);
    expect(result.pages).toHaveLength(1);
  });

  it("matches percent-encoded and literal non-ASCII paths alike", async () => {
    const robots = parseRobots("User-agent: *\nDisallow: /دسته\nDisallow: /a%3cb\n");
    expect(isAllowed(robots, "https://e.ir/%D8%AF%D8%B3%D8%AA%D9%87/x", "SeoTableBot")).toBe(false);
    expect(isAllowed(robots, "https://e.ir/%d8%af%d8%b3%d8%aa%d9%87", "SeoTableBot")).toBe(false);
    expect(isAllowed(robots, "https://e.ir/a%3Cb", "SeoTableBot")).toBe(false);
    expect(isAllowed(robots, "https://e.ir/%7Euser", "x")).toBe(isAllowed(robots, "https://e.ir/~user", "x"));
    expect(isAllowed(robots, "https://e.ir/other", "SeoTableBot")).toBe(true);

    const site = await serve({
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /دسته\n" },
      "/": { body: page("خانه", `<a href="/دسته/کفش">x</a><a href="/ok">ok</a>`) },
      "/ok": { body: page("ok") },
    });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    expect(result.skipped.robotsDisallowed).toBe(1);
    expect(site.paths().some((p) => p.startsWith("/%D8"))).toBe(false);
  });

  it("matches a group on the product token, not a substring", () => {
    const robots = parseRobots("User-agent: bot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n");
    expect(isAllowed(robots, "https://e.ir/page", "SeoTableBot/0.4 (+https://seo-table.app/bot)")).toBe(true);
    expect(isAllowed(robots, "https://e.ir/private", "SeoTableBot/0.4")).toBe(false);
    expect(isAllowed(robots, "https://e.ir/page", "Bot/2.0")).toBe(false);
  });
});

describe("sitemaps", () => {
  it("reads gzip, CDATA and numeric entities", () => {
    expect(
      parseSitemap(
        "<urlset><url><loc><![CDATA[https://e.ir/a?x=1&y=2]]></loc></url><url><loc>https://e.ir/b?x=1&#38;y=&#x32;</loc></url></urlset>",
      ).urls,
    ).toEqual(["https://e.ir/a?x=1&y=2", "https://e.ir/b?x=1&y=2"]);
  });

  it("stops three index levels below the root", async () => {
    const routes: Record<string, Spec> = {
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nAllow: /\nSitemap: {{BASE}}/index-0.xml.gz\n",
      },
      "/": { body: page("خانه") },
    };
    const site = await serve(routes);
    // Gzipped bodies cannot be templated, so they are built once the port is known.
    for (let i = 0; i < 6; i++) {
      routes[`/index-${i}.xml.gz`] = {
        headers: { "content-type": "application/x-gzip" },
        body: gzipSync(
          `<sitemapindex><sitemap><loc><![CDATA[${site.base}/index-${i + 1}.xml.gz]]></loc></sitemap></sitemapindex>`,
        ),
      };
    }
    await crawl({ ...baseOpts, baseUrl: site.base });
    expect(site.paths().filter((p) => p.startsWith("/index-"))).toEqual([
      "/index-0.xml.gz",
      "/index-1.xml.gz",
      "/index-2.xml.gz",
      "/index-3.xml.gz",
    ]);
  });

  it("stops after 50 sitemap fetches in total", async () => {
    const routes: Record<string, Spec> = {
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "Sitemap: {{BASE}}/wide.xml\n" },
      "/": { body: page("خانه") },
      "/leaf": { body: page("برگ") },
      "/wide.xml": {
        headers: { "content-type": "application/xml" },
        body: `<sitemapindex>${Array.from({ length: 80 }, (_, i) => `<sitemap><loc>{{BASE}}/c-${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`,
      },
    };
    for (let i = 0; i < 80; i++) {
      routes[`/c-${i}.xml`] = {
        headers: { "content-type": "application/xml" },
        body: `<urlset><url><loc>{{BASE}}/leaf</loc></url></urlset>`,
      };
    }
    const site = await serve(routes);
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    expect(site.paths().filter((p) => p.endsWith(".xml"))).toHaveLength(50);
    expect(result.sitemapUrls.has(`${site.base}/leaf`)).toBe(true);
  });
});

describe("click depth and orphans", () => {
  it("uses click depth, not path depth, and leaves sitemap-only pages at unknown depth", async () => {
    const site = await serve({
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "Sitemap: {{BASE}}/sitemap.xml\n" },
      "/sitemap.xml": {
        headers: { "content-type": "application/xml" },
        body: `<urlset><url><loc>{{BASE}}/a/b/c/d/e/f</loc></url><url><loc>{{BASE}}/x/y/z/w/v/only</loc></url></urlset>`,
      },
      "/": { body: page("خانه", `<a href="/a/b/c/d/e/f">عمیق</a><a href="/">خود</a>`) },
      "/a/b/c/d/e/f": { body: page("عمیق") },
      "/x/y/z/w/v/only": { body: page("فقط نقشه") },
    });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    const deep = result.pages.find((p) => p.normalizedUrl.endsWith("/a/b/c/d/e/f"))!;
    const only = result.pages.find((p) => p.normalizedUrl.endsWith("/only"))!;
    expect(deep.depth).toBe(1);
    expect(only.depth).toBeNull();
    // The home page's link to itself is not an inbound link.
    expect(result.inboundLinks.get(`${site.base}/`) ?? 0).toBe(0);

    const findings = rulesFor(result, site.base);
    expect(findings.filter((f) => f.ruleId === "rule.links.depth")).toEqual([]);
    const orphans = findings.filter((f) => f.ruleId === "rule.links.orphan").map((f) => f.url);
    expect(orphans).toEqual([only.normalizedUrl]);
  });

  it("does not follow links on a meta-nofollow page", async () => {
    const site = await serve({
      "/robots.txt": noRobots,
      "/": { body: page("خانه", `<a href="/nf">nf</a>`) },
      "/nf": { body: page("nf", `<a href="/hidden">h</a>`, `<META NAME="Robots" CONTENT="nofollow">`) },
      "/hidden": { body: page("hidden") },
    });
    await crawl({ ...baseOpts, baseUrl: site.base });
    expect(site.paths()).not.toContain("/hidden");
  });
});

describe("canonical targets outside the crawl", () => {
  it("fetches them before judging, and reports an unfetchable one only as unverified", async () => {
    const site = await serve({
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /blocked\n" },
      "/": { body: page("خانه", `<a href="/a">a</a><a href="/b">b</a>`) },
      "/a": { body: page("a", "", `<link rel="canonical" href="/a-real">`) },
      "/a-real": { body: page("a-real") },
      "/b": { body: page("b", "", `<link rel="canonical" href="/blocked/b">`) },
    });
    const result = await crawl({ ...baseOpts, baseUrl: site.base });
    expect(site.paths()).toContain("/a-real");
    const canon = rulesFor(result, site.base).filter((f) => f.ruleId === "rule.canonical.broken");
    expect(canon).toHaveLength(1);
    expect(canon[0]).toMatchObject({ url: `${site.base}/b`, severity: "INFO", groupKey: "unverified_target" });
    expect(canon[0]!.fix).toBeUndefined();
  });
});

describe("extract", () => {
  it("counts words across minified markup", () => {
    const e = extract(html("<ul><li>one</li><li>two</li><li>three</li></ul><p>four</p>"), "https://e.ir/");
    expect(e.wordCount).toBe(4);
  });

  it("resolves links and canonical against <base href>", () => {
    const e = extract(
      `<html><head><base href="https://e.ir/shop/"><link rel="Canonical" href="item"></head><body><a href="p1">x</a></body></html>`,
      "https://e.ir/other/page",
    );
    expect(e.canonical).toBe("https://e.ir/shop/item");
    expect(e.links[0]?.url).toBe("https://e.ir/shop/p1");
  });

  it("reads meta names case-insensitively, includes googlebot, and collapses whitespace", () => {
    const e = extract(
      `<html><head><title>
        Title   with
        breaks </title>
        <meta name="Description" content="  a   description  ">
        <meta name="GOOGLEBOT" content="noindex">
        <meta name="Viewport" content="width=device-width">
      </head><body><h1>  Head
      line </h1></body></html>`,
      "https://e.ir/",
    );
    expect(e.title).toBe("Title with breaks");
    expect(e.titleLength).toBe("Title with breaks".length);
    expect(e.metaDescription).toBe("a description");
    expect(e.robotsMeta).toBe("noindex");
    expect(e.hasViewport).toBe(true);
    expect(e.h1s).toEqual(["Head line"]);
  });

  it("walks JSON-LD @graph", () => {
    const e = extract(
      html(
        "",
        `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["Product","Thing"]}]}</script>`,
      ),
      "https://e.ir/",
    );
    expect(e.structuredDataTypes.sort()).toEqual(["Organization", "Product", "Thing"]);
  });
});

describe("normalizeUrl", () => {
  it("normalises escape case and unreserved escapes", () => {
    expect(normalizeUrl("https://e.ir/%d8%b3")).toBe(normalizeUrl("https://e.ir/%D8%B3"));
    expect(normalizeUrl("https://e.ir/%7euser")).toBe("https://e.ir/~user");
  });
  it("strips only known tracking parameters and keeps bare keys", () => {
    expect(normalizeUrl("https://e.ir/a?utm_x=1&gclid=2&_hsenc=3&ref=home&flag&b=1")).toBe(
      "https://e.ir/a?b=1&flag&ref=home",
    );
  });
});

describe("rules", () => {
  it("does not flag the home page as an orphan, however the base URL is written", () => {
    const home: AnalyzedPage = {
      ...analyzedStub,
      url: "https://e.ir/",
      normalizedUrl: "https://e.ir/",
    };
    const findings = runRules({
      project: { id: "p", baseUrl: "https://e.ir", locale: "fa" },
      pages: [home],
      sitemapUrls: new Set(),
      robots: parseRobots("", "missing"),
      userAgent: "SeoTableBot",
    }).findings;
    expect(findings.filter((f) => f.ruleId === "rule.links.orphan")).toEqual([]);
  });

  it("suggests a decoded slug, and meta duplicates compare the whole text", () => {
    const shared = "x".repeat(64);
    const pages: AnalyzedPage[] = [
      { ...analyzedStub, normalizedUrl: "https://e.ir/%D8%B3%D9%84%D8%A7%D9%85", metaDescription: `${shared} one` },
      { ...analyzedStub, normalizedUrl: "https://e.ir/b", metaDescription: `${shared} two` },
    ];
    const findings = runRules({
      project: { id: "p", baseUrl: "https://e.ir", locale: "fa", brand: "E" },
      pages,
      sitemapUrls: new Set(),
      robots: parseRobots("", "missing"),
      userAgent: "SeoTableBot",
    }).findings;
    const titleFix = findings.find((f) => f.ruleId === "rule.title.duplicate" && f.url.endsWith("%85"));
    expect(titleFix?.fix?.change.after).toBe("سلام | E");
    expect(findings.filter((f) => f.ruleId === "rule.meta.duplicate")).toEqual([]);
  });

  it("keeps combining marks in slugs", () => {
    expect(slugify("کِتاب خوب")).toBe("کِتاب-خوب");
  });

  it("groups occurrences with each URL once", () => {
    const f = (url: string): Finding => ({ ruleId: "r", category: "c", severity: "INFO", title: "t", url, evidence: {} });
    const [group] = groupFindings([f("a"), f("b"), f("a")]);
    expect(group?.urls).toEqual(["a", "b"]);
    expect(group?.findings).toHaveLength(3);
  });
});

const analyzedStub: AnalyzedPage = {
  url: "https://e.ir/x",
  normalizedUrl: "https://e.ir/x",
  depth: 1,
  statusCode: 200,
  responseMs: 10,
  title: "Same title for both pages here",
  titleLength: 30,
  metaDescription: null,
  metaDescriptionLength: 0,
  h1s: [],
  canonical: null,
  robotsMeta: null,
  xRobotsTag: null,
  indexable: true,
  noindexReason: null,
  lang: "fa",
  wordCount: 300,
  imagesTotal: 0,
  imagesMissingAlt: 0,
  imagesWithoutAlt: [],
  links: [],
  internalLinksOut: 0,
  externalLinksOut: 0,
  internalLinksIn: 0,
  inSitemap: true,
  redirectTarget: null,
  redirectChain: [],
  redirectLoop: false,
  textHash: null,
};
