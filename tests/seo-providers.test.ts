/**
 * The data providers against HTTP doubles of the real APIs: request shapes
 * (auth, location codes, filters), response parsing, error reasons, cost
 * reporting, 429 back-off, and that a Telegram token never leaks into an error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assessCwv,
  dataForSeo,
  dataForSeoLocation,
  dataForSeoReason,
  googleSuggest,
  gscCountry,
  normalizePhrase,
  pageSpeedInsights,
  phraseKey,
  telegram,
  toDomain,
} from "@seo/seo-data";
import { regexBatches, expectedCtr } from "../packages/seo-data/src/rank.js";
import { fakeDataForSeo, fakePageSpeed, fakeSuggest, fakeTelegram } from "./fake-seo-apis.js";

type Fakes = {
  dfs: Awaited<ReturnType<typeof fakeDataForSeo>>;
  psi: Awaited<ReturnType<typeof fakePageSpeed>>;
  tg: Awaited<ReturnType<typeof fakeTelegram>>;
  suggest: Awaited<ReturnType<typeof fakeSuggest>>;
};
const f = {} as Fakes;

beforeAll(async () => {
  f.dfs = await fakeDataForSeo();
  f.psi = await fakePageSpeed();
  f.tg = await fakeTelegram();
  f.suggest = await fakeSuggest({ "خرید کتاب": ["خرید کتاب آنلاین", "خرید کتاب دست دوم"] });
});

afterAll(async () => {
  await Promise.all(Object.values(f).map((x) => x.close()));
});

const creds = () => ({ login: f.dfs.knobs.login, password: f.dfs.knobs.password });

describe("markets and text", () => {
  it("maps countries to Search Console alpha-3 and Google Ads location codes", () => {
    expect(gscCountry("IR")).toBe("irn");
    expect(gscCountry("us")).toBe("usa");
    expect(dataForSeoLocation("IR")).toBe(2364);
    expect(dataForSeoLocation("US")).toBe(2840);
    expect(dataForSeoLocation("XX")).toBeNull();
  });

  it("folds Arabic Yeh/Kaf into Persian and keeps ZWNJ", () => {
    expect(normalizePhrase("  كتاب   علمي ")).toBe("کتاب علمی");
    expect(normalizePhrase("می‌خواهم")).toBe("می‌خواهم");
    expect(phraseKey("SEO Tools")).toBe("seo tools");
  });

  it("reduces typed domains and URLs to a bare host", () => {
    expect(toDomain("https://www.Rival.example/path?q=1")).toBe("www.rival.example");
    expect(toDomain("rival.example")).toBe("rival.example");
    expect(toDomain("localhost")).toBeNull();
    expect(toDomain("ftp://x.example")).toBeNull();
  });

  it("batches exact-match regexes for Search Console under the length limit, escaped", () => {
    const phrases = Array.from({ length: 400 }, (_, i) => `keyword number ${i} (x)`);
    const batches = regexBatches(phrases);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(3000);
      expect(b.startsWith("^(") && b.endsWith(")$")).toBe(true);
    }
    expect(batches[0]).toContain("keyword number 0 \\(x\\)");
    expect(batches.join("|").split("|").length).toBe(400);
  });

  it("models CTR by position for the visibility index", () => {
    expect(expectedCtr(1)).toBe(0.28);
    expect(expectedCtr(10.4)).toBe(0.025);
    expect(expectedCtr(15)).toBe(0.01);
    expect(expectedCtr(35)).toBe(0);
    expect(expectedCtr(null)).toBe(0);
  });
});

describe("DataForSEO", () => {
  it("checks credentials against user_data and reports the balance", async () => {
    const res = await dataForSeo(creds(), { baseUrl: f.dfs.url }).check();
    expect(res).toMatchObject({ ok: true, detail: { login: "api@agency.example", balance: 12.5 } });
    expect(f.dfs.received.at(-1)!.method).toBe("GET");
  });

  it("maps wrong credentials and an empty balance to reasons", async () => {
    expect(await dataForSeo({ login: "x@y.z", password: "nope" }, { baseUrl: f.dfs.url }).check()).toMatchObject({
      ok: false,
      reason: "invalid_credentials",
    });
    f.dfs.knobs.balance = 0;
    expect(await dataForSeo(creds(), { baseUrl: f.dfs.url }).check()).toMatchObject({ ok: false, reason: "insufficient_funds" });
    f.dfs.knobs.balance = 12.5;
    expect(dataForSeoReason(40210, 200)).toBe("insufficient_funds");
    expect(dataForSeoReason(40202, 200)).toBe("rate_limited");
    expect(dataForSeoReason(40204, 200)).toBe("access_denied");
  });

  it("sends Iran/Persian as location 2364 + fa and returns volume with the request's cost", async () => {
    const client = dataForSeo(creds(), { baseUrl: f.dfs.url });
    const res = await client.searchVolume(["خرید کتاب", "کتاب"], { country: "IR", language: "fa" });
    const sent = JSON.parse(f.dfs.received.at(-1)!.body) as Array<Record<string, unknown>>;
    expect(sent).toEqual([{ keywords: ["خرید کتاب", "کتاب"], location_code: 2364, language_code: "fa" }]);
    expect(res.cost).toBe(0.002);
    expect(res.value[0]).toMatchObject({ keyword: "خرید کتاب", volume: 1000, cpc: 0.5, competition: 40 });
  });

  it("parses Labs ideas (competition 0–1 → index) and difficulty", async () => {
    const client = dataForSeo(creds(), { baseUrl: f.dfs.url });
    const ideas = await client.keywordIdeas(["seo"], { country: "US", language: "en" }, 50);
    expect(ideas.value).toContainEqual(expect.objectContaining({ keyword: "best seo", volume: 1600, difficulty: 55, competition: 70 }));
    const kd = await client.keywordDifficulty(["seo"], { country: "US", language: "en" });
    expect(kd.value).toEqual([{ keyword: "seo", difficulty: 42 }]);
  });

  it("reads a live SERP: organic ranks and the features on the page", async () => {
    f.dfs.knobs.serp.set("seo audit", [
      { domain: "other.example", url: "https://other.example/a" },
      { domain: "www.mysite.example", url: "https://www.mysite.example/audit" },
    ]);
    const res = await dataForSeo(creds(), { baseUrl: f.dfs.url }).serp({
      keyword: "seo audit",
      market: { country: "IR", language: "fa" },
      device: "mobile",
      depth: 100,
    });
    const sent = JSON.parse(f.dfs.received.at(-1)!.body)[0];
    expect(sent).toMatchObject({ keyword: "seo audit", location_code: 2364, language_code: "fa", device: "mobile", depth: 100 });
    expect(res.value.features).toEqual(["featured_snippet", "people_also_ask"]);
    expect(res.value.items.filter((i) => i.type === "organic").map((i) => i.rankGroup)).toEqual([1, 2]);
  });

  it("surfaces a failed task (out of funds) as a ProviderError reason", async () => {
    f.dfs.knobs.taskStatus = 40210;
    await expect(
      dataForSeo(creds(), { baseUrl: f.dfs.url }).serp({ keyword: "x", market: { country: "IR", language: "fa" }, device: "desktop", depth: 10 }),
    ).rejects.toMatchObject({ reason: "insufficient_funds" });
    f.dfs.knobs.taskStatus = null;
  });

  it("refuses a market it has no location code for, without calling out", async () => {
    const before = f.dfs.received.length;
    await expect(
      dataForSeo(creds(), { baseUrl: f.dfs.url }).searchVolume(["x"], { country: "XX", language: "en" }),
    ).rejects.toMatchObject({ reason: "location_unsupported" });
    expect(f.dfs.received.length).toBe(before);
  });

  it("reads ranked keywords and a backlink summary", async () => {
    f.dfs.knobs.ranked.set("rival.example", [{ keyword: "seo tools", position: 3, volume: 2400, url: "https://rival.example/tools" }]);
    const client = dataForSeo(creds(), { baseUrl: f.dfs.url });
    const ranked = await client.rankedKeywords("rival.example", { country: "US", language: "en" }, 100);
    expect(ranked.value).toEqual([{ keyword: "seo tools", position: 3, url: "https://rival.example/tools", volume: 2400, difficulty: 20 }]);
    const bl = await client.backlinkSummary("rival.example");
    expect(bl.value).toMatchObject({ backlinks: 5400, referringDomains: 220, rank: 310 });
  });
});

describe("PageSpeed Insights", () => {
  it("reads lab metrics, CrUX field data (CLS ÷ 100) and top opportunities", async () => {
    const m = await pageSpeedInsights({ baseUrl: f.psi.url }).run("https://mysite.example/", "mobile");
    const q = new URL(f.psi.received.at(-1)!.path, "http://x").searchParams;
    expect(q.get("strategy")).toBe("MOBILE");
    expect(q.get("category")).toBe("PERFORMANCE");
    expect(q.has("key")).toBe(false);
    expect(m).toMatchObject({ performanceScore: 90, lcpMs: 2100, cls: 0.05, fcpMs: 1100, tbtMs: 251, ttfbMs: 310, inpMs: 180 });
    expect(m.fieldData).toMatchObject({ scope: "url", lcpMs: { p75: 2300, category: "FAST" }, cls: { p75: 0.05 } });
    expect(m.opportunities.map((o) => o.id)).toEqual(["render-blocking-resources", "unused-javascript"]);
  });

  it("backs off on 429 and then succeeds", async () => {
    f.psi.knobs.throttle = 2;
    const m = await pageSpeedInsights({ baseUrl: f.psi.url, retryDelaysMs: [5, 5, 5] }).run("https://mysite.example/b", "desktop");
    expect(m.performanceScore).toBe(90);
    expect(f.psi.knobs.throttle).toBe(0);
  });

  it("gives up with quota_exceeded when 429 persists, and names a bad key", async () => {
    f.psi.knobs.throttle = 5;
    await expect(pageSpeedInsights({ baseUrl: f.psi.url, retryDelaysMs: [1] }).run("https://mysite.example/", "mobile")).rejects.toMatchObject({
      reason: "quota_exceeded",
    });
    f.psi.knobs.throttle = 0;
    f.psi.knobs.validKey = "AIzaGoodKey_00000000000000";
    expect(await pageSpeedInsights({ baseUrl: f.psi.url, apiKey: "AIzaWrongKey_0000000000000" }).check()).toMatchObject({
      ok: false,
      reason: "invalid_credentials",
    });
    expect(await pageSpeedInsights({ baseUrl: f.psi.url, apiKey: "AIzaGoodKey_00000000000000" }).check()).toMatchObject({ ok: true });
    f.psi.knobs.validKey = null;
  });

  it("judges Core Web Vitals by Google's thresholds, field first, lab labelled", () => {
    expect(assessCwv({ lcpMs: 5000, cls: 0.3, fieldData: { scope: "url", overall: "FAST", lcpMs: { p75: 2400, category: "FAST" }, cls: { p75: 0.05, category: "FAST" }, inpMs: { p75: 150, category: "FAST" } } })).toEqual({
      basis: "field",
      passed: true,
      lcp: "good",
      inp: "good",
      cls: "good",
    });
    expect(assessCwv({ lcpMs: 2600, cls: 0.05, fieldData: null })).toMatchObject({ basis: "lab", passed: false, lcp: "needs_improvement", inp: null });
    expect(assessCwv({ lcpMs: 2000, cls: 0.26, fieldData: null })).toMatchObject({ passed: false, cls: "poor" });
    expect(assessCwv({ lcpMs: null, cls: null, fieldData: null }).passed).toBe(false);
  });
});

describe("Google Suggest", () => {
  it("asks in the market's language and country and returns suggestions only", async () => {
    const list = await googleSuggest({ baseUrl: `${f.suggest.url}/complete/search` }).suggest("خرید کتاب", { language: "fa", country: "IR" });
    const q = new URL(f.suggest.received.at(-1)!.path, "http://x").searchParams;
    expect([q.get("hl"), q.get("gl"), q.get("client"), q.get("oe")]).toEqual(["fa", "ir", "firefox", "utf-8"]);
    expect(list).toEqual(["خرید کتاب آنلاین", "خرید کتاب دست دوم"]);
  });
});

describe("Telegram", () => {
  it("checks the bot and the chat, and sends HTML messages", async () => {
    const client = telegram({ botToken: f.tg.knobs.token }, { baseUrl: f.tg.url });
    expect(await client.check("-1001234")).toMatchObject({ ok: true, detail: { botUsername: "seo_table_bot", chatTitle: "SEO alerts" } });
    expect(await client.check("-999")).toMatchObject({ ok: false, reason: "chat_not_found" });
    await client.send("-1001234", "<b>hi</b>");
    expect(f.tg.knobs.sent.at(-1)).toEqual({ chatId: "-1001234", text: "<b>hi</b>" });
  });

  it("never puts the bot token in an error", async () => {
    const token = "999999:ZZZ-wrong-token-that-is-long-enough_1";
    const res = await telegram({ botToken: token }, { baseUrl: f.tg.url }).check("-1001234");
    expect(res).toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect(JSON.stringify(res)).not.toContain(token);
    const unreachable = telegram({ botToken: token }, { baseUrl: "http://127.0.0.1:1" });
    const err = await unreachable.send("-1", "x").catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(token);
  });
});
