/**
 * Pure-function regressions for the review findings in crypto, rbac, scoring,
 * logging, queue ids and error codes. No database needed.
 */
import { Writable } from "node:stream";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { hashPassword, seal, unseal, verifyPassword } from "./crypto.js";
import { can } from "./rbac.js";
import { computeScore } from "./scoring.js";
import { REDACT_PATHS } from "./logger.js";
import { closeQueues, fixJobId } from "./queue.js";
import { closeRedis } from "./redis.js";
import { BlockedAddress, ScanAlreadyRunning } from "./errors.js";
import { draftsFromGroups } from "./services/proposals.js";

afterAll(async () => {
  await closeQueues();
  await closeRedis();
});

describe("verifyPassword rejects malformed hashes", () => {
  it.each([
    "scrypt$1$x$",
    "scrypt$1$$",
    "scrypt$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA",
    "scrypt$2$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(88),
    "scrypt$1$not base64!$" + "A".repeat(88),
    "bcrypt$whatever",
  ])("%s matches no password", async (stored) => {
    expect(await verifyPassword("", stored)).toBe(false);
    expect(await verifyPassword("anything at all", stored)).toBe(false);
  });

  it("still verifies a real hash", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong horse battery", stored)).toBe(false);
  });
});

describe("unseal only accepts full-length GCM parameters", () => {
  it("rejects a truncated auth tag", () => {
    const sealed = seal("secret");
    const short = Buffer.from(sealed.tag, "base64").subarray(0, 4).toString("base64");
    expect(() => unseal({ ...sealed, tag: short })).toThrow(/malformed/);
  });
  it("rejects a non-12-byte IV", () => {
    const sealed = seal("secret");
    expect(() => unseal({ ...sealed, iv: Buffer.alloc(16).toString("base64") })).toThrow(/malformed/);
  });
  it("round-trips", () => {
    expect(unseal(seal("سلام"))).toBe("سلام");
  });
});

describe("rbac", () => {
  it("an unknown role can do nothing instead of throwing", () => {
    expect(can("SUPERUSER" as never, "project:read")).toBe(false);
    expect(can("constructor" as never, "project:read")).toBe(false);
  });
});

describe("scoring", () => {
  const page = (url: string, statusCode = 200) =>
    ({ normalizedUrl: url, statusCode, indexable: true }) as never;
  const finding = (url: string) =>
    ({ ruleId: "r", category: "c", severity: "CRITICAL" as const, title: "t", url, evidence: {} });

  it("findings on a crawled non-200 page are not a site-wide penalty", () => {
    const clean = computeScore([page("a"), page("gone", 404)], []).score;
    const withBroken = computeScore([page("a"), page("gone", 404)], [finding("gone")]).score;
    expect(withBroken).toBe(clean);
  });
  it("findings on uncrawled urls (robots.txt, sitemap) still are", () => {
    expect(computeScore([page("a")], [finding("https://e.ir/robots.txt")]).score).toBeLessThan(100);
  });
  it("is linear-time enough for a large site", () => {
    const pages = Array.from({ length: 20_000 }, (_, i) => page(`u${i}`));
    const findings = Array.from({ length: 60_000 }, (_, i) => finding(`u${i % 20_000}`));
    const t0 = Date.now();
    computeScore(pages, findings);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("log redaction", () => {
  function capture(obj: Record<string, unknown>): string {
    let out = "";
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, stream).info(obj, "x");
    return out;
  }

  it("redacts secrets one level down", () => {
    const out = capture({
      connector: { secretCipher: "C1PHER", secretIv: "IVIV", secretTag: "TAGTAG", credentials: "CREDS" },
      wp: { applicationPassword: "APPPASS" },
      oauth: { refreshToken: "REFRESH", privateKey: "PRIVKEY" },
      req: { headers: { authorization: "Bearer TOKEN1", cookie: "sid=COOKIE1" } },
      headers: { authorization: "Bearer TOKEN2" },
      user: { password: "PW" },
    });
    for (const secret of ["C1PHER", "IVIV", "TAGTAG", "CREDS", "APPPASS", "REFRESH", "PRIVKEY", "TOKEN1", "COOKIE1", "TOKEN2", "PW"]) {
      expect(out).not.toContain(secret);
    }
  });
});

describe("fix job ids", () => {
  it("are unique per request so a repeat dry run or re-apply is not dropped", () => {
    expect(fixJobId("p1", true)).not.toBe(fixJobId("p1", true));
    expect(fixJobId("p1", false)).not.toContain(":");
  });
});

describe("error codes", () => {
  it("ScanAlreadyRunning is 409 SCAN_ACTIVE with the active run id", () => {
    const e = new ScanAlreadyRunning("run1");
    expect(e.status).toBe(409);
    expect(e.code).toBe("SCAN_ACTIVE");
    expect(e.details).toEqual({ activeRunId: "run1" });
  });
  it("BlockedAddress is 400 BLOCKED_ADDRESS", () => {
    const e = new BlockedAddress();
    expect([e.status, e.code]).toEqual([400, "BLOCKED_ADDRESS"]);
  });
});

describe("draftsFromGroups", () => {
  it("links every proposal to the issue its changes come from", () => {
    const fix = (url: string) => ({
      action: "TITLE_REWRITE" as const,
      risk: "SENSITIVE" as const,
      title: "Rewrite",
      rationale: "r",
      change: { url, field: "title", before: "a", after: "b" },
    });
    const g = (fp: string, url: string) => ({
      ruleId: "rule.title.length",
      fingerprint: fp,
      category: "title",
      severity: "WARNING" as const,
      title: fp,
      urls: [url],
      findings: [{ ruleId: "rule.title.length", category: "title", severity: "WARNING" as const, title: fp, url, evidence: {}, fix: fix(url) }],
    });
    const drafts = draftsFromGroups("p", [g("too_long", "/a"), g("too_short", "/b")], new Map([["too_long", "i1"], ["too_short", "i2"]]));
    expect(drafts.map((d) => [d.issueId, d.changes.map((c) => c.url)])).toEqual([["i1", ["/a"]], ["i2", ["/b"]]]);
  });
});
