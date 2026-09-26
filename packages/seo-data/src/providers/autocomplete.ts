/**
 * Google's autocomplete ("suggest") endpoint: what people type after a seed.
 * Free and unauthenticated, but it carries NO volume data — the panel labels
 * these "suggestions — no volume data" and never attaches numbers to them.
 * It is an unofficial endpoint, so a failure is reported, not retried hard.
 */
import { fetchJson, ProviderError } from "../http.js";

export const SUGGEST_API = "https://suggestqueries.google.com/complete/search";

export type SuggestClient = {
  suggest(seed: string, market: { language: string; country: string }): Promise<string[]>;
};

export function googleSuggest(opts: { baseUrl?: string } = {}): SuggestClient {
  const base = opts.baseUrl ?? SUGGEST_API;
  return {
    async suggest(seed, market) {
      const params = new URLSearchParams({
        client: "firefox",
        q: seed,
        hl: market.language,
        gl: market.country.toLowerCase(),
        ie: "utf-8",
        oe: "utf-8",
      });
      const res = await fetchJson<unknown>(`${base}?${params}`, {
        timeoutMs: 10_000,
        maxBytes: 256 * 1024,
        headers: { accept: "application/json" },
      });
      if (res.status >= 400) throw new ProviderError(res.status === 429 ? "rate_limited" : "provider_error", `Suggest answered HTTP ${res.status}`);
      // Shape: [seed, [suggestion, …], …]
      const list = Array.isArray(res.data) && Array.isArray(res.data[1]) ? (res.data[1] as unknown[]) : null;
      if (!list) throw new ProviderError("provider_error", "Suggest answered in an unexpected shape");
      return [...new Set(list.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()))];
    },
  };
}
