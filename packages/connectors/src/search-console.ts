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

async function auth(creds: SearchConsoleCredentials): Promise<Record<string, string>> {
  const token = await accessToken(creds.google, [...SCOPES.searchConsole]);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export function searchConsole(creds: SearchConsoleCredentials): Connector & {
  queries: (range: { start: Date; end: Date }, limit?: number) => Promise<QueryRow[]>;
  opportunities: (range: { start: Date; end: Date }) => Promise<Opportunity[]>;
  indexedPages: (range: { start: Date; end: Date }, limit?: number) => Promise<Set<string>>;
} {
  async function capabilities(): Promise<ConnectorCapabilities> {
    return {
      writableFields: [],
      supportedActions: [],
      notes: [
        "Read-only. Supplies query, impression, click and position data for Content Opportunities.",
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

  return { kind: "SEARCH_CONSOLE", check, capabilities, queries, opportunities, indexedPages };
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
