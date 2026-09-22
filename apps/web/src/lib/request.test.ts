/**
 * Pure request helpers: client IP, cross-site detection, content type,
 * pagination, idempotency keys, same-site redirect paths and connector texts.
 */
import { describe, expect, it } from "vitest";
import {
  clientIp,
  isCrossSite,
  isJsonContentType,
  isValidIdempotencyKey,
  parsePagination,
} from "./request";
import { safePath } from "./redirect";
import { connectorMessage, storedConnectorError } from "./connector-messages";
import { opportunityPeriod } from "./queries";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIp", () => {
  it("prefers a valid X-Real-IP", () => {
    expect(clientIp(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.9");
  });
  it("takes the rightmost X-Forwarded-For entry, which the proxy appended", () => {
    // The client wrote "1.1.1.1"; only the last hop is the proxy's own observation.
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(h({ "x-forwarded-for": "2001:db8::1, garbage" }))).toBe("2001:db8::1");
  });
  it("ignores invalid values", () => {
    expect(clientIp(h({ "x-real-ip": "not-an-ip", "x-forwarded-for": "x, y" }))).toBe("unknown");
    expect(clientIp(h({}))).toBe("unknown");
  });
});

describe("isCrossSite", () => {
  it("trusts Sec-Fetch-Site when present", () => {
    expect(isCrossSite(h({ "sec-fetch-site": "same-origin", origin: "https://evil.example" }))).toBe(false);
    expect(isCrossSite(h({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossSite(h({ "sec-fetch-site": "same-site" }))).toBe(true);
  });
  it("compares Origin with the forwarded host, then Host", () => {
    expect(isCrossSite(h({ origin: "https://app.example", "x-forwarded-host": "app.example", host: "0.0.0.0:3000" }))).toBe(false);
    expect(isCrossSite(h({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(false);
    expect(isCrossSite(h({ origin: "https://evil.example", host: "app.example" }))).toBe(true);
    expect(isCrossSite(h({ origin: "null", host: "app.example" }))).toBe(true);
  });
  it("treats a request with neither header as a non-browser client", () => {
    expect(isCrossSite(h({ host: "app.example" }))).toBe(false);
  });
});

describe("isJsonContentType", () => {
  it("accepts JSON types only", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/merge-patch+json")).toBe(true);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/x-www-form-urlencoded")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});

describe("parsePagination", () => {
  const p = (q: string) => parsePagination(new URLSearchParams(q));
  it("clamps to safe integers", () => {
    expect(p("page=1e20").page).toBe(1_000_000);
    expect(p("page=1e20").offset).toBe(999_999 * 50);
    expect(p("page=-3&perPage=0")).toMatchObject({ page: 1, perPage: 1 });
    expect(p("perPage=10000").perPage).toBe(200);
    expect(p("page=2.7&perPage=abc")).toMatchObject({ page: 2, perPage: 50, offset: 50 });
    expect(p("page=Infinity").page).toBe(1);
  });
});

describe("isValidIdempotencyKey", () => {
  it("allows visible ASCII, 1–255 chars", () => {
    expect(isValidIdempotencyKey("abc-123_XYZ:~")).toBe(true);
    expect(isValidIdempotencyKey("a".repeat(255))).toBe(true);
    expect(isValidIdempotencyKey("a".repeat(256))).toBe(false);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("has space")).toBe(false);
    expect(isValidIdempotencyKey("کلید")).toBe(false);
  });
});

describe("safePath", () => {
  it("keeps same-site paths with query and hash", () => {
    expect(safePath("/issues?severity=CRITICAL#top")).toBe("/issues?severity=CRITICAL#top");
    expect(safePath("/a/../b")).toBe("/b");
    // Still encoded, so the browser resolves it on this site.
    expect(safePath("/%09/example.com")).toBe("/%09/example.com");
  });
  it("refuses anything a browser could resolve off-site, and header-breaking input", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/x\r\nSet-Cookie: a=b",
      "/.//evil.example",
      "https://evil.example",
      "evil",
      "",
      null,
      undefined,
    ]) {
      expect(safePath(bad), String(bad)).toBe("/");
    }
  });
});

describe("connector messages", () => {
  const raw = { ok: false, reason: "network_error", message: "getaddrinfo ENOTFOUND db.internal (10.0.0.5:5432)" };
  it("never shows or stores the raw network error", () => {
    expect(connectorMessage("en", raw)).not.toContain("10.0.0.5");
    expect(connectorMessage("fa", raw)).not.toContain("internal");
    expect(storedConnectorError(raw)).toMatch(/^network_error: Could not reach the site/);
  });
  it("has fa and en for the new reasons", () => {
    for (const reason of ["blocked_address", "redirected"]) {
      const en = connectorMessage("en", { ok: false, reason, message: "x" });
      const fa = connectorMessage("fa", { ok: false, reason, message: "x" });
      expect(en).not.toBe("x");
      expect(fa).not.toBe(en);
    }
    expect(
      connectorMessage("en", {
        ok: false,
        reason: "redirected",
        message: "https://a.example answered HTTP 301 redirecting to https://www.a.example/; use the final address",
      }),
    ).toContain("(https://www.a.example/)");
  });
});

describe("opportunityPeriod", () => {
  it("is the same for every sync on one UTC day", () => {
    const a = opportunityPeriod(new Date("2026-09-22T00:00:01Z"));
    const b = opportunityPeriod(new Date("2026-09-22T23:59:59Z"));
    expect(a).toEqual(b);
    expect(a.end.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(a.start.toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });
});
