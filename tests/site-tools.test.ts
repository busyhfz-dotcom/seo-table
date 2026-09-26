/**
 * Schema markup, internal linking, robots.txt and sitemap tools, against a
 * seeded scan, a Search Console double and a local site serving robots.txt
 * and sitemaps.
 *
 * What must hold: validation follows Google's documented required/recommended
 * properties and says when a feature is retired; nothing is prefilled that the
 * page did not show; link equity is a proper PageRank; the robots explanation
 * always agrees with the crawler's own parser; a generated sitemap lists only
 * 200, indexable, self-canonical pages and splits at 50,000; sitemap problems
 * are reported against what the scan saw; no proposal is created that the
 * write target could not apply.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, organizations, projects, purgeOrganization } from "@seo/db";
import { closeQueues, closeRedis, isAllowed, parseRobots } from "@seo/core";
import { diffLines, internalLinks, robotsService, schemaMarkup, sitemapService, type GscSource } from "@seo/seo-data";
import type { SearchAnalyticsRow } from "@seo/connectors";
import { seedCrawl } from "./site-seed.js";

const USER = { type: "USER" as const, id: "u1" };
const codes = (issues: Array<{ code: string; path?: string; level: string }>) => issues.map((i) => `${i.level}:${i.code}${i.path ? `:${i.path}` : ""}`);

// ---------------------------------------------------------------- schema (pure)

describe("schema validation", () => {
  const ctx = { "@context": "https://schema.org" };

  it("Product needs a name and one of offers, review or aggregateRating", () => {
    expect(codes(schemaMarkup.validateNode({ ...ctx, "@type": "Product" }))).toEqual(
      expect.arrayContaining(["error:missing_required:name", "error:missing_required:offers|review|aggregateRating"]),
    );
    const withOffer = schemaMarkup.validateNode({ ...ctx, "@type": "Product", name: "Shoe", offers: { "@type": "Offer", price: "1,200 تومان" } });
    expect(codes(withOffer)).toEqual(expect.arrayContaining(["error:invalid_number:offers.price", "warning:missing_recommended:offers.priceCurrency"]));
    const ok = schemaMarkup.validateNode({ ...ctx, "@type": "Product", name: "Shoe", image: ["https://s.example/a.jpg"], description: "d", sku: "1", brand: { "@type": "Brand", name: "B" }, offers: { "@type": "Offer", price: 12, priceCurrency: "USD", availability: "https://schema.org/InStock" } });
    expect(ok.filter((i) => i.level !== "info")).toEqual([]);
    const rated = schemaMarkup.validateNode({ ...ctx, "@type": "Product", name: "Shoe", aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5 } });
    expect(codes(rated)).toEqual(expect.arrayContaining(["error:missing_required:aggregateRating.ratingCount", "info:ratings_must_be_real:aggregateRating"]));
  });

  it("knows which features Google retired or restricted", () => {
    expect(codes(schemaMarkup.validateNode({ ...ctx, "@type": "HowTo", name: "x", step: [{ "@type": "HowToStep", text: "a" }] }))).toContain("warning:howto_deprecated:@type");
    expect(codes(schemaMarkup.validateNode({ ...ctx, "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A" } }] }))).toEqual(["warning:faq_limited:@type"]);
    expect(codes(schemaMarkup.validateNode({ ...ctx, "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?" }] }))).toContain("error:missing_required:mainEntity.acceptedAnswer");
    const site = schemaMarkup.validateNode(schemaMarkup.buildJsonLd("WebSite", { name: "Shop", url: "https://s.example/", searchUrlTemplate: "https://s.example/?s={search_term_string}" }));
    expect(codes(site)).toContain("info:sitelinks_searchbox_retired:potentialAction");
    expect(codes(schemaMarkup.validateNode({ ...ctx, "@type": "Person", name: "A" }))).toContain("info:person_no_rich_result:@type");
  });

  it("checks events, breadcrumbs, local businesses and articles", () => {
    const ev = schemaMarkup.buildJsonLd("Event", { name: "Meetup", startDate: "2026-10-01T18:00", attendanceMode: "online", location: { url: "" } });
    expect(codes(schemaMarkup.validateNode(ev))).toEqual(expect.arrayContaining(["error:missing_required:location", "warning:date_without_timezone:startDate"]));
    const ev2 = schemaMarkup.buildJsonLd("Event", { name: "Meetup", startDate: "2026-10-01T18:00+03:30", location: { name: "Hall" } });
    expect(codes(schemaMarkup.validateNode(ev2))).toContain("error:missing_required:location.address");
    const crumbs = schemaMarkup.validateNode({ ...ctx, "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home" }, { "@type": "ListItem", position: 2, name: "Shoes" }] });
    expect(codes(crumbs)).toContain("error:missing_required:itemListElement[0].item");
    const shop = schemaMarkup.buildJsonLd("LocalBusiness", { businessType: "ShoeStore", name: "Shop", address: { addressLocality: "Tehran", addressCountry: "IR" }, geo: { latitude: "35.7", longitude: 51.4 } });
    expect(shop["@type"]).toBe("ShoeStore");
    expect(codes(schemaMarkup.validateNode(shop))).toEqual(expect.arrayContaining(["warning:geo_precision:geo.latitude", "warning:missing_recommended:address.streetAddress"]));
    const art = schemaMarkup.validateNode({ ...ctx, "@type": "BlogPosting", headline: "x".repeat(120), datePublished: "yesterday", author: { "@type": "Person", name: "A" } });
    expect(codes(art)).toEqual(expect.arrayContaining(["warning:headline_long:headline", "error:invalid_date:datePublished", "warning:missing_recommended:author.url"]));
    expect(codes(schemaMarkup.validateNode({ "@type": "Organization", name: "x", url: "not a url" }))).toEqual(expect.arrayContaining(["error:bad_context:@context", "error:invalid_url:url"]));
  });

  it("builds markup without empty fields and never invents values", () => {
    const p = schemaMarkup.buildJsonLd("Product", { name: " Shoe ", description: "", image: [], offers: { price: "", priceCurrency: null } });
    expect(p).toEqual({ "@context": "https://schema.org", "@type": "Product", name: "Shoe" });
    expect(schemaMarkup.validateJsonLd({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "A" }, { "@type": "WebSite", name: "A", url: "https://a.example/" }] }).map((r) => r.type)).toEqual(["Organization", "WebSite"]);
    for (const issue of schemaMarkup.validateNode({ "@type": "Event" })) {
      expect(issue.message.fa).toMatch(/[\u0600-ۿ]/);
      expect(issue.message.en).toMatch(/[A-Za-z]/);
    }
  });

  it("reports conflicts with the page's own markup", () => {
    const existing = [{ "@type": "Organization", name: "Shop Ltd", url: "https://s.example/" }];
    const conflicts = schemaMarkup.conflictsWith(existing, { "@type": "Organization", name: "Shop", url: "https://s.example/" });
    expect(conflicts.map((c) => `${c.code}:${c.property ?? ""}`)).toEqual(["duplicate_type:", "value_differs:name"]);
    expect(schemaMarkup.conflictsWith(existing, { "@type": "WebSite", name: "Shop" })).toEqual([]);
  });
});

// ---------------------------------------------------------------- PageRank

describe("PageRank", () => {
  it("is a probability distribution that rewards being linked", () => {
    const edges = new Map([
      ["a", new Set(["b", "c"])],
      ["b", new Set(["c"])],
      ["c", new Set(["a"])],
      ["d", new Set(["c"])],
    ]);
    const pr = internalLinks.pageRank({ nodes: ["a", "b", "c", "d"], edges });
    const sum = [...pr.rank.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(pr.score.get("c")).toBe(100);
    expect(pr.rank.get("d")).toBeCloseTo(0.15 / 4, 9); // nothing links to d
    expect(pr.rank.get("c")!).toBeGreaterThan(pr.rank.get("a")!);
  });

  it("spreads a dangling page's rank evenly, and treats a cycle symmetrically", () => {
    const cycle = internalLinks.pageRank({ nodes: ["x", "y", "z"], edges: new Map([["x", new Set(["y"])], ["y", new Set(["z"])], ["z", new Set(["x"])]]) });
    for (const v of cycle.rank.values()) expect(v).toBeCloseTo(1 / 3, 9);
    const dangling = internalLinks.pageRank({ nodes: ["x", "y"], edges: new Map([["x", new Set(["y"])]]) });
    expect([...dangling.rank.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------- robots (pure)

describe("robots.txt tools", () => {
  const file = `# comment
User-agent: *
Disallow: /private/
Allow: /private/open
Disallow: /*.pdf$

User-agent: Googlebot
User-agent: Bingbot
Disallow: /no-google/
Allow: /

Sitemap: https://s.example/sitemap.xml
`;

  it("explains every verdict with the rule that decided, agreeing with the crawler's parser", () => {
    const robots = parseRobots(file);
    const urls = ["/", "/private/x", "/private/open", "/private/opener", "/doc.pdf", "/doc.pdf?x=1", "/no-google/a", "/کفش/", "/%D8%A7"].map((p) => `https://s.example${p}`);
    for (const ua of ["Googlebot/2.1", "bingbot", "SeoTableBot/0.4", "*"]) {
      for (const url of urls) {
        const v = robotsService.explain(file, url, ua);
        expect(v.allowed, `${ua} ${url}`).toBe(isAllowed(robots, url, ua));
        if (v.rule) expect(v.rule.allow).toBe(v.allowed);
      }
    }
    expect(robotsService.explain(file, "https://s.example/private/open", "SeoTableBot")).toMatchObject({ allowed: true, group: "*", rule: { pattern: "/private/open", line: 4, allow: true } });
    expect(robotsService.explain(file, "https://s.example/no-google/a", "Googlebot")).toMatchObject({ allowed: false, group: "googlebot", rule: { line: 9 } });
    expect(robotsService.explain("", "https://s.example/a", "Googlebot")).toMatchObject({ allowed: true, group: null, rule: null });
  });

  it("validates directives with line numbers and warns about site-wide blocks", () => {
    const issues = robotsService.validateRobots("Disallow: /early\nUser-agent: *\nDisallow: /\nNoindex: /x\nCrawl-delay: 5\nSitemap: /sitemap.xml\nFoo: bar\nbroken line\n", "https://s.example/");
    expect(issues.map((i) => `${i.line}:${i.code}`)).toEqual(
      expect.arrayContaining(["1:rule_before_agent", "4:noindex_unsupported", "5:crawl_delay_ignored", "6:sitemap_not_absolute", "7:unknown_directive", "8:no_colon", "null:blocks_site"]),
    );
    expect(robotsService.validateRobots(robotsService.defaultRobots("https://s.example/"), "https://s.example/").filter((i) => i.level !== "info")).toEqual([]);
    expect(robotsService.validateRobots("User-agent: *\nDisallow: /x\n", "https://s.example/").map((i) => i.code)).toEqual(["no_sitemap_line"]);
  });

  it("diffs line by line", () => {
    expect(diffLines("a\nb\nc\n", "a\nc\nd\n")).toEqual([
      { op: "=", line: "a", oldNo: 1, newNo: 1 },
      { op: "-", line: "b", oldNo: 2, newNo: null },
      { op: "=", line: "c", oldNo: 3, newNo: 2 },
      { op: "+", line: "d", oldNo: null, newNo: 3 },
    ]);
  });
});

// ---------------------------------------------------------------- sitemap (pure)

describe("sitemap files", () => {
  it("writes lastmod and images only when known, escaped", () => {
    const { files, withLastmod, images } = sitemapService.buildSitemapFiles(
      [
        { normalizedUrl: "https://s.example/a?x=1&y=2", details: { links: [], headings: [], jsonLd: [], images: [{ src: "https://cdn.example/i.jpg", alt: null }], lastModified: new Date("2026-09-01T10:00:00Z") } },
        { normalizedUrl: "https://s.example/b", details: null },
      ],
      "https://s.example",
      true,
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("/sitemap.xml");
    expect(files[0]!.body).toContain("<url><loc>https://s.example/a?x=1&amp;y=2</loc><lastmod>2026-09-01T10:00:00.000Z</lastmod><image:image><image:loc>https://cdn.example/i.jpg</image:loc></image:image></url>");
    expect(files[0]!.body).toContain("<url><loc>https://s.example/b</loc></url>");
    expect(files[0]!.body).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect({ withLastmod, images }).toEqual({ withLastmod: 1, images: 1 });
  });

  it("splits past 50,000 URLs behind a sitemap index", () => {
    const pages = Array.from({ length: 50_001 }, (_, i) => ({ normalizedUrl: `https://s.example/p/${i}`, details: null }));
    const { files } = sitemapService.buildSitemapFiles(pages, "https://s.example", false);
    expect(files.map((f) => [f.path, f.urls])).toEqual([["/sitemap.xml", 0], ["/sitemap-1.xml", 50_000], ["/sitemap-2.xml", 1]]);
    expect(files[0]!.body).toContain("<sitemapindex");
    expect(files[0]!.body).toContain("<loc>https://s.example/sitemap-2.xml</loc>");
  });
});

// ---------------------------------------------------------------- with the database

const stamp = Date.now();
const NOW = new Date("2026-09-20T12:00:00Z");
let orgId: string;
let projectId: string;
let site: Server;
let S: string;
let robotsBody = "User-agent: *\nDisallow: /cart/\n";
const gscRows: SearchAnalyticsRow[] = [];
const deps = () => ({ gsc: { query: async () => gscRows } as GscSource, now: () => NOW });

beforeAll(async () => {
  site = createServer((req, res) => {
    const xml = (body: string) => res.writeHead(200, { "content-type": "application/xml" }).end(body);
    switch (req.url) {
      case "/robots.txt":
        if (!robotsBody) return res.writeHead(404).end();
        return res.writeHead(200, { "content-type": "text/plain" }).end(`${robotsBody}Sitemap: ${S}/sitemap_index.xml\n`);
      case "/sitemap_index.xml":
        return xml(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${S}/post-sitemap.xml</loc></sitemap><sitemap><loc>${S}/missing-sitemap.xml</loc></sitemap></sitemapindex>`);
      case "/post-sitemap.xml":
        return xml(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${S}/</loc><lastmod>2026-09-01</lastmod></url>
<url><loc>${S}/shoes/running</loc><lastmod>last week</lastmod></url>
<url><loc>${S}/old</loc></url><url><loc>${S}/hidden</loc></url><url><loc>${S}/dupe</loc></url><url><loc>${S}/gone</loc></url>
<url><loc>${S}/never-crawled</loc></url><url><loc>https://elsewhere.example/x</loc></url><url><loc>${S}/</loc></url></urlset>`);
      default:
        return res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  S = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  orgId = (await db.insert(organizations).values({ name: "Site tools", slug: `tools-${stamp}` }).returning())[0]!.id;
  projectId = (await db.insert(projects).values({ orgId, name: "Shoe shop", baseUrl: `${S}/`, locale: "en" }).returning())[0]!.id;
  await seedCrawl(projectId, [
    {
      url: `${S}/`, title: "Shoe shop", h1: ["Shoe shop"], depth: 0,
      links: [[`${S}/shoes`, "Shoes"], [`${S}/shoes/running`, "Running"], [`${S}/old`, "Old page"], [`${S}/about`, "About", true]],
      jsonLd: [{ "@context": "https://schema.org", "@type": "Organization", name: "Shoe shop Ltd", url: `${S}/` }],
      images: [{ src: `${S}/img/logo.png`, alt: "logo" }],
    },
    { url: `${S}/shoes`, title: "Shoes | Shoe shop", h1: ["Shoes"], links: [[`${S}/shoes/running`, "Running shoes"], [`${S}/`, "Home"]], headings: [{ l: 1, t: "Shoes" }, { l: 2, t: "Running shoes" }, { l: 2, t: "Trail shoes" }] },
    {
      url: `${S}/shoes/running`, title: "Running shoes | Shoe shop", h1: ["Running shoes"], links: [[`${S}/`, "Home"]],
      headings: [{ l: 1, t: "Running shoes" }, { l: 2, t: "How do running shoes fit?" }, { l: 2, t: "Care" }, { l: 3, t: "Can I wash them?" }],
      images: [{ src: `${S}/img/run.jpg`, alt: null }], lastModified: new Date("2026-09-10T08:00:00Z"), metaDescription: "Running shoes for road and trail.",
    },
    { url: `${S}/shoes/trail-running`, title: "Trail running shoes | Shoe shop", h1: ["Trail running shoes"], depth: null, headings: [{ l: 1, t: "Trail running shoes" }, { l: 2, t: "Running on trails" }] },
    { url: `${S}/about`, title: "About | Shoe shop", h1: ["About"], links: [[`${S}/`, "Home"]] },
    { url: `${S}/old`, status: 301, redirectTarget: `${S}/shoes` },
    { url: `${S}/hidden`, title: "Hidden", indexable: false, noindexReason: "meta_noindex" },
    { url: `${S}/dupe`, title: "Dupe", canonical: `${S}/shoes`, indexable: false, noindexReason: "canonicalised_elsewhere" },
    { url: `${S}/gone`, status: 404, indexable: false },
    { url: `${S}/cart/view`, title: "Cart", indexable: false, noindexReason: "robots_txt_disallow" },
  ]);
  gscRows.push(
    { keys: [`${S}/shoes/trail-running`, "trail running shoes"], clicks: 40, impressions: 900, ctr: 0.04, position: 6 },
    { keys: [`${S}/shoes/running`, "running shoes"], clicks: 90, impressions: 2000, ctr: 0.045, position: 4 },
    { keys: [`${S}/about`, "shoe shop about"], clicks: 2, impressions: 20, ctr: 0.1, position: 1 },
  );
});

afterAll(async () => {
  await new Promise<void>((r) => site.close(() => r()));
  await purgeOrganization(orgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("internal links", () => {
  it("finds orphans, weak important pages and relevant sources with real anchors", async () => {
    const r = await internalLinks.siteLinks(projectId, { baseUrl: `${S}/`, locale: "en" }, deps());
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.importance).toBe("gsc");
    // The 301 to /shoes is credited to /shoes; the nofollow link to /about is not an edge.
    const page = (p: string) => r.pages.find((x) => x.url === `${S}${p}`)!;
    expect(page("/shoes").inlinks).toBe(1);
    expect(page("/about").inlinks).toBe(0);
    expect(r.totals.nofollowLinks).toBe(1);
    expect(r.orphans.map((o) => o.url).sort()).toEqual([`${S}/about`, `${S}/shoes/trail-running`]);
    // /shoes/running has 90 clicks but only two linking pages.
    expect(r.weak.map((w) => w.url)).toContain(`${S}/shoes/running`);
    const trail = r.suggestions.find((s) => s.target.url === `${S}/shoes/trail-running`)!;
    expect(trail.reason).toBe("orphan");
    expect([`${S}/shoes`, `${S}/shoes/running`]).toContain(trail.source.url);
    expect(trail.anchors[0]).toEqual({ text: "trail running shoes", source: "gsc" });
    expect(r.inlinkHistogram.find((b) => b.bucket === "0")!.pages).toBeGreaterThanOrEqual(2);
    const sum = r.pages.reduce((s, p) => s + p.equity, 0);
    expect(sum).toBeGreaterThan(0);
  });

  it("reports one page's links in both directions", async () => {
    const r = await internalLinks.pageLinks(projectId, { baseUrl: `${S}/`, locale: "en" }, `${S}/shoes/running`, deps());
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.inbound.map((i) => [i.url, i.anchors])).toEqual(expect.arrayContaining([[`${S}/`, ["Running"]], [`${S}/shoes`, ["Running shoes"]]]));
    expect(r.outbound.map((o) => o.url)).toEqual([`${S}/`]);
    expect(r.linkTo.map((s) => s.target.url)).toContain(`${S}/shoes/trail-running`);
  });

  it("says a rescan is needed for a scan without the link graph", async () => {
    const other = (await db.insert(projects).values({ orgId, name: "Old scan", baseUrl: "https://old.example/" }).returning())[0]!.id;
    expect(await internalLinks.siteLinks(other, { baseUrl: "https://old.example/", locale: "fa" }, deps())).toEqual({ status: "no_scan" });
    await seedCrawl(other, [{ url: "https://old.example/" }], { details: false });
    expect(await internalLinks.siteLinks(other, { baseUrl: "https://old.example/", locale: "fa" }, deps())).toEqual({ status: "needs_rescan" });
  });
});

describe("schema on the site", () => {
  it("reads the page's own markup and prefills only what the page shows", async () => {
    const existing = await schemaMarkup.existingSchema(projectId, `${S}/`);
    if (existing.status !== "ok") throw new Error(existing.status);
    expect(existing.nodes.map((n) => n.type)).toEqual(["Organization"]);

    const org = await schemaMarkup.prefill(projectId, "Organization", `${S}/`);
    expect(org.data).toMatchObject({ name: "Shoe shop Ltd", url: `${S}/` });
    expect(org.from).toEqual(["crawl", "page_markup"]);

    const article = await schemaMarkup.prefill(projectId, "Article", `${S}/shoes/running`);
    expect(article.data).toMatchObject({ headline: "Running shoes", description: "Running shoes for road and trail.", image: [`${S}/img/run.jpg`], dateModified: "2026-09-10T08:00:00.000Z", datePublished: null });

    const crumbs = await schemaMarkup.prefill(projectId, "BreadcrumbList", `${S}/shoes/running`);
    expect(crumbs.data).toEqual({ items: [{ name: "Shoe shop", url: `${S}/` }, { name: "Shoes", url: `${S}/shoes` }, { name: "Running shoes", url: `${S}/shoes/running` }] });

    const faq = await schemaMarkup.prefill(projectId, "FAQPage", `${S}/shoes/running`);
    expect(faq.data).toEqual({ items: [{ question: "How do running shoes fit?", answer: "" }, { question: "Can I wash them?", answer: "" }] });

    const product = await schemaMarkup.prefill(projectId, "Product", `${S}/shoes/running`);
    expect(product.data).not.toHaveProperty("offers");
    expect(product.data).not.toHaveProperty("aggregateRating");
  });

  it("previews with conflicts, and refuses to propose without a write target", async () => {
    const preview = await schemaMarkup.preview(projectId, { type: "Organization", data: { name: "Shoe shop", url: `${S}/` }, url: `${S}/` });
    expect(preview.conflicts.map((c) => c.code)).toEqual(["duplicate_type", "value_differs"]);
    await expect(schemaMarkup.proposeSchema({ projectId, orgId, actor: USER, url: `${S}/shoes/running`, jsonld: preview.jsonld })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "not_connected", manual: true },
    });
    await expect(schemaMarkup.proposeSchema({ projectId, orgId, actor: USER, url: `${S}/`, jsonld: { "@context": "https://schema.org", "@type": "Product" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("sitemaps on the site", () => {
  it("generates from indexable, self-canonical 200 pages and says what it left out", async () => {
    const s = await sitemapService.generateSitemap(projectId, { images: true });
    expect(s.status).toBe("ok");
    const body = s.files[0]!.body;
    for (const p of ["/", "/shoes", "/shoes/running", "/shoes/trail-running", "/about"]) expect(body).toContain(`<loc>${S}${p}</loc>`);
    for (const p of ["/old", "/hidden", "/dupe", "/gone", "/cart/view"]) expect(body).not.toContain(`<loc>${S}${p}</loc>`);
    expect(s.excluded).toEqual({ redirect: 1, noindex: 1, not_canonical: 1, not_200: 1, blocked_by_robots: 1 });
    expect(s.urls).toBe(5);
    expect(body.indexOf(`${S}/</loc>`)).toBeLessThan(body.indexOf(`${S}/shoes</loc>`));
  });

  it("validates the site's sitemaps (found through robots.txt) against the scan", async () => {
    const v = await sitemapService.validateSitemaps(projectId);
    expect(v.sources.map((s) => [s.url.replace(S, ""), s.kind])).toEqual([
      ["/sitemap_index.xml", "index"],
      ["/post-sitemap.xml", "urlset"],
      ["/missing-sitemap.xml", "unreachable"],
    ]);
    expect(v.problems).toEqual({ not_200: 1, redirect: 1, noindex: 1, not_canonical: 1, blocked_by_robots: 0, other_host: 1, not_crawled: 1 });
    expect(v.examples.find((e) => e.problem === "redirect")).toMatchObject({ url: `${S}/old`, status: 301, detail: `${S}/shoes` });
    expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["bad_lastmod", "duplicate_urls"]));
  });
});

describe("robots.txt on the site", () => {
  it("reviews an edit against the pages that matter", async () => {
    const review = await robotsService.reviewRobots(projectId, "User-agent: *\nDisallow: /cart/\nDisallow: /shoes/\n", deps());
    expect(review.current.state).toBe("ok");
    expect(review.newlyBlocked.map((b) => b.url).sort()).toEqual([`${S}/shoes/running`, `${S}/shoes/trail-running`]);
    expect(review.newlyBlocked[0]).toMatchObject({ url: `${S}/shoes/running`, clicks: 90, rule: { pattern: "/shoes/", line: 3 } });
    expect(review.diff.filter((d) => d.op !== "=").map((d) => `${d.op}${d.line}`)).toEqual([`-Sitemap: ${S}/sitemap_index.xml`, "+Disallow: /shoes/"]);
  });

  it("refuses to propose a file with errors, or one the write target cannot serve", async () => {
    await expect(robotsService.proposeRobots({ projectId, orgId, actor: USER, content: "Disallow: /x\n" }, deps())).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(robotsService.proposeRobots({ projectId, orgId, actor: USER, content: "User-agent: *\nDisallow:\n" }, deps())).rejects.toMatchObject({ code: "CONFLICT", details: { manual: true } });
  });

  it("reads a missing or unreachable robots.txt honestly", async () => {
    const saved = robotsBody;
    try {
      robotsBody = "";
      expect(await robotsService.liveRobots(projectId)).toMatchObject({ state: "missing", status: 404, body: "" });
    } finally {
      robotsBody = saved;
    }
    // robots.txt lives at the origin root whatever the base path is.
    const deeper = (await db.insert(projects).values({ orgId, name: "Sub", baseUrl: `${S}/blog/` }).returning())[0]!.id;
    expect((await robotsService.liveRobots(deeper)).url).toBe(`${S}/robots.txt`);
    const dead = (await db.insert(projects).values({ orgId, name: "Dead", baseUrl: "http://127.0.0.1:1/" }).returning())[0]!.id;
    expect(await robotsService.liveRobots(dead)).toMatchObject({ state: "unreachable", status: null });
  });
});
