import { describe, expect, it } from "vitest";
import { normalizeUrl, registrableHost } from "./url.js";
import { isAllowed, parseRobots, parseSitemap, crawlDelayFor } from "./robots.js";
import { extract, indexability } from "./extract.js";
import { resolveRedirects } from "./redirects.js";
import { hashPassword, verifyPassword, seal, unseal, fingerprint } from "./crypto.js";
import { can, assertCan } from "./rbac.js";
import { effectiveRisk, evaluate, requiresApproval, agentMayAutoApply } from "./policy.js";
import { trimToLength } from "./rules/types.js";
import { slugify } from "./rules/structure.js";
import { computeScore } from "./scoring.js";
import { groupFindings } from "./rules/index.js";

describe("normalizeUrl", () => {
  it("drops fragments, tracking params and default ports; sorts the rest", () => {
    expect(normalizeUrl("HTTPS://Example.IR:443/a/?utm_source=x&b=2&a=1#top")).toBe("https://example.ir/a?a=1&b=2");
  });
  it("treats /x/ and /x/index.html as one page", () => {
    expect(normalizeUrl("https://e.ir/x/index.html")).toBe(normalizeUrl("https://e.ir/x/"));
  });
  it("rejects non-http schemes", () => {
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });
  it("resolves relative links", () => {
    expect(normalizeUrl("../b", "https://e.ir/a/c")).toBe("https://e.ir/b");
  });
  it("treats www and bare host as one site", () => {
    expect(registrableHost("WWW.example.ir")).toBe("example.ir");
  });
});

describe("robots.txt", () => {
  const robots = parseRobots(
    [
      "User-agent: *",
      "Disallow: /private",
      "Allow: /private/public",
      "Disallow: /*.pdf$",
      "",
      "User-agent: SeoTableBot",
      "Disallow: /no-bots",
      "Crawl-delay: 2",
      "Sitemap: https://e.ir/sitemap.xml",
    ].join("\n"),
  );

  it("longest match wins, Allow wins ties", () => {
    expect(isAllowed(robots, "https://e.ir/private/x", "OtherBot")).toBe(false);
    expect(isAllowed(robots, "https://e.ir/private/public/x", "OtherBot")).toBe(true);
  });
  it("honours $ anchors and wildcards", () => {
    expect(isAllowed(robots, "https://e.ir/a/file.pdf", "OtherBot")).toBe(false);
    expect(isAllowed(robots, "https://e.ir/a/file.pdf?x=1", "OtherBot")).toBe(true);
  });
  it("uses the specific agent group when one matches", () => {
    expect(isAllowed(robots, "https://e.ir/no-bots", "SeoTableBot/0.4")).toBe(false);
    expect(isAllowed(robots, "https://e.ir/private", "SeoTableBot/0.4")).toBe(true);
    expect(crawlDelayFor(robots, "SeoTableBot/0.4")).toBe(2);
  });
  it("collects sitemaps", () => {
    expect(robots.sitemaps).toEqual(["https://e.ir/sitemap.xml"]);
  });
  it("a missing robots.txt allows everything", () => {
    expect(isAllowed(parseRobots("", true), "https://e.ir/anything", "x")).toBe(true);
  });
  it("parses sitemap indexes separately from url sets", () => {
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://e.ir/a.xml</loc></sitemap></sitemapindex>").sitemaps).toEqual([
      "https://e.ir/a.xml",
    ]);
    expect(parseSitemap("<urlset><url><loc>https://e.ir/?a=1&amp;b=2</loc></url></urlset>").urls).toEqual([
      "https://e.ir/?a=1&b=2",
    ]);
  });
});

describe("extract", () => {
  const html = `<!doctype html><html lang="fa"><head>
    <title> عنوان صفحه </title>
    <meta name="description" content="توضیح">
    <link rel="canonical" href="/canon">
    <meta name="robots" content="noindex">
    <script type="application/ld+json">{"@type":"Product"}</script>
  </head><body>
    <h1>یک</h1><h1>دو</h1>
    <img src="a.webp"><img src="b.webp" alt=""><img src="c.webp" alt="c">
    <a href="/in">داخلی</a><a href="https://other.com/x">خارجی</a><a href="/in">تکرار</a>
    <a href="#top">لنگر</a><a href="mailto:a@b.c">ایمیل</a><a href="/doc.pdf">pdf</a>
  </body></html>`;
  const e = extract(html, "https://e.ir/page");

  it("reads head fields", () => {
    expect(e.title).toBe("عنوان صفحه");
    expect(e.titleLength).toBe([..."عنوان صفحه"].length);
    expect(e.canonical).toBe("https://e.ir/canon");
    expect(e.robotsMeta).toBe("noindex");
    expect(e.lang).toBe("fa");
  });
  it("treats alt=\"\" as a valid decorative opt-out", () => {
    expect(e.imagesTotal).toBe(3);
    expect(e.imagesMissingAlt).toBe(1);
  });
  it("dedupes links and ignores anchors, mailto and assets", () => {
    expect(e.internalLinksOut).toBe(1);
    expect(e.externalLinksOut).toBe(1);
  });
  it("finds every H1 and JSON-LD types", () => {
    expect(e.h1s).toEqual(["یک", "دو"]);
    expect(e.structuredDataTypes).toContain("Product");
  });
});

describe("indexability", () => {
  const base = { robotsMeta: null, xRobotsTag: null, allowedByRobotsTxt: true, canonical: null, normalizedUrl: "https://e.ir/a" };
  it.each([
    [{ ...base, statusCode: 404 }, "http_404"],
    [{ ...base, statusCode: 301 }, "redirect"],
    [{ ...base, statusCode: 200, robotsMeta: "noindex,follow" }, "meta_noindex"],
    [{ ...base, statusCode: 200, xRobotsTag: "noindex" }, "meta_noindex"],
    [{ ...base, statusCode: 200, allowedByRobotsTxt: false }, "robots_txt_disallow"],
    [{ ...base, statusCode: 200, canonical: "https://e.ir/b" }, "canonicalised_elsewhere"],
  ])("%o → %s", (input, reason) => {
    expect(indexability(input)).toEqual({ indexable: false, reason });
  });
  it("a plain 200 is indexable", () => {
    expect(indexability({ ...base, statusCode: 200 }).indexable).toBe(true);
  });
});

describe("redirect graph", () => {
  it("resolves chains and detects loops exactly", () => {
    const r = resolveRedirects([
      { normalizedUrl: "a", statusCode: 301, redirectTarget: "b" },
      { normalizedUrl: "b", statusCode: 302, redirectTarget: "c" },
      { normalizedUrl: "c", statusCode: 200, redirectTarget: null },
      { normalizedUrl: "x", statusCode: 301, redirectTarget: "y" },
      { normalizedUrl: "y", statusCode: 301, redirectTarget: "x" },
    ]);
    expect(r.get("a")).toEqual({ chain: ["a", "b", "c"], finalUrl: "c", loop: false });
    expect(r.get("c")?.chain).toEqual([]);
    expect(r.get("x")?.loop).toBe(true);
  });
});

describe("crypto", () => {
  it("round-trips a sealed secret and detects tampering", () => {
    const sealed = seal("app password");
    expect(unseal(sealed)).toBe("app password");
    const tampered = { ...sealed, cipher: Buffer.from("x".repeat(12)).toString("base64") };
    expect(() => unseal(tampered)).toThrow();
  });
  it("uses a fresh IV per seal", () => {
    expect(seal("same").iv).not.toBe(seal("same").iv);
  });
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("refuses short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });
  it("fingerprints are stable", () => {
    expect(fingerprint(["a", "b"])).toBe(fingerprint(["a", "b"]));
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["ab", ""]));
  });
});

describe("rbac", () => {
  it("only admins and owners approve sensitive fixes", () => {
    expect(can("VIEWER", "fix:approve_sensitive")).toBe(false);
    expect(can("EDITOR", "fix:approve_sensitive")).toBe(false);
    expect(can("ADMIN", "fix:approve_sensitive")).toBe(true);
    expect(can("OWNER", "fix:approve_sensitive")).toBe(true);
  });
  it("viewers cannot start scans", () => {
    expect(() => assertCan("VIEWER", "scan:run")).toThrow(/cannot scan:run/);
  });
  it("roles are strictly nested", () => {
    for (const p of ["project:read", "scan:run", "fix:rollback"] as const) {
      if (can("EDITOR", p)) expect(can("ADMIN", p)).toBe(true);
      if (can("ADMIN", p)) expect(can("OWNER", p)).toBe(true);
    }
  });
});

describe("policy", () => {
  it("never lets a restricted action be downgraded", () => {
    expect(effectiveRisk("PAGE_MERGE", "LOW")).toBe("RESTRICTED");
    expect(requiresApproval("URL_CHANGE", "LOW")).toBe(true);
    expect(agentMayAutoApply("REDIRECT", "LOW")).toBe(false);
  });
  it("lets the agent apply only low-risk actions", () => {
    expect(agentMayAutoApply("ALT_TEXT")).toBe(true);
    expect(agentMayAutoApply("TITLE_REWRITE")).toBe(false);
  });
  it("enforces the change cap", () => {
    const d = evaluate({ action: "ALT_TEXT", changeCount: 10_000, dryRun: false, approved: false, hasDryRunResult: true, actor: "USER" });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.startsWith("change_cap_exceeded"))).toBe(true);
  });
  it("always permits a dry run of a restricted action", () => {
    expect(evaluate({ action: "REDIRECT", changeCount: 1, dryRun: true, approved: false, hasDryRunResult: false, actor: "AGENT" }).allowed).toBe(true);
  });
});

describe("text helpers", () => {
  it("trims on a word boundary", () => {
    expect(trimToLength("یک دو سه چهار پنج", 10)).toBe("یک دو سه");
  });
  it("slugifies Persian without destroying it", () => {
    expect(slugify("کتانی دویدن مردانه ۱۲۰۴")).toBe("کتانی-دویدن-مردانه-۱۲۰۴");
  });
});

describe("scoring", () => {
  const page = (url: string, extra: Record<string, unknown> = {}) =>
    ({ normalizedUrl: url, statusCode: 200, indexable: true, ...extra }) as never;

  it("a clean site scores 100", () => {
    expect(computeScore([page("a"), page("b")], []).score).toBe(100);
  });
  it("is per-page, so site size alone does not change the score", () => {
    const f = (url: string) => ({ ruleId: "r", category: "title", severity: "WARNING" as const, title: "t", url, evidence: {} });
    const small = computeScore([page("a"), page("b")], [f("a")]).score;
    const large = computeScore(
      Array.from({ length: 20 }, (_, i) => page(String(i))),
      Array.from({ length: 10 }, (_, i) => f(String(i))),
    ).score;
    expect(small).toBe(large);
  });
  it("caps the penalty per category", () => {
    const many = Array.from({ length: 10 }, () => ({
      ruleId: "r",
      category: "title",
      severity: "CRITICAL" as const,
      title: "t",
      url: "a",
      evidence: {},
    }));
    expect(computeScore([page("a")], many).score).toBe(60);
  });
  it("groups findings by rule and group key", () => {
    const g = groupFindings([
      { ruleId: "r", category: "c", severity: "INFO", title: "t", url: "a", evidence: {} },
      { ruleId: "r", category: "c", severity: "SERIOUS", title: "t", url: "b", evidence: {} },
      { ruleId: "r", category: "c", severity: "INFO", title: "t", groupKey: "x", url: "a", evidence: {} },
    ]);
    expect(g).toHaveLength(2);
    expect(g[0]?.severity).toBe("SERIOUS");
    expect(g[0]?.urls).toEqual(["a", "b"]);
  });
});
