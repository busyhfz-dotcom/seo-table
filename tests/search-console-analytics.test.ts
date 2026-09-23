/**
 * Search Console searchAnalytics with filters, against a Google double at the
 * httpJson seam (the style of search-console-actions.test.ts): the request body
 * Google receives — dimensions, dimensionFilterGroups, paging — and the rows
 * handed back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { url: string; method: string; body: string | undefined };
const calls: Call[] = [];
let pages: Array<Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>> = [];

vi.mock("../packages/connectors/src/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/connectors/src/types.js")>();
  return {
    ...actual,
    httpJson: async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
      if (url === "https://oauth2.googleapis.com/token") {
        return { status: 200, data: { access_token: "t", expires_in: 3600 }, text: "", headers: new Headers() };
      }
      const rows = pages.shift() ?? [];
      return { status: 200, data: { rows }, text: JSON.stringify({ rows }), headers: new Headers() };
    },
  };
});

const { searchConsole, forgetTokens } = await import("@seo/connectors");
const client = searchConsole({
  siteUrl: "sc-domain:mysite.example",
  google: { type: "oauth_refresh", client_id: "cid", client_secret: "s", refresh_token: "r" },
});

beforeEach(() => {
  calls.length = 0;
  pages = [];
  forgetTokens();
});

describe("searchAnalytics", () => {
  it("sends the filters as one AND group and returns typed rows", async () => {
    pages = [[{ keys: ["2026-09-19", "خرید کتاب"], clicks: 3, impressions: 100, ctr: 0.03, position: 4.2 }]];
    const rows = await client.searchAnalytics({
      start: new Date("2026-09-13T00:00:00Z"),
      end: new Date("2026-09-19T00:00:00Z"),
      dimensions: ["date", "query"],
      filters: [
        { dimension: "query", operator: "includingRegex", expression: "^(خرید کتاب)$" },
        { dimension: "country", operator: "equals", expression: "irn" },
        { dimension: "device", operator: "equals", expression: "MOBILE" },
      ],
      limit: 100,
    });
    const q = calls.find((c) => c.url.endsWith("/searchAnalytics/query"))!;
    expect(q.url).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Amysite.example/searchAnalytics/query");
    expect(JSON.parse(q.body!)).toEqual({
      startDate: "2026-09-13",
      endDate: "2026-09-19",
      dimensions: ["date", "query"],
      rowLimit: 100,
      startRow: 0,
      dataState: "all",
      dimensionFilterGroups: [
        {
          groupType: "and",
          filters: [
            { dimension: "query", operator: "includingRegex", expression: "^(خرید کتاب)$" },
            { dimension: "country", operator: "equals", expression: "irn" },
            { dimension: "device", operator: "equals", expression: "MOBILE" },
          ],
        },
      ],
    });
    expect(rows).toEqual([{ keys: ["2026-09-19", "خرید کتاب"], clicks: 3, impressions: 100, ctr: 0.03, position: 4.2 }]);
  });

  it("pages with startRow until a short page, and sends no filter group when there are none", async () => {
    const full = Array.from({ length: 25_000 }, (_, i) => ({ keys: [`q${i}`], clicks: 0, impressions: 1, ctr: 0, position: 9 }));
    pages = [full, [{ keys: ["last"], clicks: 0, impressions: 1, ctr: 0, position: 9 }]];
    const rows = await client.searchAnalytics({ start: new Date("2026-09-01"), end: new Date("2026-09-19"), dimensions: ["query"], limit: 60_000 });
    const bodies = calls.filter((c) => c.url.endsWith("/searchAnalytics/query")).map((c) => JSON.parse(c.body!));
    expect(bodies.map((b) => [b.startRow, b.rowLimit])).toEqual([
      [0, 25_000],
      [25_000, 25_000],
    ]);
    expect(bodies[0].dimensionFilterGroups).toBeUndefined();
    expect(rows).toHaveLength(25_001);
  });
});
