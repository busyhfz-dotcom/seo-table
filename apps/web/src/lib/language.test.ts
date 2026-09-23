/**
 * The owner's rule: a Persian screen shows no untranslated English and no
 * Latin digits, an English screen no Persian. Checked here on every string the
 * interface owns (the rendered screens are checked end to end by the language
 * audit); brand and technical names that stay Latin in Persian are listed.
 */
import { describe, expect, it } from "vitest";
import { MESSAGE_KEYS, translator } from "./i18n";
import { CONNECTOR_RESULT_CODES, NOTES, REASONS, connectorMessage, storedConnectorError } from "./connector-messages";
import { ACTION_LABELS, CATEGORY_LABELS, FIX_TITLES, FIX_WHY, RULE_DESCRIPTIONS_FA, RULE_TITLES } from "./labels";
import { connectStrings } from "../app/(app)/connect/keys";

const KEEP_LATIN = [
  "SEO Table", "WordPress", "Cloudflare", "Search Console", "Google", "GA4", "API", "REST", "URL", "HTML", "HTTP",
  "H1", "H2", "robots.txt", "sitemap.xml", "JSON-LD", "JSON", "canonical", "hreflang", "noindex", "nofollow", "alt",
  "robots", "Worker", "Workers Routes", "Workers", "KV", "DNS", "Application Passwords", "Application Password",
  "Rank Math", "Yoast SEO", "Yoast", "SEOPress", "All in One SEO", "Instagram", "YouTube", "Chromium", "LCP", "CLS",
  "TTFB", "CTR", "OAuth", "Redis", "nginx", "Apache", ".htaccess", "Bridge", "Owner", "Full", "Viewer", "Wordfence",
  "Solid Security", "iThemes", "All In One WP Security", "Redirection", "CMS", "Global API Key", "My Profile",
  "API Tokens", "sc-domain", "webmasters", "wp-content", "mu-plugins", "Authorization", "JavaScript", "URL",
].sort((a, b) => b.length - a.length);

/** What is left of a Persian string once code, placeholders, file names and allowed names are removed. */
function leftovers(text: string): { words: string[]; digits: string[] } {
  let s = text
    .replace(/`[^`]*`/g, " ")
    .replace(/\{\w+\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[\w-]+(\.[\w-]+)+(\/\S*)?/g, " ");
  for (const k of KEEP_LATIN) s = s.split(k).join(" ");
  return { words: s.match(/[A-Za-z]{2,}/g) ?? [], digits: s.match(/[0-9]/g) ?? [] };
}

function persianClean(label: string, text: string) {
  const { words, digits } = leftovers(text);
  expect(words, `${label}: ${text}`).toEqual([]);
  expect(digits, `${label}: ${text}`).toEqual([]);
}

describe("interface language", () => {
  it("every Persian message has no untranslated English or Latin digits, every English one no Persian", () => {
    const fa = translator("fa");
    const en = translator("en");
    for (const key of MESSAGE_KEYS) {
      persianClean(key, fa(key));
      expect(en(key), key).not.toMatch(/[؀-ۿ]/);
    }
  });

  it("does the same for rule, fix and connector wording", () => {
    for (const [id, pair] of Object.entries(RULE_TITLES)) persianClean(id, pair.fa);
    for (const [id, text] of Object.entries(RULE_DESCRIPTIONS_FA)) persianClean(id, text);
    for (const [re, pair] of NOTES) {
      persianClean(String(re), pair.fa);
      expect(pair.en, String(re)).not.toMatch(/[\u0600-\u06FF]/);
    }
    for (const map of [CATEGORY_LABELS, ACTION_LABELS, FIX_TITLES, FIX_WHY, REASONS, CONNECTOR_RESULT_CODES]) {
      for (const [id, pair] of Object.entries(map)) {
        persianClean(id, pair.fa);
        expect(pair.en, id).not.toMatch(/[؀-ۿ]/);
      }
    }
  });

  it("puts a connector's HTTP detail in the reader's digits, with codes kept as code", () => {
    const fa = connectorMessage("fa", {
      ok: false,
      reason: "invalid_credentials",
      message: "WordPress rejected the username or application password (401 incorrect_password).",
    });
    expect(fa).toMatch(/۴۰۱/);
    expect(fa).toMatch(/`incorrect_password`/);
    persianClean("detail", fa);
    expect(connectorMessage("en", { ok: false, reason: "rest_api_disabled", message: "x (HTTP 404)." })).toMatch(/\(HTTP 404\)$/);
    expect(connectorMessage("fa", { ok: true, message: "Connected to Cloudflare zone example.com." })).not.toMatch(/zone/);
    // A stored error is re-worded later: the missing permission survives the round trip.
    const stored = storedConnectorError({ reason: "missing_permission", message: 'The API token lacks the "Zone → DNS → Read" permission.' });
    const [reason, ...rest] = stored.split(": ");
    expect(connectorMessage("fa", { ok: false, reason, message: rest.join(": ") })).toMatch(/`Zone → DNS → Read`$/);
  });

  it("hands the connect screens every string their keys name", () => {
    for (const locale of ["fa", "en"] as const) {
      const s = connectStrings(translator(locale));
      for (const [key, value] of Object.entries(s)) expect(value, key).not.toBe(key);
      expect(s.cn_consent.length).toBeGreaterThan(20);
      expect(s.pv_title).toBeTruthy();
    }
  });
});
