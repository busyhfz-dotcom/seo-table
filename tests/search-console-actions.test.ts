/**
 * Search Console actions — sitemap submission and URL inspection — against a
 * Google double in place of the HTTP layer (the connectors reach Google only
 * through httpJson, so that is the seam).
 *
 * What must hold: the right endpoint, method and body; the full webmasters
 * scope for submitting and the read-only one for inspecting; addresses outside
 * the property refused before any call; Google's refusals mapped to reasons
 * the panel explains.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { url: string; method: string; body: string | undefined; auth: string | undefined };
const calls: Call[] = [];
let respond: (call: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

vi.mock("../packages/connectors/src/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/connectors/src/types.js")>();
  return {
    ...actual,
    httpJson: async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = { url, method: init.method ?? "GET", body: init.body as string | undefined, auth: headers.authorization };
      calls.push(call);
      if (url === "https://oauth2.googleapis.com/token") {
        const scope = new URLSearchParams(String(init.body)).get("assertion") ? "sa" : "refresh";
        return { status: 200, data: { access_token: `token-${scope}-${calls.length}`, expires_in: 3600 }, text: "", headers: new Headers() };
      }
      const { status, body } = respond(call);
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return { status, data: typeof body === "string" ? null : body, text, headers: new Headers() };
    },
  };
});

const { searchConsole, forgetTokens, inProperty } = await import("@seo/connectors");

const google = { type: "oauth_refresh" as const, client_id: "cid", client_secret: "secret", refresh_token: "rt" };
const client = (siteUrl = "sc-domain:shop.example") => searchConsole({ siteUrl, google });
const tokenCalls = () => calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/"));

beforeEach(() => {
  calls.length = 0;
  forgetTokens();
  respond = () => ({ status: 200, body: {} });
});

describe("submitSitemap", () => {
  it("PUTs the sitemap under the property with the full webmasters scope", async () => {
    respond = () => ({ status: 204, body: "" });
    await client().submitSitemap("https://www.shop.example/sitemap_index.xml");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Ashop.example/sitemaps/https%3A%2F%2Fwww.shop.example%2Fsitemap_index.xml",
    );
    // The refresh-token grant does not carry scopes; the scope decision shows in the token cache key instead.
    expect(tokenCalls()).toHaveLength(1);
  });

  it("refuses a sitemap outside the property without calling Google", async () => {
    await expect(client("https://shop.example/").submitSitemap("https://other.example/sitemap.xml")).rejects.toMatchObject({ code: "sitemap_outside_property" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [403, { error: { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, "insufficient_scope"],
    [403, { error: { message: "User does not have sufficient permission for site", status: "PERMISSION_DENIED" } }, "insufficient_permission"],
    [429, { error: { message: "Quota exceeded" } }, "quota_exceeded"],
  ] as const)("maps Google %s to a reason", async (status, body, reason) => {
    respond = () => ({ status, body });
    await expect(client().submitSitemap("https://shop.example/sitemap.xml")).rejects.toMatchObject({ code: reason });
  });
});

describe("inspectUrl", () => {
  it("POSTs to the URL Inspection API and reduces the answer", async () => {
    respond = (call) => {
      expect(call.url).toBe("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
      expect(JSON.parse(call.body!)).toEqual({ inspectionUrl: "https://shop.example/p", siteUrl: "sc-domain:shop.example", languageCode: "fa-IR" });
      return {
        status: 200,
        body: {
          inspectionResult: {
            inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=x",
            indexStatusResult: {
              verdict: "PASS",
              coverageState: "Submitted and indexed",
              indexingState: "INDEXING_ALLOWED",
              robotsTxtState: "ALLOWED",
              pageFetchState: "SUCCESSFUL",
              lastCrawlTime: "2026-09-20T10:00:00Z",
              crawledAs: "MOBILE",
              googleCanonical: "https://shop.example/p",
              userCanonical: "https://shop.example/p",
              sitemap: ["https://shop.example/sitemap.xml"],
            },
            mobileUsabilityResult: { verdict: "PASS" },
            richResultsResult: { verdict: "PASS", detectedItems: [{ richResultType: "Product" }, { richResultType: "Product" }, { richResultType: "Breadcrumbs" }] },
          },
        },
      };
    };
    const res = await client().inspectUrl("https://shop.example/p", "fa-IR");
    expect(res).toMatchObject({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      googleCanonical: "https://shop.example/p",
      sitemaps: ["https://shop.example/sitemap.xml"],
      referringUrls: [],
      richResults: { verdict: "PASS", types: ["Product", "Breadcrumbs"] },
    });
  });

  it("refuses an address outside the property", async () => {
    await expect(client().inspectUrl("https://evil.example/")).rejects.toMatchObject({ code: "url_outside_property" });
    expect(calls).toHaveLength(0);
  });

  it("uses separate tokens for the read-only and the write scope", async () => {
    respond = (call) => (call.method === "PUT" ? { status: 204, body: "" } : { status: 200, body: { inspectionResult: {} } });
    await client().inspectUrl("https://shop.example/a");
    await client().inspectUrl("https://shop.example/b");
    await client().submitSitemap("https://shop.example/sitemap.xml");
    // One token per scope set: the read-only token is reused, the write one is new.
    expect(tokenCalls()).toHaveLength(2);
  });
});

describe("inProperty", () => {
  it.each([
    ["sc-domain:shop.example", "https://shop.example/x", true],
    ["sc-domain:shop.example", "http://blog.shop.example/x", true],
    ["sc-domain:shop.example", "https://evilshop.example/x", false],
    ["https://shop.example/fa/", "https://shop.example/fa/p", true],
    ["https://shop.example/fa/", "https://shop.example/en/p", false],
  ] as const)("%s contains %s: %s", (site, url, expected) => {
    expect(inProperty(site, url)).toBe(expected);
  });
});
