/**
 * Google Search Console connector.
 *
 * Real Search Analytics queries against the v3 API. Content Opportunities is
 * built entirely from these rows — if the connector is not connected, that screen
 * has no data, and nothing is invented to fill it.
 */
import type { Severity } from "@seo/db";
import { accessToken, SCOPES, type GoogleCredentials } from "./google-auth.js";
import {
  ConnectorError,
  httpJson,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorHealth,
} from "./types.js";

const API = "https://searchconsole.googleapis.com/webmasters/v3";
const INSPECT_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export type SearchConsoleCredentials = {
  /** e.g. "sc-domain:example.ir" or "https://shop.example.ir/" */
  siteUrl: string;
  google: GoogleCredentials;
};

export type QueryRow = {
  query: string;
  page: string | null;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
};

/** Stable machine codes for the suggestion; the UI translates them, the English text is a fallback. */
export type SuggestedActionCode =
  | "create_or_index_page"
  | "rewrite_title_and_meta"
  | "expand_content_and_links"
  | "test_clearer_title"
  | "none";

export type Opportunity = QueryRow & {
  gap: Severity;
  suggestedAction: string;
  suggestedActionCode: SuggestedActionCode;
};

/** The API's hard maximum rows per request; larger sets page with startRow. */
const PAGE_ROWS = 25_000;

async function auth(creds: SearchConsoleCredentials, scopes: readonly string[] = SCOPES.searchConsole): Promise<Record<string, string>> {
  const token = await accessToken(creds.google, [...scopes]);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** URL Inspection, reduced to what the panel shows. Field values are Google's own enums. */
export type UrlInspection = {
  url: string;
  /** PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED */
  verdict: string | null;
  /** Google's sentence, e.g. "Submitted and indexed" (English, as Google sends it). */
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  crawledAs: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  sitemaps: string[];
  referringUrls: string[];
  mobileUsabilityVerdict: string | null;
  richResults: { verdict: string | null; types: string[] };
  /** Opens the same report in Search Console. */
  inspectionResultLink: string | null;
};

type InspectResponse = {
  inspectionResult?: {
    inspectionResultLink?: string;
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      indexingState?: string;
      robotsTxtState?: string;
      pageFetchState?: string;
      lastCrawlTime?: string;
      crawledAs?: string;
      googleCanonical?: string;
      userCanonical?: string;
      sitemap?: string[];
      referringUrls?: string[];
    };
    mobileUsabilityResult?: { verdict?: string };
    richResultsResult?: { verdict?: string; detectedItems?: Array<{ richResultType?: string }> };
  };
  error?: { message?: string; status?: string };
};

/**
 * Whether `url` belongs to the property: a domain property ("sc-domain:x")
 * covers x and its subdomains on any scheme; a URL-prefix property covers
 * addresses that start with it.
 */
export function inProperty(siteUrl: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
    const host = u.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return url.startsWith(siteUrl);
}

/** Google's error body, mapped to a reason the panel explains. */
function googleFailure(status: number, text: string, what: string): ConnectorError {
  let reason = `http_${status}`;
  if (status === 403 && /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) reason = "insufficient_scope";
  else if (status === 403) reason = "insufficient_permission";
  else if (status === 429) reason = "quota_exceeded";
  else if (status === 404) reason = "site_not_found";
  return new ConnectorError(reason, `${what} failed (HTTP ${status}): ${text.slice(0, 200)}`);
}

/**
 * A raw Search Analytics request. Filters follow the API: country is ISO 3166-1
 * alpha-3 in lower case ("irn"), device is DESKTOP | MOBILE | TABLET, and
 * `includingRegex` takes RE2 syntax. Filters in one group are ANDed.
 */
export type SearchAnalyticsRequest = {
  start: Date;
  end: Date;
  dimensions: Array<"query" | "page" | "date" | "country" | "device">;
  filters?: Array<{
    dimension: "query" | "page" | "country" | "device";
    operator: "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
    expression: string;
  }>;
  /** Total rows wanted; paged 25,000 at a time. Default 25,000. */
  limit?: number;
};

export type SearchAnalyticsRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type SearchConsoleClient = Connector & {
  /** Search Analytics with dimensions and filters of the caller's choosing. */
  searchAnalytics: (req: SearchAnalyticsRequest) => Promise<SearchAnalyticsRow[]>;
  queries: (range: { start: Date; end: Date }, limit?: number) => Promise<QueryRow[]>;
  opportunities: (range: { start: Date; end: Date }) => Promise<Opportunity[]>;
  indexedPages: (range: { start: Date; end: Date }, limit?: number) => Promise<Set<string>>;
  submitSitemap: (sitemapUrl: string) => Promise<void>;
  inspectUrl: (url: string, languageCode?: string) => Promise<UrlInspection>;
};

export function searchConsole(creds: SearchConsoleCredentials): SearchConsoleClient {
  async function capabilities(): Promise<ConnectorCapabilities> {
    return {
      writableFields: [],
      supportedActions: [],
      notes: [
        "Supplies query, impression, click and position data for Content Opportunities, inspects URLs, and submits sitemaps (submitting needs Owner or Full access).",
      ],
    };
  }

  async function check(): Promise<ConnectorHealth & { capabilities?: ConnectorCapabilities }> {
    try {
      const headers = await auth(creds);
      const res = await httpJson<{ siteUrl?: string; permissionLevel?: string }>(
        `${API}/sites/${encodeURIComponent(creds.siteUrl)}`,
        { headers },
      );
      if (res.status === 403) {
        return {
          ok: false,
          reason: "no_site_access",
          message: `The credential has no access to ${creds.siteUrl}. Add it as a user in Search Console.`,
        };
      }
      if (res.status === 404) {
        return { ok: false, reason: "site_not_found", message: `${creds.siteUrl} is not a property on this account.` };
      }
      if (res.status >= 400) {
        return { ok: false, reason: `http_${res.status}`, message: res.text.slice(0, 200) };
      }
      return {
        ok: true,
        message: `Connected to ${res.data?.siteUrl ?? creds.siteUrl} (${res.data?.permissionLevel ?? "unknown"}).`,
        capabilities: await capabilities(),
      };
    } catch (err) {
      if (err instanceof ConnectorError) return { ok: false, reason: err.code, message: err.message };
      return { ok: false, reason: "network_error", message: (err as Error).message };
    }
  }

  /**
   * Page through searchAnalytics/query until `limit` rows or the data runs out.
   * dataState "all" includes the fresh (not yet finalised) days, which is what
   * the last-28-days window the product shows is made of.
   */
  async function queryPages(
    range: { start: Date; end: Date },
    dimensions: string[],
    limit: number,
    onRow: (row: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }) => void,
    filters?: SearchAnalyticsRequest["filters"],
  ): Promise<void> {
    const headers = await auth(creds);
    let startRow = 0;
    while (startRow < limit) {
      const rowLimit = Math.min(PAGE_ROWS, limit - startRow);
      const res = await httpJson<{
        rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
      }>(`${API}/sites/${encodeURIComponent(creds.siteUrl)}/searchAnalytics/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          startDate: iso(range.start),
          endDate: iso(range.end),
          dimensions,
          rowLimit,
          startRow,
          dataState: "all",
          ...(filters?.length ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}),
        }),
        timeoutMs: 40_000,
      });

      if (res.status >= 400) {
        throw new ConnectorError(`http_${res.status}`, `Search Console query failed: ${res.text.slice(0, 200)}`);
      }
      const batch = res.data?.rows ?? [];
      for (const row of batch) onRow(row);
      startRow += batch.length;
      // A short page is the last one.
      if (batch.length < rowLimit) break;
    }
  }

  async function searchAnalytics(req: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    const rows: SearchAnalyticsRow[] = [];
    await queryPages(
      { start: req.start, end: req.end },
      req.dimensions,
      req.limit ?? PAGE_ROWS,
      (row) =>
        rows.push({
          keys: row.keys ?? [],
          clicks: row.clicks ?? 0,
          impressions: row.impressions ?? 0,
          ctr: row.ctr ?? 0,
          position: row.position ?? 0,
        }),
      req.filters,
    );
    return rows;
  }

  async function queries(range: { start: Date; end: Date }, limit = 1000): Promise<QueryRow[]> {
    const rows: QueryRow[] = [];
    await queryPages(range, ["query", "page"], limit, (row) => {
      rows.push({
        query: row.keys?.[0] ?? "",
        page: row.keys?.[1] ?? null,
        impressions: row.impressions ?? 0,
        clicks: row.clicks ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      });
    });
    return rows;
  }

  /**
   * Turn query rows into ranked opportunities. The scoring is deliberately
   * explainable: demand the site already has, minus the clicks it captures.
   */
  async function opportunities(range: { start: Date; end: Date }): Promise<Opportunity[]> {
    const rows = await queries(range, 5000);
    const byQuery = new Map<string, QueryRow>();
    for (const row of rows) {
      if (!row.query) continue;
      const existing = byQuery.get(row.query);
      if (!existing) {
        byQuery.set(row.query, { ...row });
        continue;
      }
      const impressions = existing.impressions + row.impressions;
      byQuery.set(row.query, {
        query: row.query,
        page: existing.impressions >= row.impressions ? existing.page : row.page,
        impressions,
        clicks: existing.clicks + row.clicks,
        ctr: impressions > 0 ? (existing.clicks + row.clicks) / impressions : 0,
        position:
          impressions > 0
            ? (existing.position * existing.impressions + row.position * row.impressions) / impressions
            : existing.position,
      });
    }

    const out: Opportunity[] = [];
    for (const row of byQuery.values()) {
      if (row.impressions < 50) continue;
      const { gap, suggestedAction, suggestedActionCode } = classify(row);
      if (gap === "INFO") continue;
      out.push({ ...row, gap, suggestedAction, suggestedActionCode });
    }
    return out.sort((a, b) => b.impressions - a.impressions);
  }

  async function indexedPages(range: { start: Date; end: Date }, limit = 200_000): Promise<Set<string>> {
    const pages = new Set<string>();
    await queryPages(range, ["page"], limit, (row) => {
      if (row.keys?.[0]) pages.add(row.keys[0]);
    });
    return pages;
  }

  /**
   * Submit (or resubmit) a sitemap: PUT sites/{site}/sitemaps/{feedpath}.
   * Needs the full webmasters scope and Owner or Full permission on the property.
   */
  async function submitSitemap(sitemapUrl: string): Promise<void> {
    if (!inProperty(creds.siteUrl, sitemapUrl)) {
      throw new ConnectorError("sitemap_outside_property", `${sitemapUrl} is not inside the Search Console property ${creds.siteUrl}.`);
    }
    const headers = await auth(creds, SCOPES.searchConsoleWrite);
    const res = await httpJson<unknown>(
      `${API}/sites/${encodeURIComponent(creds.siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
      { method: "PUT", headers },
    );
    if (res.status >= 400) throw googleFailure(res.status, res.text, "Submitting the sitemap");
  }

  /** URL Inspection API: Google's index status for one URL (read-only scope; 2,000 a day per property). */
  async function inspectUrl(url: string, languageCode = "en-US"): Promise<UrlInspection> {
    if (!inProperty(creds.siteUrl, url)) {
      throw new ConnectorError("url_outside_property", `${url} is not inside the Search Console property ${creds.siteUrl}.`);
    }
    const headers = await auth(creds);
    const res = await httpJson<InspectResponse>(INSPECT_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ inspectionUrl: url, siteUrl: creds.siteUrl, languageCode }),
      timeoutMs: 40_000,
    });
    if (res.status >= 400 || !res.data?.inspectionResult) throw googleFailure(res.status, res.text, "URL inspection");
    const r = res.data.inspectionResult;
    const index = r.indexStatusResult ?? {};
    return {
      url,
      verdict: index.verdict ?? null,
      coverageState: index.coverageState ?? null,
      indexingState: index.indexingState ?? null,
      robotsTxtState: index.robotsTxtState ?? null,
      pageFetchState: index.pageFetchState ?? null,
      lastCrawlTime: index.lastCrawlTime ?? null,
      crawledAs: index.crawledAs ?? null,
      googleCanonical: index.googleCanonical ?? null,
      userCanonical: index.userCanonical ?? null,
      sitemaps: index.sitemap ?? [],
      referringUrls: index.referringUrls ?? [],
      mobileUsabilityVerdict: r.mobileUsabilityResult?.verdict ?? null,
      richResults: {
        verdict: r.richResultsResult?.verdict ?? null,
        types: [...new Set((r.richResultsResult?.detectedItems ?? []).map((i) => i.richResultType).filter((t): t is string => Boolean(t)))],
      },
      inspectionResultLink: r.inspectionResultLink ?? null,
    };
  }

  return { kind: "SEARCH_CONSOLE", check, capabilities, searchAnalytics, queries, opportunities, indexedPages, submitSitemap, inspectUrl };
}

/** Explainable buckets — each one names the actual shape of the gap. */
function classify(row: QueryRow): { gap: Severity; suggestedAction: string; suggestedActionCode: SuggestedActionCode } {
  if (row.position > 15 && row.impressions >= 500) {
    return {
      gap: "CRITICAL",
      suggestedActionCode: "create_or_index_page",
      suggestedAction: "High demand but ranking past page one — check whether a page for this query exists and is indexable",
    };
  }
  if (row.position <= 10 && row.ctr < 0.02 && row.impressions >= 300) {
    return {
      gap: "SERIOUS",
      suggestedActionCode: "rewrite_title_and_meta",
      suggestedAction: "Ranks on page one but is rarely clicked — rewrite the title and meta description",
    };
  }
  if (row.position > 10 && row.position <= 15) {
    return {
      gap: "SERIOUS",
      suggestedActionCode: "expand_content_and_links",
      suggestedAction: "Just below page one — expand the content and add internal links",
    };
  }
  if (row.position <= 5 && row.ctr < 0.05) {
    return {
      gap: "WARNING",
      suggestedAction: "Strong position, weak click-through — test a clearer title",
      suggestedActionCode: "test_clearer_title",
    };
  }
  return { gap: "INFO", suggestedAction: "No action needed", suggestedActionCode: "none" };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
