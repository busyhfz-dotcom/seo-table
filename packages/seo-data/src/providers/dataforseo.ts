/**
 * DataForSEO v3 (https://docs.dataforseo.com/v3/) — keyword volume, ideas and
 * difficulty, live Google SERPs, ranked keywords and a backlink summary.
 *
 * Auth is HTTP Basic with the API login and password (not the dashboard
 * password). Every POST takes an array of tasks; this client sends one task per
 * request and reads `tasks[0]`. The envelope carries `cost` in USD for the
 * request, which is passed back so the panel can show it.
 *
 * Endpoints used (all "live", i.e. answered in the same request):
 *   GET  appendix/user_data                                   — free; login and balance
 *   POST keywords_data/google_ads/search_volume/live          — ≤1000 keywords
 *   POST dataforseo_labs/google/keyword_ideas/live            — ≤200 seeds
 *   POST dataforseo_labs/google/bulk_keyword_difficulty/live  — ≤1000 keywords
 *   POST dataforseo_labs/google/ranked_keywords/live          — a domain's organic keywords
 *   POST serp/google/organic/live/advanced                    — one SERP with every element type
 *   POST backlinks/summary/live                               — needs the Backlinks subscription
 *
 * Markets: location_code is the Google Ads geo target (2000 + ISO numeric;
 * Iran = 2364) and language_code the ISO 639-1 code ("fa" for Persian). Google
 * Ads does not serve Iran, so volume data for IR usually comes back empty or
 * refused; SERP checks for IR/fa work. Empty is reported as empty — never
 * filled in.
 */
import { dataForSeoLocation } from "../countries.js";
import { fetchJson, ProviderError } from "../http.js";
import type {
  BacklinkProvider,
  BacklinkSummary,
  KeywordDataProvider,
  KeywordMetrics,
  Market,
  Priced,
  ProviderCheck,
  RankedKeyword,
  SerpItem,
  SerpProvider,
  SerpResult,
} from "./types.js";

export type DataForSeoCredentials = { login: string; password: string };

export const DATAFORSEO_API = "https://api.dataforseo.com/v3";

type Envelope<R> = {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{ status_code?: number; status_message?: string; cost?: number; result?: R[] | null }>;
};

/** DataForSEO status codes (appendix/errors) → the reasons the panel explains. */
export function dataForSeoReason(code: number | undefined, httpStatus: number): string {
  if (httpStatus === 401 || (code !== undefined && code >= 40100 && code < 40200)) return "invalid_credentials";
  if (code === 40200 || code === 40210 || httpStatus === 402) return "insufficient_funds";
  if (code === 40202 || code === 40209 || httpStatus === 429) return "rate_limited";
  if (code === 40204 || code === 40203 || httpStatus === 403) return "access_denied";
  if (code === 40501 || code === 40503) return "invalid_request";
  return "provider_error";
}

export type DataForSeoClient = KeywordDataProvider &
  SerpProvider &
  BacklinkProvider & {
    check(): Promise<ProviderCheck>;
  };

export function dataForSeo(creds: DataForSeoCredentials, opts: { baseUrl?: string } = {}): DataForSeoClient {
  const base = (opts.baseUrl ?? DATAFORSEO_API).replace(/\/$/, "");
  const authorization = `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`;

  function location(market: Market): number {
    const code = dataForSeoLocation(market.country);
    if (code === null) {
      throw new ProviderError("location_unsupported", `No DataForSEO location code for country ${market.country}`, {
        country: market.country,
      });
    }
    return code;
  }

  async function call<R>(path: string, task?: Record<string, unknown>): Promise<Priced<R[]>> {
    const res = await fetchJson<Envelope<R>>(`${base}/${path}`, {
      method: task ? "POST" : "GET",
      headers: { authorization, "content-type": "application/json" },
      body: task ? JSON.stringify([task]) : undefined,
      timeoutMs: 120_000,
    });
    const env = res.data;
    const top = env?.status_code;
    if (res.status >= 400 || !env || (top !== undefined && top !== 20000)) {
      const reason = dataForSeoReason(top, res.status);
      throw new ProviderError(reason, `DataForSEO ${path}: ${env?.status_message ?? `HTTP ${res.status}`}`, {
        status: res.status,
        code: top ?? null,
      });
    }
    const t = env.tasks?.[0];
    const cost = typeof env.cost === "number" ? env.cost : typeof t?.cost === "number" ? t.cost : null;
    // 40102 "No Search Results": a valid answer that happens to be empty.
    if (t && t.status_code !== undefined && t.status_code !== 20000 && t.status_code !== 40102) {
      let reason = dataForSeoReason(t.status_code, res.status);
      if (reason === "invalid_request" && /location|language/i.test(t.status_message ?? "")) reason = "location_unsupported";
      throw new ProviderError(reason, `DataForSEO ${path}: ${t.status_message ?? "task failed"}`, { code: t.status_code });
    }
    return { value: t?.result ?? [], cost };
  }

  async function check(): Promise<ProviderCheck> {
    try {
      const { value } = await call<{ login?: string; money?: { balance?: number } }>("appendix/user_data");
      const user = value[0];
      const balance = typeof user?.money?.balance === "number" ? user.money.balance : null;
      if (balance !== null && balance <= 0) {
        return {
          ok: false,
          reason: "insufficient_funds",
          message: "The DataForSEO balance is empty; top it up before requests can run.",
          detail: { login: user?.login ?? creds.login, balance },
        };
      }
      return {
        ok: true,
        message: `Connected as ${user?.login ?? creds.login}.`,
        detail: { login: user?.login ?? creds.login, balance },
      };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, reason: err.reason, message: err.message };
      return { ok: false, reason: "network_error", message: (err as Error).message };
    }
  }

  type AdsRow = {
    keyword?: string;
    search_volume?: number | null;
    cpc?: number | null;
    competition_index?: number | null;
    monthly_searches?: Array<{ year?: number; month?: number; search_volume?: number | null }> | null;
  };

  async function searchVolume(keywords: string[], market: Market): Promise<Priced<KeywordMetrics[]>> {
    const { value, cost } = await call<AdsRow>("keywords_data/google_ads/search_volume/live", {
      keywords: keywords.slice(0, 1000),
      location_code: location(market),
      language_code: market.language,
    });
    return {
      cost,
      value: value.map((r) => ({
        keyword: r.keyword ?? "",
        volume: r.search_volume ?? null,
        cpc: r.cpc ?? null,
        competition: r.competition_index ?? null,
        difficulty: null,
        monthly: (r.monthly_searches ?? []).map((m) => ({ year: m.year ?? 0, month: m.month ?? 0, volume: m.search_volume ?? null })),
      })),
    };
  }

  type LabsKeyword = {
    keyword?: string;
    keyword_info?: {
      search_volume?: number | null;
      cpc?: number | null;
      competition?: number | null;
      monthly_searches?: Array<{ year?: number; month?: number; search_volume?: number | null }> | null;
    } | null;
    keyword_properties?: { keyword_difficulty?: number | null } | null;
  };

  function labsMetrics(k: LabsKeyword): KeywordMetrics {
    const info = k.keyword_info ?? {};
    return {
      keyword: k.keyword ?? "",
      volume: info.search_volume ?? null,
      cpc: info.cpc ?? null,
      // Labs reports competition 0–1; the panel shows the Ads-style index.
      competition: typeof info.competition === "number" ? Math.round(info.competition * 100) : null,
      difficulty: k.keyword_properties?.keyword_difficulty ?? null,
      monthly: (info.monthly_searches ?? []).map((m) => ({ year: m.year ?? 0, month: m.month ?? 0, volume: m.search_volume ?? null })),
    };
  }

  async function keywordIdeas(seeds: string[], market: Market, limit: number): Promise<Priced<KeywordMetrics[]>> {
    const { value, cost } = await call<{ items?: LabsKeyword[] | null }>("dataforseo_labs/google/keyword_ideas/live", {
      keywords: seeds.slice(0, 200),
      location_code: location(market),
      language_code: market.language,
      limit: Math.min(Math.max(limit, 1), 1000),
    });
    return { cost, value: (value[0]?.items ?? []).map(labsMetrics).filter((k) => k.keyword) };
  }

  async function keywordDifficulty(
    keywords: string[],
    market: Market,
  ): Promise<Priced<Array<{ keyword: string; difficulty: number | null }>>> {
    const { value, cost } = await call<{ items?: Array<{ keyword?: string; keyword_difficulty?: number | null }> | null }>(
      "dataforseo_labs/google/bulk_keyword_difficulty/live",
      { keywords: keywords.slice(0, 1000), location_code: location(market), language_code: market.language },
    );
    return {
      cost,
      value: (value[0]?.items ?? []).map((i) => ({ keyword: i.keyword ?? "", difficulty: i.keyword_difficulty ?? null })),
    };
  }

  async function rankedKeywords(domain: string, market: Market, limit: number): Promise<Priced<RankedKeyword[]>> {
    type Item = {
      keyword_data?: LabsKeyword | null;
      ranked_serp_element?: { serp_item?: { rank_group?: number; url?: string | null } | null } | null;
    };
    const { value, cost } = await call<{ items?: Item[] | null }>("dataforseo_labs/google/ranked_keywords/live", {
      target: domain,
      location_code: location(market),
      language_code: market.language,
      limit: Math.min(Math.max(limit, 1), 1000),
      item_types: ["organic"],
    });
    return {
      cost,
      value: (value[0]?.items ?? [])
        .map((i) => {
          const m = labsMetrics(i.keyword_data ?? {});
          return {
            keyword: m.keyword,
            position: i.ranked_serp_element?.serp_item?.rank_group ?? 0,
            url: i.ranked_serp_element?.serp_item?.url ?? null,
            volume: m.volume,
            difficulty: m.difficulty,
          };
        })
        .filter((k) => k.keyword && k.position > 0),
    };
  }

  async function serp(query: {
    keyword: string;
    market: Market;
    device: "desktop" | "mobile";
    depth: number;
  }): Promise<Priced<SerpResult>> {
    type Raw = {
      keyword?: string;
      item_types?: string[] | null;
      se_results_count?: number | null;
      items?: Array<{
        type?: string;
        rank_group?: number;
        rank_absolute?: number;
        url?: string | null;
        domain?: string | null;
        title?: string | null;
      }> | null;
    };
    const { value, cost } = await call<Raw>("serp/google/organic/live/advanced", {
      keyword: query.keyword,
      location_code: location(query.market),
      language_code: query.market.language,
      device: query.device,
      depth: Math.min(Math.max(query.depth, 10), 100),
    });
    const r = value[0];
    const items: SerpItem[] = (r?.items ?? []).map((i) => ({
      type: i.type ?? "unknown",
      rankGroup: i.rank_group ?? 0,
      rankAbsolute: i.rank_absolute ?? 0,
      url: i.url ?? null,
      domain: i.domain ?? null,
      title: i.title ?? null,
    }));
    return {
      cost,
      value: {
        keyword: r?.keyword ?? query.keyword,
        features: [...new Set((r?.item_types ?? []).filter((t) => t !== "organic"))],
        items,
        totalResults: r?.se_results_count ?? null,
      },
    };
  }

  async function backlinkSummary(domain: string): Promise<Priced<BacklinkSummary>> {
    type Raw = {
      target?: string;
      rank?: number | null;
      backlinks?: number | null;
      referring_domains?: number | null;
      referring_main_domains?: number | null;
      broken_backlinks?: number | null;
      backlinks_spam_score?: number | null;
    };
    const { value, cost } = await call<Raw>("backlinks/summary/live", { target: domain, include_subdomains: true });
    const r = value[0] ?? {};
    return {
      cost,
      value: {
        target: r.target ?? domain,
        backlinks: r.backlinks ?? null,
        referringDomains: r.referring_domains ?? null,
        referringMainDomains: r.referring_main_domains ?? null,
        brokenBacklinks: r.broken_backlinks ?? null,
        rank: r.rank ?? null,
        spamScore: r.backlinks_spam_score ?? null,
      },
    };
  }

  return {
    provider: "dataforseo",
    check,
    searchVolume,
    keywordIdeas,
    keywordDifficulty,
    rankedKeywords,
    serp,
    backlinkSummary,
  };
}
