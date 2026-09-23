/**
 * The content editor: Persian/English text handling, the analysis checklist
 * and score, the sanitiser, importing a live page, the content brief, and
 * publishing to WordPress under the approval policy — against real Postgres,
 * a local site, a WordPress REST double and a Search Console double.
 *
 * What must hold: Persian spelling variants (ي/ی, ك/ک, ZWNJ, diacritics) are
 * one keyword; nothing the source did not provide is scored (no Search Console
 * → "na", not a lower score); stored HTML cannot carry script; publishing needs
 * a person with approval rights, writes exactly what was approved, and rolls
 * back only what it wrote.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, competitorSnapshots, competitors, connectors, contentDocuments, db, eq, organizations, projects, purgeOrganization } from "@seo/db";
import { closeQueues, closeRedis, seal } from "@seo/core";
import { contentService, type GscSource } from "@seo/seo-data";
import type { SearchAnalyticsRow } from "@seo/connectors";
import { seedCrawl } from "./site-seed.js";

const { analyzeContent, countPhrase, tokenize, foldText, sanitizeHtml, extractMainContent, serpFit, EMPTY_CONTEXT } = contentService;

// ---------------------------------------------------------------- text

describe("Persian and English text", () => {
  it("folds Arabic letters, diacritics and digits", () => {
    expect(foldText("كتابِ عربي ۱۲۳ ٤٥")).toBe("کتاب عربی 123 45");
    expect(tokenize("  می‌خواهم  کتاب‌ها را!")).toEqual(["می‌خواهم", "کتاب‌ها", "را"]);
  });

  it("matches a phrase however the ZWNJ was typed", () => {
    for (const text of ["من می‌خواهم بخرم", "من میخواهم بخرم", "من می خواهم بخرم", "من مي‌خواهم بخرم"]) {
      expect(countPhrase(tokenize(text), "می‌خواهم", "fa").exact, text).toBe(1);
    }
  });

  it("counts light variants separately from exact matches", () => {
    const fa = countPhrase(tokenize("کفش ورزشی خوب. کفش‌های ورزشی ارزان. كفش ورزشي"), "کفش ورزشی", "fa");
    expect(fa).toEqual({ exact: 2, variants: 3 });
    const en = countPhrase(tokenize("Running shoes and a running shoe; RUNNING SHOES!"), "running shoes", "en");
    expect(en).toEqual({ exact: 2, variants: 3 });
  });

  it("estimates SERP width in pixels and cuts at a word", () => {
    const short = serpFit("Running shoes guide", "title");
    expect(short.truncated).toBe(false);
    expect(short.px).toBeGreaterThan(150);
    const long = serpFit("The complete, independent and very long guide to choosing running shoes for every kind of runner", "title");
    expect(long.truncated).toBe(true);
    expect(long.preview.endsWith(" …")).toBe(true);
    expect(long.preview.length).toBeLessThan(long.chars);
    // Persian letters are measured too (not zero, not Latin widths).
    const fa = serpFit("راهنمای کامل خرید کفش ورزشی برای دویدن در شهر و طبیعت و باشگاه و مسابقه", "title");
    expect(fa.px).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------- sanitiser

describe("sanitiser", () => {
  it("keeps content markup and drops anything executable", () => {
    const out = sanitizeHtml(
      `<h2 onclick="x()">Title</h2><p style="color:red">Hi <a href="javascript:alert(1)">bad</a> <a href="/ok" target="_blank">ok</a></p>` +
        `<script>alert(1)</script><img src="x.png" onerror="alert(1)" alt="A"><iframe src="https://evil.example"></iframe>` +
        `<p><a href="https://example.com/?a=1&b=2">ext</a></p><svg><script>1</script></svg><custom-el>kept text</custom-el>`,
    );
    expect(out).not.toMatch(/script|onclick|onerror|javascript:|iframe|style=|svg/i);
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain('<a>bad</a>');
    expect(out).toContain('<a href="/ok" target="_blank" rel="noopener">ok</a>');
    expect(out).toContain('<img src="x.png" alt="A">');
    expect(out).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(out).toContain("kept text");
  });

  it("extracts the main content of a page", () => {
    const page = extractMainContent(
      `<html lang="fa"><head><title>کفش | فروشگاه</title><meta name="Description" content="توضیح"></head><body>
       <nav><a href="/">خانه</a></nav><article><h1>راهنمای کفش</h1><div class="entry-content"><p>${"متن اصلی مقاله ".repeat(30)}</p>
       <p><a href="/trail">کفش کوه</a><img data-src="/img/a.jpg" alt="کفش"></p></div></article><footer>کپی‌رایت</footer></body></html>`,
      "https://shop.example/blog/shoes",
    );
    expect(page.h1).toBe("راهنمای کفش");
    expect(page.metaTitle).toBe("کفش | فروشگاه");
    expect(page.metaDescription).toBe("توضیح");
    expect(page.lang).toBe("fa");
    expect(page.body).toContain('href="https://shop.example/trail"');
    expect(page.body).toContain('src="https://shop.example/img/a.jpg"');
    expect(page.body).not.toMatch(/کپی‌رایت|خانه/);
  });
});

// ---------------------------------------------------------------- analysis (pure)

const EN_BODY = `<p>Running shoes decide how a run feels. This guide explains how to choose running shoes for road and trail.</p>
<h2>How to choose running shoes</h2><p>Look at cushioning, drop and fit. Try them on in the evening, when feet are larger. A good shop lets you run a few steps.</p>
<h2>Cushioning</h2><p>More cushioning protects on long runs. Less cushioning feels faster and gives more feedback from the ground.</p>
<p>See our <a href="/trail">trail running shoes</a> and the <a href="https://www.runnersworld.com/">independent tests</a>.</p>
<img src="/img/a.jpg"><img src="/img/b.jpg" alt="Road shoe">`;

describe("analysis", () => {
  it("scores keyword placement, structure, links, media and meta", () => {
    const a = analyzeContent(
      { title: "Running shoes: how to choose", metaTitle: "Running shoes guide — how to choose the right pair", metaDescription: "How to choose running shoes: cushioning, drop and fit explained, with the tests that matter before you buy.", body: EN_BODY, targetKeyword: "running shoes", locale: "en", url: "https://shop.example/blog/running-shoes" },
      { ...EMPTY_CONTEXT, siteHosts: ["shop.example"] },
    );
    const check = (id: string) => a.checks.find((c) => c.id === id)!;
    expect(check("keyword_in_meta_title").status).toBe("pass");
    expect(check("keyword_in_title").status).toBe("pass");
    expect(check("keyword_in_first_paragraph").status).toBe("pass");
    expect(check("keyword_in_url").status).toBe("pass");
    expect(check("keyword_in_meta_description").status).toBe("pass");
    expect(check("keyword_in_subheadings").status).toBe("pass");
    expect(check("image_alt").status).toBe("fail"); // one of two images has no alt (50%)
    expect(a.stats.links).toEqual({ internal: 1, external: 1 });
    expect(check("internal_links").status).toBe("pass"); // under 300 words, one link is enough
    // No Search Console: the related-terms check does not count against the score.
    expect(check("related_terms").status).toBe("na");
    expect(a.suggestions.relatedTerms).toBeNull();
    expect(a.readability.fleschReadingEase).not.toBeNull();
    expect(a.score).toBeGreaterThan(60);
    expect(a.score).toBeLessThanOrEqual(100);
    for (const c of a.checks) {
      expect(c.message.fa.length, c.id).toBeGreaterThan(0);
      expect(c.message.en.length, c.id).toBeGreaterThan(0);
      expect(/[A-Za-z]{4,}/.test(c.message.fa.replace(/Search Console|Flesch|H1|H2|H3|URL|meta description|alt|title/gi, "")), `English in fa: ${c.message.fa}`).toBe(false);
    }
  });

  it("flags stuffing, a missing keyword and a wall of text", () => {
    const stuffed = analyzeContent({ title: "shoes", metaTitle: null, metaDescription: null, body: `<p>${"shoes shoes buy shoes. ".repeat(40)}</p>`, targetKeyword: "shoes", locale: "en", url: null }, EMPTY_CONTEXT);
    expect(stuffed.checks.find((c) => c.id === "keyword_density")!.status).toBe("fail");
    const missing = analyzeContent({ title: "About us", metaTitle: null, metaDescription: null, body: "<p>We are a team.</p>", targetKeyword: "running shoes", locale: "en", url: null }, EMPTY_CONTEXT);
    expect(missing.keyword!.variants).toBe(0);
    expect(missing.checks.find((c) => c.id === "keyword_density")!.status).toBe("fail");
    expect(missing.checks.find((c) => c.id === "meta_description_length")!.status).toBe("fail");
  });

  it("measures Persian readability honestly and finds passive sentences", () => {
    const long = `<p>${Array.from({ length: 6 }, () => "این جمله بسیار بلند است و واژه‌های فراوانی دارد که پشت سر هم می‌آیند و خواننده را خسته می‌کنند و هیچ نقطه‌ای ندارد تا نفسی تازه کند و باز هم ادامه پیدا می‌کند.").join(" ")}</p>
<p>این مقاله نوشته شده است. کفش‌ها ساخته می‌شوند. قیمت‌ها اعلام گردید. ما کفش می‌فروشیم.</p>`;
    const a = analyzeContent({ title: "کفش ورزشی", metaTitle: null, metaDescription: null, body: long, targetKeyword: "کفش ورزشی", locale: "fa", url: null }, EMPTY_CONTEXT);
    expect(a.readability.fleschReadingEase).toBeNull();
    expect(a.readability.avgSentenceWords).toBeGreaterThan(20);
    expect(a.checks.find((c) => c.id === "readability")!.status).not.toBe("pass");
    // Two of ten sentences are built on «شدن» after a participle; «اعلام گردید» is a compound verb the heuristic does not count.
    expect(a.readability.passivePct).toBe(20);
  });

  it("uses Search Console queries for related terms and site pages for link suggestions", () => {
    const a = analyzeContent(
      { title: "Running shoes", metaTitle: null, metaDescription: null, body: "<p>Pick running shoes for the road. Trail running shoes grip better on mud.</p>", targetKeyword: "running shoes", locale: "en", url: null },
      {
        benchmark: [{ url: "https://shop.example/a", words: 1000, source: "gsc" }, { url: "https://rival.example/b", words: 1400, source: "competitor", domain: "rival.example" }],
        relatedQueries: [
          { query: "running shoes for flat feet", clicks: 10, impressions: 500 },
          { query: "best running shoes road", clicks: 5, impressions: 300 },
        ],
        relatedScope: "keyword",
        linkTargets: [{ url: "https://shop.example/trail", title: "Trail", phrases: [{ text: "trail running shoes", source: "gsc" }], clicks: 30 }],
        siteHosts: ["shop.example"],
      },
    );
    expect(a.length.benchmarkMedian).toBe(1200);
    expect(a.checks.find((c) => c.id === "content_length")!.status).toBe("fail");
    const terms = a.suggestions.relatedTerms!.map((t) => [t.term, t.present]);
    expect(terms).toContainEqual(["flat", false]);
    expect(terms).toContainEqual(["road", true]);
    expect(a.suggestions.internalLinks).toEqual([{ url: "https://shop.example/trail", title: "Trail", anchor: "trail running shoes", source: "gsc" }]);
  });
});

// ---------------------------------------------------------------- with the database

const stamp = Date.now();
let orgId: string;
let projectId: string;
let site: Server;
let siteUrl: string;
let wp: Server;
let wpUrl: string;
const NOW = new Date("2026-09-20T12:00:00Z");

type WpPost = { id: number; slug: string; link: string; status: string; title: string; content: string; type: "posts" | "pages" };
const wpPosts: WpPost[] = [];
const wpWrites: Array<{ method: string; path: string; body: unknown }> = [];
const WP_AUTH = `Basic ${Buffer.from("editor:app pass word").toString("base64")}`;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

/** Just the WordPress REST routes publishing uses, with WordPress's shapes and auth. */
function startWp(): Promise<void> {
  wp = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== WP_AUTH) return send(401, { code: "incorrect_password", message: "bad" });
    const view = (p: WpPost) => ({ id: p.id, slug: p.slug, link: p.link, status: p.status, title: { raw: p.title, rendered: p.title }, content: { raw: p.content, rendered: p.content } });
    if (url.pathname === "/wp-json/wp/v2/types") return send(200, { post: { rest_base: "posts", rest_namespace: "wp/v2" }, page: { rest_base: "pages", rest_namespace: "wp/v2" }, attachment: { rest_base: "media" } });
    const coll = url.pathname.match(/^\/wp-json\/wp\/v2\/(posts|pages)$/);
    if (coll && req.method === "GET") return send(200, wpPosts.filter((p) => p.type === coll[1] && p.slug === url.searchParams.get("slug")).map(view));
    if (coll && req.method === "POST") {
      const body = (await readJson(req)) as { title: string; content: string; status: string };
      wpWrites.push({ method: "POST", path: url.pathname, body });
      const post: WpPost = { id: 100 + wpPosts.length, slug: "draft", link: `${wpUrl}/?p=${100 + wpPosts.length}`, status: body.status, title: body.title, content: body.content, type: coll[1] as "posts" };
      wpPosts.push(post);
      return send(201, view(post));
    }
    const one = url.pathname.match(/^\/wp-json\/wp\/v2\/(posts|pages)\/(\d+)$/);
    const post = one ? wpPosts.find((p) => p.id === Number(one[2]) && p.type === one[1]) : undefined;
    if (one && !post) return send(404, { code: "rest_post_invalid_id" });
    if (post && req.method === "GET") return send(200, view(post));
    if (post && req.method === "POST") {
      const body = (await readJson(req)) as { title?: string; content?: string };
      wpWrites.push({ method: "POST", path: url.pathname, body });
      if (body.title !== undefined) post.title = body.title;
      if (body.content !== undefined) post.content = body.content;
      return send(200, view(post));
    }
    if (post && req.method === "DELETE") {
      wpWrites.push({ method: "DELETE", path: url.pathname, body: null });
      post.status = "trash";
      return send(200, view(post));
    }
    return send(404, { code: "rest_no_route" });
  });
  return new Promise((r) => wp.listen(0, "127.0.0.1", () => {
    wpUrl = `http://127.0.0.1:${(wp.address() as { port: number }).port}`;
    r();
  }));
}

const gscRows: SearchAnalyticsRow[] = [];
const fakeGsc: GscSource = { query: async () => gscRows };
const deps = () => ({ gsc: fakeGsc, now: () => NOW });

beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url === "/blog/imported") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html lang="en"><head><title>Imported page | Shop</title><meta name="description" content="Imported description"></head><body><nav>menu</nav><main><h1>Imported heading</h1><p>${"Real paragraph text about running shoes. ".repeat(20)}</p><script>alert(1)</script></main></body></html>`);
      return;
    }
    if (req.url === "/moved") {
      res.writeHead(301, { location: "https://elsewhere.example/" });
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  await startWp();
  orgId = (await db.insert(organizations).values({ name: "Content", slug: `content-${stamp}` }).returning())[0]!.id;
  projectId = (await db.insert(projects).values({ orgId, name: "Shop", baseUrl: `${siteUrl}/`, locale: "en" }).returning())[0]!.id;
  await seedCrawl(projectId, [
    { url: `${siteUrl}/`, title: "Shop", h1: ["Shop"], wordCount: 200, depth: 0 },
    { url: `${siteUrl}/blog/running-shoes`, title: "Running shoes guide | Shop", h1: ["Running shoes guide"], wordCount: 1200 },
    { url: `${siteUrl}/trail`, title: "Trail running shoes | Shop", h1: ["Trail running shoes"], wordCount: 800 },
  ]);
  const page = (p: string) => `${siteUrl}${p}`;
  gscRows.push(
    { keys: [page("/blog/running-shoes"), "running shoes"], clicks: 50, impressions: 1000, ctr: 0.05, position: 3 },
    { keys: [page("/blog/running-shoes"), "running shoes for flat feet"], clicks: 5, impressions: 300, ctr: 0.016, position: 8 },
    { keys: [page("/blog/running-shoes"), "how to choose running shoes"], clicks: 4, impressions: 200, ctr: 0.02, position: 6 },
    { keys: [page("/trail"), "trail running shoes"], clicks: 20, impressions: 400, ctr: 0.05, position: 5 },
  );
  const rival = (await db.insert(competitors).values({ projectId, domain: "rival.example" }).returning())[0]!;
  const other = (await db.insert(competitors).values({ projectId, domain: "other.example" }).returning())[0]!;
  const fetchedAt = new Date("2026-09-19T00:00:00Z");
  await db.insert(competitorSnapshots).values([
    { competitorId: rival.id, url: "https://rival.example/running-shoes", fetchedAt, statusCode: 200, title: "Running shoes buying guide", h1: ["Running shoes"], headings: { counts: { h1: 1, h2: 3, h3: 0, h4: 0, h5: 0, h6: 0 }, h2: ["How to choose running shoes", "Cushioning explained", "Price"] }, wordCount: 1600 },
    { competitorId: other.id, url: "https://other.example/guide", fetchedAt, statusCode: 200, title: "Guide to running shoes", h1: ["Guide"], headings: { counts: { h1: 1, h2: 2, h3: 0, h4: 0, h5: 0, h6: 0 }, h2: ["How to choose your running shoes", "Cushioning"] }, wordCount: 1400 },
    { competitorId: other.id, url: "https://other.example/hats", fetchedAt, statusCode: 200, title: "Hats", h1: ["Hats"], headings: { counts: { h1: 1, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 }, h2: [] }, wordCount: 5000 },
  ]);
  const creds = seal(JSON.stringify({ siteUrl: wpUrl, username: "editor", applicationPassword: "app pass word" }));
  await db.insert(connectors).values({ projectId, kind: "WORDPRESS", status: "CONNECTED", secretCipher: creds.cipher, secretIv: creds.iv, secretTag: creds.tag });
});

afterAll(async () => {
  await new Promise<void>((r) => site.close(() => r()));
  await new Promise<void>((r) => wp.close(() => r()));
  await purgeOrganization(orgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

const USER = { type: "USER" as const, id: "u-approver" };

describe("documents", () => {
  let docId: string;

  it("saves sanitised HTML and a score benchmarked on our ranking pages and competitors", async () => {
    const doc = await contentService.createDocument(
      projectId,
      { title: "Running shoes: how to choose", targetKeyword: "running shoes", body: `${EN_BODY}<script>steal()</script>`, metaTitle: "Running shoes guide — choosing the right pair" },
      "u-writer",
      deps(),
    );
    docId = doc.id;
    expect(doc.body).not.toContain("script");
    expect(doc.score).toBe(doc.analysis!.score);
    const sample = doc.analysis!.length.sample.map((s) => [s.source, s.words]);
    // Our two pages ranking for queries with "running shoes" and the two competitor pages about it; not the hats page.
    expect(sample).toEqual(expect.arrayContaining([["gsc", 1200], ["gsc", 800], ["competitor", 1600], ["competitor", 1400]]));
    expect(sample).toHaveLength(4);
    expect(doc.analysis!.length.benchmarkMedian).toBe(1300);
    expect(doc.analysis!.suggestions.relatedTerms!.find((t) => t.term === "flat")?.present).toBe(false);
  });

  it("re-analyses on every edit and lists without bodies", async () => {
    const before = (await contentService.getDocumentView(projectId, docId)).score!;
    const doc = await contentService.updateDocument(projectId, docId, { metaDescription: "How to choose running shoes: cushioning, drop and fit explained, and which tests matter before buying a pair." }, deps());
    expect(doc.score).toBeGreaterThan(before);
    const list = await contentService.listDocuments(projectId);
    expect(list[0]).toMatchObject({ id: docId, score: doc.score, publishStatus: null });
    expect(list[0]).not.toHaveProperty("body");
  });

  it("refuses a URL off the project's site", async () => {
    await expect(contentService.updateDocument(projectId, docId, { url: "https://elsewhere.example/x" }, deps())).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("imports the main content of a page of the site, and nothing from other sites", async () => {
    const doc = await contentService.importFromUrl(projectId, { url: `${siteUrl}/blog/imported`, targetKeyword: "running shoes" }, "u-writer", deps());
    expect(doc).toMatchObject({ title: "Imported heading", metaTitle: "Imported page | Shop", metaDescription: "Imported description", locale: "en", url: `${siteUrl}/blog/imported` });
    expect(doc.body).toContain("Real paragraph text");
    expect(doc.body).not.toMatch(/menu|script|alert/);
    await expect(contentService.importFromUrl(projectId, { url: "https://elsewhere.example/page" }, null, deps())).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(contentService.importFromUrl(projectId, { url: `${siteUrl}/moved` }, null, deps())).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("exports a standalone HTML file", async () => {
    const doc = await contentService.getDocument(projectId, docId);
    const html = contentService.exportHtml(doc);
    expect(html).toMatch(/^<!doctype html>\n<html lang="en" dir="ltr">/);
    expect(html).toContain("<title>Running shoes guide — choosing the right pair</title>");
    expect(html).toContain("<h1>Running shoes: how to choose</h1>");
  });
});

describe("content brief", () => {
  it("is built from Search Console and competitor outlines only", async () => {
    const brief = await contentService.contentBrief(projectId, { keyword: "running shoes", locale: "en" }, deps());
    expect(brief.sources).toEqual({ gsc: true, competitorPages: 2, crawl: true });
    expect(brief.queries.map((q) => q.query)).toEqual(["running shoes", "trail running shoes", "running shoes for flat feet", "how to choose running shoes"]);
    expect(brief.questions).toEqual(["how to choose running shoes"]);
    // "How to choose (your) running shoes" appears on both competitor sites: one heading, two sites.
    expect(brief.outline[0]).toEqual({ heading: "How to choose running shoes", sites: 2, source: "competitors" });
    expect(brief.outline.find((o) => o.source === "gsc_question")?.heading).toBe("how to choose running shoes");
    expect(brief.targets.words).toBe(1300); // median of 800, 1200, 1400, 1600
    expect(brief.targets.wordsSource).toBe("our_pages_and_competitors");
  });

  it("says so when Search Console is not connected", async () => {
    const brief = await contentService.contentBrief(projectId, { keyword: "running shoes", locale: "en" }, { gsc: { query: async () => null }, now: () => NOW });
    expect(brief.sources.gsc).toBe(false);
    expect(brief.queries).toEqual([]);
    expect(brief.period).toBeNull();
  });
});

describe("publishing to WordPress", () => {
  let docId: string;

  beforeAll(async () => {
    wpPosts.push({ id: 5, slug: "running-shoes", link: `${siteUrl}/blog/running-shoes/`, status: "publish", title: "Old title", content: "<p>Old content</p>", type: "pages" });
    const doc = await contentService.createDocument(projectId, { title: "Running shoes, rewritten", body: "<p>New content about running shoes.</p>", url: `${siteUrl}/blog/running-shoes` }, "u-writer", deps());
    docId = doc.id;
  });

  it("a request writes nothing; an API key or agent cannot approve it", async () => {
    const state = await contentService.requestPublish(projectId, docId, { mode: "update" }, { type: "USER", id: "u-writer" });
    expect(state).toMatchObject({ status: "pending", mode: "update", post: { id: 5, restBase: "pages" } });
    expect(wpWrites).toHaveLength(0);
    await expect(contentService.decidePublish(projectId, docId, { approve: true }, { type: "API_KEY", id: "k1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(contentService.decidePublish(projectId, docId, { approve: true }, { type: "AGENT", id: "agent" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(wpWrites).toHaveLength(0);
  });

  it("an edit after the request voids it", async () => {
    await contentService.updateDocument(projectId, docId, { body: "<p>Changed after asking.</p>" }, deps());
    await expect(contentService.decidePublish(projectId, docId, { approve: true }, USER)).rejects.toMatchObject({ details: { reason: "document_changed" } });
    expect(wpWrites).toHaveLength(0);
  });

  it("approval writes exactly the approved text, and rollback restores the post", async () => {
    await contentService.requestPublish(projectId, docId, { mode: "update" }, { type: "USER", id: "u-writer" });
    const published = await contentService.decidePublish(projectId, docId, { approve: true }, USER);
    expect(published).toMatchObject({ status: "published", decidedBy: "u-approver", previous: { title: "Old title", content: "<p>Old content</p>" } });
    expect(wpPosts.find((p) => p.id === 5)).toMatchObject({ title: "Running shoes, rewritten", content: "<p>Changed after asking.</p>" });
    // A second approval of the same request finds nothing pending.
    await expect(contentService.decidePublish(projectId, docId, { approve: true }, USER)).rejects.toMatchObject({ code: "CONFLICT" });

    const rolled = await contentService.rollbackPublish(projectId, docId);
    expect(rolled.status).toBe("rolled_back");
    expect(wpPosts.find((p) => p.id === 5)).toMatchObject({ title: "Old title", content: "<p>Old content</p>" });
  });

  it("rollback refuses when the post was edited in WordPress since", async () => {
    await contentService.requestPublish(projectId, docId, { mode: "update" }, { type: "USER", id: "u-writer" });
    await contentService.decidePublish(projectId, docId, { approve: true }, USER);
    wpPosts.find((p) => p.id === 5)!.content = "<p>Edited by a person in wp-admin</p>";
    await expect(contentService.rollbackPublish(projectId, docId)).rejects.toMatchObject({ details: { reason: "changed_since_publish" } });
    expect(wpPosts.find((p) => p.id === 5)!.content).toBe("<p>Edited by a person in wp-admin</p>");
  });

  it("a draft is a new WordPress draft; rejecting writes nothing", async () => {
    const doc = await contentService.createDocument(projectId, { title: "Brand new article", body: "<p>Draft body</p>" }, null, deps());
    await contentService.requestPublish(projectId, doc.id, { mode: "draft", postType: "posts" }, { type: "USER", id: "u-writer" });
    const writes = wpWrites.length;
    const rejected = await contentService.decidePublish(projectId, doc.id, { approve: false, reason: "not yet" }, USER);
    expect(rejected).toMatchObject({ status: "rejected", reason: "not yet" });
    expect(wpWrites).toHaveLength(writes);

    await contentService.requestPublish(projectId, doc.id, { mode: "draft", postType: "posts" }, { type: "USER", id: "u-writer" });
    const done = await contentService.decidePublish(projectId, doc.id, { approve: true }, USER);
    expect(done.status).toBe("published");
    const created = wpPosts.find((p) => p.id === done.post!.id)!;
    expect(created).toMatchObject({ status: "draft", title: "Brand new article", content: "<p>Draft body</p>", type: "posts" });
    expect((await contentService.rollbackPublish(projectId, doc.id)).status).toBe("rolled_back");
    expect(created.status).toBe("trash");
  });

  it("without a WordPress connection nothing can be requested", async () => {
    await db.update(connectors).set({ status: "ERROR" }).where(eq(connectors.projectId, projectId));
    try {
      await expect(contentService.requestPublish(projectId, docId, { mode: "update" }, USER)).rejects.toMatchObject({ code: "CONNECTOR_NOT_CONNECTED" });
    } finally {
      await db.update(connectors).set({ status: "CONNECTED" }).where(eq(connectors.projectId, projectId));
    }
  });

  it("a document from another project is not found", async () => {
    const other = (await db.insert(projects).values({ orgId, name: "Other", baseUrl: "https://other.example/" }).returning())[0]!.id;
    await expect(contentService.getDocument(other, docId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [row] = await db.select({ publish: contentDocuments.publish }).from(contentDocuments).where(eq(contentDocuments.id, docId));
    expect(row!.publish?.status).toBe("published");
  });
});
