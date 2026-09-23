/**
 * SEO data services end to end, against real PostgreSQL and Redis and HTTP
 * doubles for every third party (DataForSEO, PageSpeed, Telegram, Suggest, a
 * webhook receiver) plus a fake Search Console source with real-shaped rows.
 *
 * What must hold: nothing is shown without a source (configured:false), sealed
 * credentials never surface, syncs are idempotent and never pay twice a day,
 * alerts fire once per event and deliver signed, schedules dispatch exactly
 * once across concurrent schedulers.
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  auditRuns,
  closeDb,
  competitors,
  db,
  eq,
  keywordIdeas,
  keywordPositions,
  keywords,
  notifications,
  orgIntegrations,
  organizations,
  pageSnapshots,
  projects,
  providerUsage,
  purgeOrganization,
  schedules,
  seoIssues,
  sql,
} from "@seo/db";
import { auditQueue, closeQueues, closeRedis, dataQueue, enqueueRankSync } from "@seo/core";
import {
  alertService,
  competitorService,
  dataForSeo,
  discovery,
  dispatchSchedule,
  googleSuggest,
  integrations,
  keywordService,
  notificationService,
  pageSpeedInsights,
  pagespeedService,
  rankService,
  runPageSpeedJob,
  runRankJob,
  samplePages,
  scheduleService,
  telegram,
  type Deps,
  type GscSource,
} from "@seo/seo-data";
import type { SearchAnalyticsRequest, SearchAnalyticsRow } from "@seo/connectors";
import { fakeDataForSeo, fakePageSpeed, fakeSuggest, fakeTelegram, fakeWebhook } from "./fake-seo-apis.js";

const stamp = Date.now();
const NOW = new Date("2026-09-20T12:00:00Z");
let orgId: string;
let otherOrgId: string;
let projectId: string;

type F = {
  dfs: Awaited<ReturnType<typeof fakeDataForSeo>>;
  psi: Awaited<ReturnType<typeof fakePageSpeed>>;
  tg: Awaited<ReturnType<typeof fakeTelegram>>;
  suggest: Awaited<ReturnType<typeof fakeSuggest>>;
  hook: Awaited<ReturnType<typeof fakeWebhook>>;
};
const f = {} as F;

/** Search Console double: records every request, answers with `respond`. */
const gscCalls: SearchAnalyticsRequest[] = [];
let respond: (req: SearchAnalyticsRequest) => SearchAnalyticsRow[] | null = () => null;
const fakeGsc: GscSource = {
  async query(_projectId, req) {
    gscCalls.push(req);
    return respond(req);
  },
};

function deps(extra: Partial<Deps> = {}): Partial<Deps> {
  return {
    gsc: fakeGsc,
    suggest: googleSuggest({ baseUrl: f.suggest.url }),
    dataForSeo: (c) => dataForSeo(c, { baseUrl: f.dfs.url }),
    pageSpeed: ({ apiKey }) => pageSpeedInsights({ apiKey, baseUrl: f.psi.url, retryDelaysMs: [5, 5, 5] }),
    telegram: (c) => telegram(c, { baseUrl: f.tg.url }),
    now: () => NOW,
    ...extra,
  };
}

async function newProject(values: Partial<typeof projects.$inferInsert> = {}): Promise<string> {
  return (await db.insert(projects).values({ orgId, name: "SEO data", baseUrl: "https://mysite.example/", ...values }).returning())[0]!.id;
}

async function connectDataForSeo() {
  return integrations.saveIntegration(orgId, "DATAFORSEO", { login: f.dfs.knobs.login, password: f.dfs.knobs.password }, deps());
}

beforeAll(async () => {
  f.dfs = await fakeDataForSeo();
  f.psi = await fakePageSpeed();
  f.tg = await fakeTelegram();
  f.suggest = await fakeSuggest({ "خرید کتاب": ["خرید کتاب آنلاین", "خريد كتاب ارزان", "خرید کتاب"] });
  f.hook = await fakeWebhook();
  orgId = (await db.insert(organizations).values({ name: "SEO data", slug: `seo-data-${stamp}` }).returning())[0]!.id;
  otherOrgId = (await db.insert(organizations).values({ name: "Other", slug: `seo-data-o-${stamp}` }).returning())[0]!.id;
  projectId = await newProject();
});

afterAll(async () => {
  await Promise.all(Object.values(f).map((x) => x.close()));
  await dataQueue("notify").obliterate({ force: true }).catch(() => {});
  await dataQueue("rank").obliterate({ force: true }).catch(() => {});
  await purgeOrganization(orgId).catch(() => {});
  await purgeOrganization(otherOrgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

// ---------------------------------------------------------------- integrations

describe("integrations", () => {
  it("is honestly unconfigured until credentials are saved", async () => {
    expect(await integrations.loadDataForSeo(orgId, deps())).toBeNull();
    expect(await discovery.researchIdeas(orgId, projectId, { seeds: ["seo"], locale: "en", country: "US" }, deps())).toEqual({ configured: false });
    const list = await integrations.listIntegrations(orgId);
    expect(list.map((i) => [i.kind, i.configured, i.status])).toEqual([
      ["DATAFORSEO", false, "NOT_CONNECTED"],
      ["PAGESPEED", false, "NOT_CONNECTED"],
      ["TELEGRAM_ALERTS", false, "NOT_CONNECTED"],
    ]);
  });

  it("stores nothing when the live check fails, with a reason in both languages", async () => {
    const res = await integrations.saveIntegration(orgId, "DATAFORSEO", { login: "api@agency.example", password: "wrong-password" }, deps());
    expect(res).toMatchObject({ ok: false, reason: "invalid_credentials", status: "ERROR", configured: false });
    expect(res.messageText?.fa).toBeTruthy();
    const row = (await db.select().from(orgIntegrations).where(eq(orgIntegrations.orgId, orgId)))[0]!;
    expect(row.secretCipher).toBeNull();
  });

  it("verifies, seals and never returns the credential", async () => {
    const res = await connectDataForSeo();
    expect(res).toMatchObject({ ok: true, status: "CONNECTED", configured: true, config: { login: "api@agency.example", balance: 12.5 } });
    const view = JSON.stringify(await integrations.getIntegration(orgId, "DATAFORSEO"));
    expect(view).not.toContain(f.dfs.knobs.password);
    const row = (await db.select().from(orgIntegrations).where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, "DATAFORSEO"))))[0]!;
    expect(row.secretCipher).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(f.dfs.knobs.password);
    expect((await integrations.loadDataForSeo(orgId, deps()))?.settings).toEqual({ rankTracking: true, maxDailySerpChecks: 200 });
    // Another organization sees none of it.
    expect(await integrations.loadDataForSeo(otherOrgId, deps())).toBeNull();
  });

  it("Telegram: validates bot + chat on save, and the test sends a real message", async () => {
    const bad = await integrations.saveIntegration(orgId, "TELEGRAM_ALERTS", { botToken: f.tg.knobs.token, chatId: "-555" }, deps());
    expect(bad).toMatchObject({ ok: false, reason: "chat_not_found" });
    const ok = await integrations.saveIntegration(orgId, "TELEGRAM_ALERTS", { botToken: f.tg.knobs.token, chatId: "-1001234" }, deps());
    expect(ok).toMatchObject({ ok: true, config: { chatId: "-1001234", botUsername: "seo_table_bot" } });
    expect(JSON.stringify(ok)).not.toContain(f.tg.knobs.token);
    const sentBefore = f.tg.knobs.sent.length;
    expect(await integrations.testIntegration(orgId, "TELEGRAM_ALERTS", deps())).toMatchObject({ ok: true });
    expect(f.tg.knobs.sent.length).toBe(sentBefore + 1);
  });

  it("rejects malformed input before any call", async () => {
    await expect(integrations.saveIntegration(orgId, "TELEGRAM_ALERTS", { botToken: "nope", chatId: "x" }, deps())).rejects.toThrow();
    expect(() => integrations.integrationKind("stripe")).toThrow();
    expect(integrations.integrationKind("telegram-alerts")).toBe("TELEGRAM_ALERTS");
  });
});

// ---------------------------------------------------------------- keywords

describe("keywords", () => {
  it("bulk-adds with normalisation and skips duplicates (in the batch and stored)", async () => {
    const res = await keywordService.addKeywords(
      projectId,
      keywordService.addKeywordsInput.parse({
        phrases: "خرید کتاب\nخريد كتاب\n  seo audit \nSEO Audit",
        tags: ["core"],
      }),
    );
    expect(res.added.map((k) => k.phrase).sort()).toEqual(["seo audit", "خرید کتاب"]);
    expect(res.skipped).toBe(2);
    const again = await keywordService.addKeywords(projectId, keywordService.addKeywordsInput.parse({ phrases: "SEO AUDIT" }));
    expect(again).toMatchObject({ added: [], skipped: 1 });
    // Same phrase on mobile only is a different tracked keyword.
    const mobile = await keywordService.addKeywords(
      projectId,
      keywordService.addKeywordsInput.parse({ keywords: [{ phrase: "seo audit", device: "mobile" }] }),
    );
    expect(mobile.added).toHaveLength(1);
  });

  it("refuses more than 500 at once and an unknown country", async () => {
    expect(() => keywordService.addKeywordsInput.parse({ keywords: Array.from({ length: 501 }, (_, i) => ({ phrase: `k${i}` })) })).toThrow();
    await expect(
      keywordService.addKeywords(projectId, keywordService.addKeywordsInput.parse({ phrases: "x", country: "XX" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("updates, tags in bulk, archives and lists", async () => {
    const { keywords: list } = await keywordService.listKeywords(projectId);
    const book = list.find((k) => k.phrase === "خرید کتاب")!;
    await keywordService.updateKeyword(projectId, book.id, { targetUrl: "https://mysite.example/books/" });
    expect(await keywordService.bulkKeywords(projectId, { action: "add_tag", ids: list.map((k) => k.id), tag: "q3" })).toEqual({ affected: 3 });
    const after = await keywordService.listKeywords(projectId, { tag: "q3" });
    expect(after.keywords).toHaveLength(3);
    expect(after.tags).toEqual(["core", "q3"]);
    expect((await keywordService.listKeywords(projectId, { q: "کتاب" })).keywords.map((k) => k.phrase)).toEqual(["خرید کتاب"]);
    await expect(keywordService.updateKeyword(projectId, "nope", { tags: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------- rank tracking

describe("rank sync", () => {
  const days = ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19"];

  it("without Search Console and DataForSEO it records nothing and says so", async () => {
    const p = await newProject({ baseUrl: "https://empty.example/" });
    await keywordService.addKeywords(p, keywordService.addKeywordsInput.parse({ phrases: "x" }));
    respond = () => null;
    const res = await rankService.syncRank(p, deps());
    expect(res.gsc.configured).toBe(false);
    expect(res.dataforseo.configured).toBe(true); // this org has DataForSEO, the SERP ran
  });

  it("queries Search Console per market with an exact-match regex and stores daily rows", async () => {
    gscCalls.length = 0;
    respond = (req) => {
      const query = req.filters!.find((x) => x.dimension === "query")!.expression;
      const device = req.filters!.find((x) => x.dimension === "device")?.expression ?? null;
      if (req.dimensions.join() === "date,query") {
        if (device === null && query.includes("خرید کتاب")) {
          return days.map((d, i) => ({ keys: [d, "خرید کتاب"], clicks: 3, impressions: 100 + i, ctr: 0.03, position: 6 - i * 0.5 }));
        }
        if (device === "MOBILE") return days.map((d) => ({ keys: [d, "seo audit"], clicks: 1, impressions: 50, ctr: 0.02, position: 10 }));
        return [];
      }
      if (device === null) {
        return [
          { keys: ["خرید کتاب", "https://mysite.example/shop/"], clicks: 5, impressions: 200, ctr: 0.02, position: 7 },
          { keys: ["خرید کتاب", "https://mysite.example/books/"], clicks: 20, impressions: 500, ctr: 0.04, position: 4 },
        ];
      }
      return [];
    };
    // Disable paid SERP checks for this part; they are tested below.
    await integrations.updateDataForSeoSettings(orgId, { rankTracking: false });
    const res = await rankService.syncRank(projectId, deps());
    expect(res.gsc).toMatchObject({ configured: true, from: "2026-09-13", to: "2026-09-19" });
    expect(res.dataforseo).toMatchObject({ configured: true, disabled: true, checked: 0 });
    const daily = gscCalls.filter((c) => c.dimensions.join() === "date,query");
    expect(daily).toHaveLength(2);
    const all = daily.find((c) => !c.filters!.some((x) => x.dimension === "device"))!;
    expect(all.filters).toEqual([
      { dimension: "query", operator: "includingRegex", expression: expect.stringMatching(/^\^\(.*\)\$$/) },
      { dimension: "country", operator: "equals", expression: "irn" },
    ]);
    const mobile = daily.find((c) => c.filters!.some((x) => x.dimension === "device"))!;
    expect(mobile.filters).toContainEqual({ dimension: "device", operator: "equals", expression: "MOBILE" });
    expect(mobile.filters![0]!.expression).toBe("^(seo audit)$");

    const book = (await db.select().from(keywords).where(and(eq(keywords.projectId, projectId), eq(keywords.phrase, "خرید کتاب"))))[0]!;
    const rows = await db.select().from(keywordPositions).where(eq(keywordPositions.keywordId, book.id)).orderBy(keywordPositions.date);
    expect(rows).toHaveLength(7);
    expect(rows[6]).toMatchObject({ date: "2026-09-19", source: "gsc", position: 3, impressions: 106, url: "https://mysite.example/books/" });

    // Idempotent: a second sync updates in place.
    await rankService.syncRank(projectId, deps());
    expect(await db.select().from(keywordPositions).where(eq(keywordPositions.keywordId, book.id))).toHaveLength(7);
  });

  it("checks live SERPs once a day, finds our rank, records the cost", async () => {
    await integrations.updateDataForSeoSettings(orgId, { rankTracking: true });
    f.dfs.knobs.serp.set("خرید کتاب", [
      { domain: "digikala.example", url: "https://digikala.example/books" },
      { domain: "www.mysite.example", url: "https://www.mysite.example/books/" },
    ]);
    const res = await rankService.syncRank(projectId, deps());
    expect(res.dataforseo).toMatchObject({ configured: true, checked: 3, failed: 0, stoppedReason: null, cost: 0.006 });
    const book = (await db.select().from(keywords).where(and(eq(keywords.projectId, projectId), eq(keywords.phrase, "خرید کتاب"))))[0]!;
    const serp = (await db.select().from(keywordPositions).where(and(eq(keywordPositions.keywordId, book.id), eq(keywordPositions.source, "dataforseo"))))[0]!;
    expect(serp).toMatchObject({ date: "2026-09-20", position: 2, url: "https://www.mysite.example/books/", serpFeatures: ["featured_snippet", "people_also_ask"] });
    const usage = await db.select().from(providerUsage).where(eq(providerUsage.orgId, orgId));
    expect(usage.filter((u) => u.endpoint === "serp/google/organic/live/advanced")).toHaveLength(4); // 1 from the empty project + 3
    // Same day again: no second payment.
    const again = await rankService.syncRank(projectId, deps());
    expect(again.dataforseo.checked).toBe(0);
  });

  it("stops paying and flags the integration when the balance runs out", async () => {
    await db.delete(keywordPositions).where(and(eq(keywordPositions.source, "dataforseo"), eq(keywordPositions.date, "2026-09-20")));
    f.dfs.knobs.taskStatus = 40210;
    const res = await rankService.syncRank(projectId, deps());
    expect(res.dataforseo.stoppedReason).toBe("insufficient_funds");
    expect(res.dataforseo.checked).toBe(0);
    expect((await integrations.getIntegration(orgId, "DATAFORSEO")).lastError).toBe("insufficient_funds");
    f.dfs.knobs.taskStatus = null;
    await rankService.syncRank(projectId, deps());
    expect((await integrations.getIntegration(orgId, "DATAFORSEO")).lastError).toBeNull();
  });

  it("lists keywords with each source's numbers side by side", async () => {
    const { keywords: list } = await keywordService.listKeywords(projectId);
    const book = list.find((k) => k.phrase === "خرید کتاب")!;
    expect(book.gsc).toMatchObject({ lastDate: "2026-09-19", impressions: 721, url: "https://mysite.example/books/" });
    expect(book.gsc!.position).toBeCloseTo(4.5, 0);
    expect(book.serp).toMatchObject({ position: 2, date: "2026-09-20" });
  });

  it("computes movers against the previous window and the visibility index", async () => {
    const book = (await db.select().from(keywords).where(and(eq(keywords.projectId, projectId), eq(keywords.phrase, "خرید کتاب"))))[0]!;
    const audit = (await db.select().from(keywords).where(and(eq(keywords.projectId, projectId), eq(keywords.phrase, "seo audit"), eq(keywords.device, "mobile"))))[0]!;
    const older = ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"];
    await db.insert(keywordPositions).values([
      ...older.map((date) => ({ keywordId: book.id, date, source: "gsc" as const, position: 12, clicks: 1, impressions: 100, ctr: 0.01 })),
      ...older.map((date) => ({ keywordId: audit.id, date, source: "gsc" as const, position: 3, clicks: 5, impressions: 50, ctr: 0.1 })),
    ]);
    const m = await rankService.movers(projectId, { days: 7, source: "gsc" });
    expect(m.current).toEqual({ from: "2026-09-13", to: "2026-09-19" });
    expect(m.gains[0]).toMatchObject({ keywordId: book.id, previousPosition: 12 });
    expect(m.gains[0]!.change).toBeGreaterThan(7);
    expect(m.losses[0]).toMatchObject({ keywordId: audit.id, previousPosition: 3, position: 10, change: -7 });

    const v = await rankService.visibility(projectId, { from: "2026-09-06", to: "2026-09-19" });
    expect(v.formula).toContain("CTR");
    expect(v.series).toHaveLength(14);
    // Hand-computed for 2026-09-19: book at 3 (CTR .11), audit at 10 (CTR .025); weights = mean daily impressions.
    const wBook = (100 * 7 + (100 + 101 + 102 + 103 + 104 + 105 + 106)) / 14;
    const wAudit = 50;
    const expected = (100 * (wBook * 0.11 + wAudit * 0.025)) / ((wBook + wAudit) * 0.28);
    expect(v.series.at(-1)!.visibility).toBeCloseTo(Math.round(expected * 10) / 10, 1);

    const h = await rankService.history(projectId, { from: "2026-09-18", to: "2026-09-20", keywordIds: [book.id] });
    expect(h[0]!.series.map((p) => `${p.date}/${p.source}`)).toEqual(["2026-09-18/gsc", "2026-09-19/gsc", "2026-09-20/dataforseo"]);
  });
});

// ---------------------------------------------------------------- discovery

describe("discovery", () => {
  it("Search Console opportunities: positions 4–20, real impressions, not yet tracked", async () => {
    respond = (req) =>
      req.dimensions.join() === "query"
        ? [
            { keys: ["خرید کتاب"], clicks: 10, impressions: 900, ctr: 0.01, position: 6 },
            { keys: ["کتاب صوتی"], clicks: 4, impressions: 800, ctr: 0.005, position: 8.26 },
            { keys: ["کتاب کودک"], clicks: 90, impressions: 1000, ctr: 0.09, position: 2 },
            { keys: ["رمان"], clicks: 0, impressions: 5, ctr: 0, position: 9 },
          ]
        : [];
    const res = await discovery.gscOpportunities(projectId, deps());
    expect(res).toMatchObject({ configured: true, source: "gsc" });
    if (!res.configured) throw new Error("unreachable");
    expect(res.items.map((i) => i.query)).toEqual(["کتاب صوتی"]);
    expect(res.items[0]).toMatchObject({ position: 8.3, potentialClicks: Math.round((800 * 0.11 - 4) * (30 / 28)) });
    respond = () => null;
    expect(await discovery.gscOpportunities(projectId, deps())).toEqual({ configured: false });
  });

  it("autocomplete: no volume data, normalised, cached", async () => {
    const first = await discovery.suggestions(projectId, "خرید کتاب", { locale: "fa", country: "IR" }, deps());
    expect(first).toMatchObject({ source: "autocomplete", volumeData: false, cached: false });
    expect(first.items.map((i) => i.idea)).toEqual(["خرید کتاب آنلاین", "خرید کتاب ارزان"]);
    const calls = f.suggest.received.length;
    const second = await discovery.suggestions(projectId, "خرید کتاب", { locale: "fa", country: "IR" }, deps());
    expect(second.cached).toBe(true);
    expect(f.suggest.received.length).toBe(calls);
  });

  it("DataForSEO ideas carry volume, difficulty and the request cost, then serve from cache for free", async () => {
    const res = await discovery.researchIdeas(orgId, projectId, { seeds: ["seo"], locale: "en", country: "US" }, deps());
    expect(res).toMatchObject({ configured: true, cached: false, cost: 0.002, currency: "USD" });
    if (!res.configured) throw new Error("unreachable");
    expect(res.items[0]).toMatchObject({ idea: "best seo", volume: 1600, difficulty: 55 });
    const cached = await discovery.researchIdeas(orgId, projectId, { seeds: ["seo"], locale: "en", country: "US" }, deps());
    expect(cached).toMatchObject({ configured: true, cached: true, cost: 0 });
    expect(await db.select().from(keywordIdeas).where(and(eq(keywordIdeas.projectId, projectId), eq(keywordIdeas.source, "dataforseo")))).toHaveLength(2);
  });

  it("finds cannibalization and maps keywords to the pages that rank", async () => {
    respond = (req) =>
      req.dimensions.join() === "query,page"
        ? [
            { keys: ["خرید کتاب", "https://mysite.example/books/"], clicks: 20, impressions: 500, ctr: 0.04, position: 4 },
            { keys: ["خرید کتاب", "https://mysite.example/shop/"], clicks: 5, impressions: 300, ctr: 0.02, position: 7 },
            { keys: ["خرید کتاب", "https://mysite.example/blog/x"], clicks: 0, impressions: 3, ctr: 0, position: 40 },
            { keys: ["کتاب کودک", "https://mysite.example/kids/"], clicks: 9, impressions: 100, ctr: 0.09, position: 2 },
          ]
        : [];
    const res = await discovery.cannibalization(projectId, deps());
    if (!res.configured) throw new Error("expected configured");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ query: "خرید کتاب", tracked: true, impressions: 803 });
    expect(res.items[0]!.pages.map((p) => p.url)).toEqual(["https://mysite.example/books/", "https://mysite.example/shop/"]);

    const map = await discovery.mapping(projectId);
    const book = map.find((m) => m.phrase === "خرید کتاب")!;
    expect(book).toMatchObject({ targetUrl: "https://mysite.example/books/", rankingSource: "dataforseo", matches: true });
  });
});

// ---------------------------------------------------------------- PageSpeed

describe("PageSpeed", () => {
  it("measures the homepage and top Search Console pages on this site, both strategies", async () => {
    respond = (req) =>
      req.dimensions.join() === "page"
        ? [
            { keys: ["https://mysite.example/books/"], clicks: 50, impressions: 900, ctr: 0.05, position: 4 },
            { keys: ["https://elsewhere.example/"], clicks: 90, impressions: 900, ctr: 0.1, position: 1 },
            { keys: ["https://mysite.example/shop/"], clicks: 10, impressions: 400, ctr: 0.02, position: 7 },
          ]
        : [];
    const urls = await pagespeedService.selectUrls(projectId, deps(), 3);
    expect(urls).toEqual(["https://mysite.example/", "https://mysite.example/books/", "https://mysite.example/shop/"]);
    const res = await runPageSpeedJob({ projectId, trigger: "MANUAL", requestedBy: "u", correlationId: "c", urls: ["https://mysite.example/", "https://mysite.example/books/"] }, deps());
    expect(res).toMatchObject({ measured: 4, failed: [], alerts: 0 });
    const summary = await pagespeedService.summary(projectId);
    expect(summary.keySource).toBe("none");
    expect(summary.totals.mobile).toMatchObject({ pages: 2, passed: 2, averageScore: 90 });
    expect(summary.pages[0]!.cwv).toMatchObject({ basis: "field", passed: true });
  });

  it("raises one cwv_regression notification when a page slows down", async () => {
    f.psi.knobs.scores.set("https://mysite.example/books/", 0.62);
    f.psi.knobs.fieldLcpMs = 4200;
    const res = await runPageSpeedJob({ projectId, trigger: "MANUAL", requestedBy: "u", correlationId: "c", urls: ["https://mysite.example/books/"] }, deps({ now: () => new Date(NOW.getTime() + 60_000) }));
    expect(res.alerts).toBe(1);
    const [n] = await db.select().from(notifications).where(and(eq(notifications.projectId, projectId), eq(notifications.kind, "cwv_regression")));
    expect(n!.title.en).toBe("Page speed regressed on 2 pages");
    expect(n!.body.fa).toContain("موبایل");
    expect(n!.severity).toBe("SERIOUS");
    const summary = await pagespeedService.summary(projectId);
    const books = summary.pages.find((p) => p.url === "https://mysite.example/books/" && p.strategy === "mobile")!;
    expect(books).toMatchObject({ performanceScore: 62, scoreChange: -28 });
    expect(books.cwv.passed).toBe(false);
    f.psi.knobs.fieldLcpMs = 2300;
  });

  it("stops a run at quota exhaustion and reports what failed", async () => {
    f.psi.knobs.throttle = 100;
    const res = await pagespeedService.runPageSpeed(projectId, { urls: ["https://mysite.example/", "https://mysite.example/x"] }, deps());
    expect(res.measured).toHaveLength(0);
    expect(res.failed).toEqual([{ url: "https://mysite.example/", strategy: "mobile", reason: "quota_exceeded" }]);
    f.psi.knobs.throttle = 0;
    expect(await pagespeedService.urlsBelongToProject(projectId, ["https://www.mysite.example/a", "https://evil.example/"])).toBe(false);
  });
});

// ---------------------------------------------------------------- schedules

describe("schedules", () => {
  it("every new project gets default schedules and alert rules from the database", async () => {
    const p = await newProject({ baseUrl: "https://defaults.example/" });
    const list = await scheduleService.listSchedules(p);
    expect(list.map((s) => [s.kind, s.cron, s.enabled])).toEqual([
      ["scan", "0 3 * * 1", true],
      ["rank", "0 4 * * *", true],
      ["pagespeed", "0 5 * * 3", true],
      ["competitors", "0 6 * * 0", true],
      ["report", "0 7 1 * *", false],
    ]);
    expect(list[1]!.nextRunAt).toBeInstanceOf(Date);
    expect((await alertService.listRules(p)).map((r) => r.kind).sort()).toEqual(
      ["cwv_regression", "index_drop", "new_critical", "page_down", "rank_drop", "score_drop"],
    );
  });

  it("validates cron, timezone and frequency", async () => {
    expect(() => scheduleService.validateCron("0 3 * *", "UTC")).toThrow(/five fields/);
    expect(() => scheduleService.validateCron("*/5 * * * *", "UTC")).toThrow(/once an hour/);
    expect(() => scheduleService.validateCron("0 3 * * 1", "Mars/Base")).toThrow(/timezone/);
    expect(() => scheduleService.validateCron("61 3 * * 1", "UTC")).toThrow(/Invalid cron/);
    const s = await scheduleService.updateSchedule(projectId, "rank", { cron: "30 2 * * *", timezone: "Asia/Tehran" }, new Date("2026-09-20T00:00:00Z"));
    // 02:30 Tehran (UTC+3:30) is 23:00 UTC the day before.
    expect(s.nextRunAt!.toISOString()).toBe("2026-09-20T23:00:00.000Z");
    const off = await scheduleService.updateSchedule(projectId, "rank", { enabled: false });
    expect(off.nextRunAt).toBeNull();
  });

  it("dispatches a due schedule exactly once across concurrent schedulers", async () => {
    const p = await newProject({ baseUrl: "https://tick.example/" });
    const seen: string[] = [];
    const dispatch: scheduleService.Dispatch = async (s) => {
      if (s.projectId === p) seen.push(s.kind);
      await new Promise((r) => setTimeout(r, 150));
    };
    await scheduleService.tick(dispatch); // computes next runs for the new rows
    expect(seen).toEqual([]);
    await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(and(eq(schedules.projectId, p), eq(schedules.kind, "pagespeed")));
    await Promise.all([scheduleService.tick(dispatch), scheduleService.tick(dispatch), scheduleService.tick(dispatch)]);
    expect(seen).toEqual(["pagespeed"]);
    const row = (await db.select().from(schedules).where(and(eq(schedules.projectId, p), eq(schedules.kind, "pagespeed"))))[0]!;
    expect(row.lastRunAt).toBeInstanceOf(Date);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastError).toBeNull();
  });

  it("a scheduled scan becomes a SCHEDULE run; an active scan is recorded, not duplicated", async () => {
    const p = await newProject({ baseUrl: "https://scan-sched.example/" });
    await dispatchSchedule({ id: "sched-test", projectId: p, orgId, kind: "scan" });
    const [run] = await db.select().from(auditRuns).where(eq(auditRuns.projectId, p));
    expect(run).toMatchObject({ trigger: "SCHEDULE", status: "QUEUED" });
    await expect(dispatchSchedule({ id: "sched-test-2", projectId: p, orgId, kind: "scan" })).rejects.toMatchObject({ code: "scan_active" });
    await auditQueue.remove(run!.jobId!);
  });
});

// ---------------------------------------------------------------- alerts and notifications

describe("alerts", () => {
  let hookRuleId: string;
  let hookSecret: string;

  it("creates a webhook rule with a one-time secret and never shows it again", async () => {
    await expect(alertService.createRule(projectId, alertService.createAlertInput.parse({ kind: "score_drop", channels: ["webhook"] }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const res = await alertService.createRule(
      projectId,
      alertService.createAlertInput.parse({ kind: "score_drop", threshold: 3, channels: ["in_app", "webhook", "telegram"], webhookUrl: `${f.hook.url}/hooks/seo` }),
    );
    expect(res.webhookSecret).toMatch(/^whsec_/);
    expect(res.rule).toMatchObject({ threshold: 3, hasWebhookSecret: true });
    expect(JSON.stringify(await alertService.listRules(projectId))).not.toContain(res.webhookSecret!);
    hookRuleId = res.rule.id;
    hookSecret = res.webhookSecret!;
    // new_critical has no threshold, whatever is sent.
    const nc = await alertService.createRule(projectId, alertService.createAlertInput.parse({ kind: "new_critical", threshold: 9 }));
    expect(nc.rule.threshold).toBeNull();
    await alertService.deleteRule(projectId, nc.rule.id);
  });

  it("after a scan: score drop, new critical issues and a down homepage, once each", async () => {
    const prev = (await db.insert(auditRuns).values({ projectId, status: "SUCCEEDED", idempotencyKey: `a-${stamp}`, score: 80, queuedAt: new Date(Date.now() - 3600_000) }).returning())[0]!;
    const run = (await db.insert(auditRuns).values({ projectId, status: "SUCCEEDED", idempotencyKey: `b-${stamp}`, score: 71 }).returning())[0]!;
    await db.insert(seoIssues).values({
      projectId,
      ruleId: "rule.x",
      fingerprint: `fp-${stamp}`,
      severity: "CRITICAL",
      title: "Pages blocked by robots.txt",
      category: "technical",
      firstSeenRunId: run.id,
      lastSeenRunId: run.id,
    });
    await db.insert(pageSnapshots).values({
      auditRunId: run.id,
      projectId,
      url: "https://mysite.example/",
      normalizedUrl: "https://mysite.example/",
      statusCode: 503,
      contentHash: "x",
    });
    const created = await alertService.evaluateAfterScan(run.id, deps());
    // Two score_drop rules (default 5 and the webhook one at 3) + new_critical + page_down.
    expect(created.map((n) => n.kind).sort()).toEqual(["new_critical", "page_down", "score_drop", "score_drop"]);
    const drop = created.find((n) => n.kind === "score_drop" && n.alertRuleId === hookRuleId)!;
    expect(drop.title).toEqual({ fa: "امتیاز سئو ۹ واحد افت کرد", en: "SEO score fell 9 points" });
    expect(drop.deliveries).toMatchObject({ webhook: { status: "pending" }, telegram: { status: "pending" } });
    // Evaluated again (a retried job): nothing new.
    expect(await alertService.evaluateAfterScan(run.id, deps())).toEqual([]);
    expect(prev.id).toBeTruthy();
  });

  it("delivers to the webhook with a verifiable HMAC signature, and to Telegram", async () => {
    const [n] = await db.select().from(notifications).where(and(eq(notifications.alertRuleId, hookRuleId), eq(notifications.kind, "score_drop")));
    expect(await notificationService.deliver(n!.id, "webhook", { attempt: 1, final: false }, deps())).toBe("sent");
    const req = f.hook.received.at(-1)!;
    const ts = String(req.headers["x-seotable-timestamp"]);
    const expected = `sha256=${createHmac("sha256", hookSecret).update(`${ts}.${req.body}`).digest("hex")}`;
    expect(req.headers["x-seotable-signature"]).toBe(expected);
    expect(req.headers["x-seotable-event"]).toBe("score_drop");
    expect(JSON.parse(req.body)).toMatchObject({ id: n!.id, event: "score_drop", title: { en: "SEO score fell 9 points" }, project: { id: projectId } });

    const before = f.tg.knobs.sent.length;
    expect(await notificationService.deliver(n!.id, "telegram", { attempt: 1, final: false }, deps())).toBe("sent");
    expect(f.tg.knobs.sent.length).toBe(before + 1);
    expect(f.tg.knobs.sent.at(-1)!.text).toContain("<b>امتیاز سئو ۹ واحد افت کرد</b>");

    const [after] = await db.select().from(notifications).where(eq(notifications.id, n!.id));
    expect(after!.deliveries).toMatchObject({ webhook: { status: "sent", attempts: 1 }, telegram: { status: "sent" } });
  });

  it("a failing webhook is retried by the queue and ends as failed", async () => {
    f.hook.knobs.status = 500;
    const [n] = await db.select().from(notifications).where(and(eq(notifications.alertRuleId, hookRuleId), eq(notifications.kind, "score_drop")));
    await expect(notificationService.deliver(n!.id, "webhook", { attempt: 4, final: true }, deps())).rejects.toMatchObject({ reason: "webhook_rejected" });
    const [after] = await db.select().from(notifications).where(eq(notifications.id, n!.id));
    expect(after!.deliveries.webhook).toMatchObject({ status: "failed", attempts: 4, error: "webhook_rejected" });
    f.hook.knobs.status = 200;
  });

  it("refuses a webhook on a private address outside tests", async () => {
    const prev = process.env.ALLOW_PRIVATE_NETWORK;
    process.env.ALLOW_PRIVATE_NETWORK = "0";
    try {
      await expect(
        alertService.updateRule(projectId, hookRuleId, { webhookUrl: "http://169.254.169.254/latest" }),
      ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = prev;
    }
  });

  it("after a rank sync: rank drops and an index drop", async () => {
    respond = (req) => {
      if (req.dimensions.join() !== "page") return [];
      const recent = req.end.toISOString().slice(0, 10) === "2026-09-17";
      return Array.from({ length: recent ? 30 : 50 }, (_, i) => ({ keys: [`https://mysite.example/p${i}`], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }));
    };
    const res = await runRankJob({ projectId, trigger: "SCHEDULE", requestedBy: "scheduler", correlationId: "c" }, deps());
    expect(res.alerts).toBeGreaterThanOrEqual(2);
    const drops = await db.select().from(notifications).where(and(eq(notifications.projectId, projectId), eq(notifications.kind, "rank_drop")));
    expect(drops).toHaveLength(1);
    expect(drops[0]!.body.en).toContain("seo audit: 3 → 10");
    const index = await db.select().from(notifications).where(and(eq(notifications.projectId, projectId), eq(notifications.kind, "index_drop")));
    expect(index[0]!.data).toMatchObject({ previousPages: 50, currentPages: 30, dropPercent: 40 });
  });

  it("the test button reports each channel", async () => {
    const res = await alertService.testRule(projectId, hookRuleId, deps());
    expect(res).toEqual({ webhook: { ok: true, reason: null }, telegram: { ok: true, reason: null } });
    expect(JSON.parse(f.hook.received.at(-1)!.body)).toMatchObject({ event: "test", data: { test: true } });
  });

  it("the inbox pages, counts unread and marks read, per organization", async () => {
    const page = await notificationService.listNotifications(orgId, { page: 1, perPage: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.unread).toBe(page.total);
    const other = await notificationService.listNotifications(otherOrgId, { page: 1, perPage: 50 });
    expect(other.total).toBe(0);
    expect(await notificationService.markRead(otherOrgId, [page.items[0]!.id])).toBe(0);
    expect(await notificationService.markRead(orgId, [page.items[0]!.id])).toBe(1);
    expect((await notificationService.listNotifications(orgId, { page: 1, perPage: 50, unreadOnly: true })).total).toBe(page.total - 1);
    expect(await notificationService.markAllRead(orgId, projectId)).toBe(page.total - 1);
    expect((await notificationService.listNotifications(orgId, { page: 1, perPage: 1 })).unread).toBe(0);
  });
});

// ---------------------------------------------------------------- competitors

/** A small site: robots.txt with a Disallow and a sitemap, a few HTML pages. */
async function site(pages: Record<string, string>, robots: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(robots);
    }
    if (path === "/sitemap.xml") {
      const host = `http://${req.headers.host}`;
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(pages)
          .filter((p) => p !== "/")
          .map((p) => `<url><loc>${host}${p}</loc></url>`)
          .join("")}</urlset>`,
      );
    }
    const body = pages[path];
    if (!body) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<h1>Not found</h1>");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
}

const page = (title: string, h2s: number, words: number, schema?: string) =>
  `<html><head><title>${title}</title><meta name="description" content="About ${title}">${
    schema ? `<script type="application/ld+json">{"@context":"https://schema.org","@type":"${schema}"}</script>` : ""
  }</head><body><h1>${title}</h1>${"<h2>Section</h2>".repeat(h2s)}<p>${"word ".repeat(words)}</p><a href="/a">a</a><a href="https://ext.example/">x</a></body></html>`;

describe("competitors", () => {
  let rival: { server: Server; port: number };
  let ours: { server: Server; port: number };
  let p: string;
  let rivalId: string;

  beforeAll(async () => {
    rival = await site(
      { "/": page("Rival home", 3, 400, "Organization"), "/a": page("Rival A", 5, 900, "Product"), "/private/x": page("Secret", 1, 10) },
      "User-agent: *\nDisallow: /private/\nSitemap: /sitemap.xml\n",
    );
    ours = await site({ "/": page("Our home", 1, 120), "/a": page("Our A", 0, 200) }, "User-agent: *\nAllow: /\n");
    p = await newProject({ baseUrl: `http://localhost:${ours.port}/` });
  });

  afterAll(async () => {
    await new Promise((r) => rival.server.close(r));
    await new Promise((r) => ours.server.close(r));
  });

  it("adds a competitor by domain or URL, refusing our own site and duplicates", async () => {
    await expect(competitorService.addCompetitor(p, { domain: "not a domain" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(competitorService.addCompetitor(p, { domain: `http://localhost:${ours.port}/x` })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const c = await competitorService.addCompetitor(p, { domain: "http://127.0.0.1/whatever", name: "Rival" });
    expect(c).toMatchObject({ domain: "127.0.0.1", name: "Rival", isSelf: false });
    rivalId = c.id;
    await expect(competitorService.addCompetitor(p, { domain: "127.0.0.1" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("samples homepage + sitemap pages politely, obeying robots.txt", async () => {
    const res = await samplePages(`http://127.0.0.1:${rival.port}/`, { cap: 30 });
    expect(res.robots).toBe("ok");
    expect(res.pages.map((x) => new URL(x.url).pathname)).toEqual(["/", "/a"]);
    expect(res.pages[1]).toMatchObject({ title: "Rival A", h1: ["Rival A"], schemaTypes: ["Product"], wordCount: 906, externalLinks: 1 });
    expect(res.pages[1]!.headings).toMatchObject({ counts: { h1: 1, h2: 5 } });
  });

  it("snapshots competitors and our own site the same way, and compares them", async () => {
    const d = deps({ competitorUrl: (domain) => `http://${domain}:${rival.port}/` });
    const results = await competitorService.snapshotCompetitors(p, {}, d);
    expect(results.map((r) => [r.self, r.pages, r.error])).toEqual([
      [true, 2, null],
      [false, 2, null],
    ]);
    const list = await competitorService.listCompetitors(p);
    expect(list).toEqual([expect.objectContaining({ id: rivalId, pagesSampled: 2 })]);
    const cmp = await competitorService.compare(p);
    // Words counted as the crawler counts them (headings included, one-letter words not).
    expect(cmp.ours).toMatchObject({ pagesSampled: 2, avgWordCount: 162, avgH2: 0.5, schemaTypes: [] });
    expect(cmp.competitors[0]!.stats).toMatchObject({ avgWordCount: 655.5, avgH2: 4, schemaTypes: [{ type: "Organization", pages: 1 }, { type: "Product", pages: 1 }] });
    // Homepage lab CWV came from PageSpeed.
    expect(cmp.competitors[0]!.stats!.homepage).toMatchObject({ lcpMs: 2100, cls: 0.05 });
    // Our own site is sampled at most once in 20 hours.
    const again = await competitorService.snapshotCompetitors(p, { competitorId: rivalId }, d);
    expect(again.map((r) => r.self)).toEqual([false]);
    expect((await db.select().from(competitors).where(eq(competitors.projectId, p))).filter((c) => c.isSelf)).toHaveLength(1);
  });

  it("keyword gap needs DataForSEO; with it, finds what they rank for and we do not", async () => {
    f.dfs.knobs.ranked.set("127.0.0.1", [
      { keyword: "seo tools", position: 3, volume: 2400, url: "https://rival/tools" },
      { keyword: "site audit", position: 5, volume: 900, url: "https://rival/audit" },
      { keyword: "deep page", position: 45, volume: 100, url: "https://rival/deep" },
    ]);
    f.dfs.knobs.ranked.set("localhost", [{ keyword: "site audit", position: 12, volume: 900, url: "http://localhost/audit" }]);
    const gap = await competitorService.keywordGap(orgId, p, rivalId, { country: "US", locale: "en" }, deps());
    if (!gap.configured) throw new Error("expected configured");
    expect(gap.missing.map((k) => k.keyword)).toEqual(["seo tools"]);
    expect(gap.behind).toEqual([expect.objectContaining({ keyword: "site audit", theirPosition: 5, ourPosition: 12 })]);
    expect(gap.cost).toBe(0.004);
    await integrations.deleteIntegration(orgId, "DATAFORSEO");
    expect(await competitorService.keywordGap(orgId, p, rivalId, { country: "US", locale: "en" }, deps())).toEqual({ configured: false });
    expect(await competitorService.backlinkComparison(orgId, p, rivalId, deps())).toEqual({ configured: false });
    await connectDataForSeo();
  });
});

// ---------------------------------------------------------------- queue

describe("data queues", () => {
  it("keeps one waiting rank sync per project", async () => {
    const p = await newProject({ baseUrl: "https://queue.example/" });
    const a = await enqueueRankSync({ projectId: p, trigger: "MANUAL", requestedBy: "u", correlationId: "1" });
    const b = await enqueueRankSync({ projectId: p, trigger: "MANUAL", requestedBy: "u", correlationId: "2" });
    expect(a.deduplicated).toBe(false);
    expect(b).toEqual({ jobId: a.jobId, deduplicated: true });
    await dataQueue("rank").remove(a.jobId);
  });

  it("usage summary adds up what was spent", async () => {
    const u = await integrations.usageSummary(orgId, 3650);
    expect(u.calls).toBeGreaterThan(0);
    const sum = (await db.execute<{ s: number }>(sql`SELECT coalesce(sum(cost),0)::float8 AS s FROM provider_usage WHERE org_id = ${orgId}`)).rows[0] as { s: number };
    expect(u.totalCost).toBeCloseTo(sum.s, 4);
  });
});

