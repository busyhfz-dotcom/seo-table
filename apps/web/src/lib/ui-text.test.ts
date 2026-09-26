/**
 * The interface's translations of machine values: every rule, every audit
 * action and every API error code has wording in both languages, and nothing
 * raw or in Latin digits leaks into Persian text.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ALL_RULES } from "@seo/core";
import {
  categoryLabel,
  fixTitle,
  noindexLabel,
  resultCodeLabel,
  ruleDescription,
  ruleName,
  ruleTitle,
  suggestedActionLabel,
  RULE_TITLES,
  RULE_DESCRIPTIONS_FA,
  CATEGORY_LABELS,
} from "./labels";
import { describeAction } from "./activity";
import { apiErrorMessage, callApi } from "./errors-ui";

const REPO = path.resolve(__dirname, "../../../..");
const LATIN_DIGIT = /[0-9]/;
const RAW_ENUM = /\b[A-Z]{2,}(_[A-Z]+)+\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("rules", () => {
  it("has a Persian title, description and category for every rule the engine runs", () => {
    for (const rule of ALL_RULES) {
      expect(RULE_TITLES[rule.id], rule.id).toBeDefined();
      expect(RULE_DESCRIPTIONS_FA[rule.id], rule.id).toBeDefined();
      expect(CATEGORY_LABELS[rule.category], rule.category).toBeDefined();
      expect(ruleName(rule.id, "fa")).not.toBe(rule.id);
      expect(ruleDescription(rule.id, rule.description, "en")).toBe(rule.description);
    }
    expect(RULE_TITLES["rule.robots.unreachable"]).toBeDefined();
    expect(categoryLabel("engine", "fa")).toBe("موتور قواعد");
  });

  it("translates finding-specific titles, with Persian digits", () => {
    expect(ruleTitle("rule.canonical.broken", "Canonical target could not be verified", "fa")).toBe(
      "مقصد canonical قابل بررسی نبود",
    );
    expect(ruleTitle("rule.index.http_error", "URL returns HTTP 404", "fa")).toBe("نشانی خطای HTTP ۴۰۴ برمی‌گرداند");
    expect(ruleTitle("rule.title.duplicate", "Duplicate title across 3 pages", "fa")).toMatch(/۳/);
    expect(ruleTitle("rule.title.duplicate", "Duplicate title across 3 pages", "en")).toBe(
      "Duplicate title across 3 pages",
    );
    expect(ruleTitle("rule.unknown", "Something new", "fa")).toBe("Something new");
  });

  it("names every noindex reason, including non-HTML responses", () => {
    expect(noindexLabel("non_html", "fa")).toBe("غیر HTML");
    expect(noindexLabel("http_410", "fa")).toBe("خطای HTTP ۴۱۰");
    expect(noindexLabel("robots_txt_disallow", "en")).toBe("Blocked by robots.txt");
  });
});

describe("fixes", () => {
  it("keeps the batch suffix in Persian digits", () => {
    expect(fixTitle("TITLE_REWRITE", "Rewrite the title (2/3)", "fa")).toBe("بازنویسی عنوان (۲/۳)");
  });

  it("translates every execution result code", () => {
    const codes = [
      "unreadable",
      "changed_since_scan",
      "changed_since_apply",
      "already_applied",
      "already_restored",
      "nothing_to_restore",
      "unsupported_action",
      "post_url_mismatch",
      "post_not_found",
      "post_ambiguous",
      "url_outside_site",
      "home_page_unsupported",
      "media_not_found",
      "media_ambiguous",
      "image_ambiguous",
      "content_unreadable",
    ];
    for (const code of codes) {
      expect(resultCodeLabel(code, false, "fa"), code).not.toBe(code);
      expect(resultCodeLabel(code, false, "en"), code).not.toBe(code);
    }
    expect(resultCodeLabel("http_500", false, "fa")).toMatch(/۵۰۰/);
  });

  it("maps Search Console suggestions by code or by the stored English sentence", () => {
    expect(suggestedActionLabel("test_clearer_title", "fa")).toMatch(/عنوان روشن‌تری/);
    expect(
      suggestedActionLabel("Ranks on page one but is rarely clicked — rewrite the title and meta description", "fa"),
    ).toMatch(/بازنویسی/);
    expect(suggestedActionLabel("Something else", "fa")).toBe("Something else");
  });
});

describe("activity", () => {
  it("describes every audit action recorded anywhere in the codebase", () => {
    const files = [
      ...sourceFiles(path.join(REPO, "apps")),
      ...sourceFiles(path.join(REPO, "packages")),
    ];
    const actions = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("recordAudit")) continue;
      for (const m of text.matchAll(/action:\s*(?:[^"\n]*\?\s*)?"([a-z_]+\.[a-z_]+)"(?:\s*:\s*"([a-z_]+\.[a-z_]+)")?/g)) {
        actions.add(m[1]!);
        if (m[2]) actions.add(m[2]);
      }
    }
    // The ternaries in execute.ts and proposals.ts.
    for (const a of ["fix.dry_run", "fix.apply", "approval.approve", "approval.reject", "auth.logout"]) actions.add(a);
    expect(actions.size).toBeGreaterThan(15);
    for (const action of actions) {
      for (const locale of ["fa", "en"] as const) {
        const text = describeAction(action, "USER", { kind: "WORDPRESS", ok: true, action: "TITLE_REWRITE" }, locale);
        expect(text, `${action} (${locale})`).not.toBe(action);
        if (locale === "fa") {
          expect(text).not.toMatch(LATIN_DIGIT);
          expect(text).not.toMatch(RAW_ENUM);
        }
      }
    }
  });
});

describe("API errors", () => {
  it("words every code in both languages, and falls back on the status", () => {
    for (const code of [
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "INVALID_CREDENTIALS",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "SCAN_ACTIVE",
      "RATE_LIMITED",
      "POLICY_VIOLATION",
      "UPSTREAM_ERROR",
      "CONNECTOR_NOT_CONNECTED",
      "BLOCKED_ADDRESS",
      "UNSUPPORTED_MEDIA_TYPE",
      "INTERNAL",
      "BROWSER_UNAVAILABLE",
      "BROWSER_BUSY",
      "PAYLOAD_TOO_LARGE",
      "SERVICE_UNAVAILABLE",
    ]) {
      const fa = apiErrorMessage("fa", { status: 400, code });
      expect(fa, code).not.toMatch(/[A-Za-z]{3,}/);
      expect(apiErrorMessage("en", { status: 400, code }), code).not.toBe(code);
    }
    expect(apiErrorMessage("fa", { status: 429, code: "RATE_LIMITED", details: { retryAfterSeconds: 12 } })).toMatch(/۱۲/);
    expect(apiErrorMessage("fa", { status: 403, code: "FORBIDDEN", details: { requiresApproval: true } })).toMatch(/تأیید/);
    expect(apiErrorMessage("fa", { status: 404 })).toBe(apiErrorMessage("fa", { status: 404, code: "NOT_FOUND" }));
    expect(apiErrorMessage("fa", { status: 599, unreadable: true })).toMatch(/۵۹۹/);
    expect(apiErrorMessage("fa", { status: 503, unreadable: true })).toMatch(/در دسترس نیست/);
    expect(apiErrorMessage("en", { status: 409, code: "CONNECTOR_NOT_CONNECTED", details: { kind: "CLOUDFLARE" } })).toMatch(
      /Cloudflare is not connected/,
    );
    // A connector's reason travels in the details and is worded, never shown raw.
    const conflict = apiErrorMessage("fa", { status: 409, code: "CONFLICT", details: { reason: "invalid_token" } });
    expect(conflict).toMatch(/توکن/);
    expect(conflict).not.toMatch(/invalid_token/);
    expect(apiErrorMessage("en", { status: 0, network: true })).toMatch(/reach the server/);
  });

  it("callApi never throws: network failure, non-JSON body, JSON error, JSON success", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      expect(await callApi("/x")).toEqual({ ok: false, failure: { status: 0, network: true } });

      fetchMock.mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
      const html = await callApi("/x");
      expect(html.ok).toBe(false);
      expect(!html.ok && html.failure).toMatchObject({ status: 502, unreadable: true });

      fetchMock.mockResolvedValueOnce(
        Response.json({ error: { code: "SCAN_ACTIVE", message: "…", details: { activeRunId: "r1" } } }, { status: 409 }),
      );
      const conflict = await callApi("/x", { method: "POST", body: { a: 1 } });
      expect(!conflict.ok && conflict.failure).toMatchObject({ status: 409, code: "SCAN_ACTIVE" });
      const init = fetchMock.mock.calls[2]![1] as RequestInit;
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");

      fetchMock.mockResolvedValueOnce(Response.json({ run: { id: "r2" } }, { status: 201 }));
      expect(await callApi("/x", { method: "POST", body: {} })).toEqual({ ok: true, status: 201, data: { run: { id: "r2" } } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
