/**
 * Paid-data provider interfaces. The panel codes against these, never against
 * a vendor, so a second vendor is one more implementation — and a feature with
 * no configured provider says "not configured" instead of showing numbers.
 *
 * Every call reports the cost the vendor charged for it (null when the vendor
 * does not say), so research spend is visible per request.
 */

/** A search market: ISO 3166-1 alpha-2 country and a language code ("fa", "en"). */
export type Market = { country: string; language: string };

export type Priced<T> = { value: T; cost: number | null };

export type KeywordMetrics = {
  keyword: string;
  /** Average monthly searches (Google Ads). null = the vendor has no figure. */
  volume: number | null;
  cpc: number | null;
  /** Google Ads competition index, 0–100. */
  competition: number | null;
  /** 0–100 ranking difficulty, where the vendor supplies one. */
  difficulty: number | null;
  monthly: Array<{ year: number; month: number; volume: number | null }>;
};

export type RankedKeyword = {
  keyword: string;
  position: number;
  url: string | null;
  volume: number | null;
  difficulty: number | null;
};

export type SerpItem = {
  /** "organic", "featured_snippet", "local_pack", "people_also_ask", … as the vendor names it. */
  type: string;
  /** Position among items of the same type (the "organic rank" for organic items). */
  rankGroup: number;
  /** Position counting every element on the page. */
  rankAbsolute: number;
  url: string | null;
  domain: string | null;
  title: string | null;
};

export type SerpResult = {
  keyword: string;
  /** Element types present on the page, excluding plain organic results. */
  features: string[];
  items: SerpItem[];
  totalResults: number | null;
};

export type BacklinkSummary = {
  target: string;
  backlinks: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  brokenBacklinks: number | null;
  /** The vendor's own authority rank (DataForSEO: 0–1000). */
  rank: number | null;
  spamScore: number | null;
};

export interface KeywordDataProvider {
  readonly provider: string;
  searchVolume(keywords: string[], market: Market): Promise<Priced<KeywordMetrics[]>>;
  keywordIdeas(seeds: string[], market: Market, limit: number): Promise<Priced<KeywordMetrics[]>>;
  keywordDifficulty(keywords: string[], market: Market): Promise<Priced<Array<{ keyword: string; difficulty: number | null }>>>;
  /** Keywords a domain ranks for in organic results. */
  rankedKeywords(domain: string, market: Market, limit: number): Promise<Priced<RankedKeyword[]>>;
}

export interface SerpProvider {
  readonly provider: string;
  serp(query: { keyword: string; market: Market; device: "desktop" | "mobile"; depth: number }): Promise<Priced<SerpResult>>;
}

export interface BacklinkProvider {
  readonly provider: string;
  backlinkSummary(domain: string): Promise<Priced<BacklinkSummary>>;
}

export type ProviderCheck = {
  ok: boolean;
  /** invalid_credentials | insufficient_funds | access_denied | rate_limited | network_error | provider_error */
  reason?: string;
  message?: string;
  /** Facts safe to show and store (account login, balance, bot name) — never a secret. */
  detail?: Record<string, unknown>;
};
