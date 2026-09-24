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
import { COMMON } from "./common-strings";
import {
  ALERT_KIND_HELP,
  ALERT_KIND_LABELS,
  ALERT_THRESHOLD_UNIT,
  ANCHOR_SOURCE,
  CHANNEL_LABELS,
  CWV_RATING,
  INTEGRATION_LABELS,
  ISSUE_LEVEL,
  LIGHTHOUSE_AUDITS,
  LINK_REASON,
  PUBLISH_STATUS,
  REPORT_KIND_HELP,
  REPORT_KIND_LABELS,
  SCHEDULE_KIND_LABELS,
  SCHEMA_TYPE_LABELS,
  SERP_FEATURES,
  SITEMAP_PROBLEMS,
  SITEMAP_SOURCE_KIND,
  localized,
} from "./seo-labels";
import { KEYWORDS } from "../app/(app)/keywords/strings";
import { PAGESPEED } from "../app/(app)/pagespeed/strings";
import { COMPETITORS } from "../app/(app)/competitors/strings";
import { CONTENT } from "../app/(app)/content/strings";
import { SCHEMA_ENUMS, SCHEMA_FIELDS, TOOLS } from "../app/(app)/tools/strings";
import { REPORTS } from "../app/(app)/reports/strings";
import { ALERTS } from "../app/(app)/alerts/strings";
import { INTEGRATIONS } from "../app/(app)/settings/integrations-strings";

const KEEP_LATIN = [
  "SEO Table", "WordPress", "Cloudflare", "Search Console", "Google", "GA4", "API", "REST", "URL", "HTML", "HTTP",
  "H1", "H2", "robots.txt", "sitemap.xml", "JSON-LD", "JSON", "canonical", "hreflang", "noindex", "nofollow", "alt",
  "robots", "Worker", "Workers Routes", "Workers", "KV", "DNS", "Application Passwords", "Application Password",
  "Rank Math", "Yoast SEO", "Yoast", "SEOPress", "All in One SEO", "Instagram", "YouTube", "Chromium", "LCP", "CLS",
  "TTFB", "CTR", "OAuth", "Redis", "nginx", "Apache", ".htaccess", "Bridge", "Owner", "Full", "Viewer", "Wordfence",
  "Solid Security", "iThemes", "All In One WP Security", "Redirection", "CMS", "Global API Key", "My Profile",
  "API Tokens", "sc-domain", "webmasters", "wp-content", "mu-plugins", "Authorization", "JavaScript", "URL",
  // SEO data features: vendors, Google's metric names and file formats.
  "DataForSEO", "PageSpeed Insights", "PageSpeed", "Core Web Vitals", "Lighthouse", "INP", "FCP", "TBT", "CSS",
  "Googlebot", "Bingbot", "PDF", "H3",
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

describe("SEO data screens' wording", () => {
  const dicts: Record<string, Record<"fa" | "en", Record<string, string>>> = {
    COMMON,
    KEYWORDS,
    PAGESPEED,
    COMPETITORS,
    CONTENT,
    TOOLS,
    SCHEMA_FIELDS,
    SCHEMA_ENUMS,
    REPORTS,
    ALERTS,
    INTEGRATIONS,
  };

  it("has both languages for every key, Persian clean and English free of Persian", () => {
    for (const [name, dict] of Object.entries(dicts)) {
      expect(Object.keys(dict.en).sort(), name).toEqual(Object.keys(dict.fa).sort());
      for (const [key, text] of Object.entries(dict.fa)) persianClean(`${name}.${key}`, text);
      for (const [key, text] of Object.entries(dict.en)) expect(text, `${name}.${key}`).not.toMatch(/[؀-ۿ]/);
    }
  });

  it("does the same for the SEO data labels", () => {
    const tables = {
      ALERT_KIND_LABELS,
      ALERT_KIND_HELP,
      CHANNEL_LABELS,
      SCHEDULE_KIND_LABELS,
      CWV_RATING,
      LIGHTHOUSE_AUDITS,
      SITEMAP_PROBLEMS,
      SITEMAP_SOURCE_KIND,
      SERP_FEATURES,
      SCHEMA_TYPE_LABELS,
      REPORT_KIND_LABELS,
      REPORT_KIND_HELP,
      PUBLISH_STATUS,
      LINK_REASON,
      ANCHOR_SOURCE,
      ISSUE_LEVEL,
      INTEGRATION_LABELS,
    };
    for (const [name, table] of Object.entries(tables)) {
      for (const [id, pair] of Object.entries(table)) {
        persianClean(`${name}.${id}`, pair.fa);
        expect(pair.en, `${name}.${id}`).not.toMatch(/[؀-ۿ]/);
      }
    }
    for (const unit of Object.values(ALERT_THRESHOLD_UNIT)) if (unit) persianClean("unit", unit.fa);
  });

  it("names the site-document fix actions", () => {
    for (const action of ["SCHEMA_MARKUP", "ROBOTS_TXT", "SITEMAP_XML"]) {
      for (const table of [ACTION_LABELS, FIX_TITLES, FIX_WHY]) expect(table[action], action).toBeDefined();
    }
  });

  it("puts server-worded Persian messages in Persian digits, keeping names like H2", () => {
    expect(localized({ fa: "تکرار ۱ و 2.5٪ در H2", en: "x" }, "fa")).toBe("تکرار ۱ و ۲.۵٪ در H2");
    expect(localized({ fa: "x", en: "2 words" }, "en")).toBe("2 words");
  });
});
