/**
 * Every outside dependency of the services, in one object with production
 * defaults. Tests pass fakes (a fake Search Console, a PSI or DataForSEO double
 * on a local port, a clock); nothing else in the services reaches out directly.
 */
import { dataForSeo, type DataForSeoClient, type DataForSeoCredentials } from "./providers/dataforseo.js";
import { pageSpeedInsights, type PageSpeedClient } from "./providers/pagespeed.js";
import { googleSuggest, type SuggestClient } from "./providers/autocomplete.js";
import { telegram, type TelegramClient, type TelegramCredentials } from "./providers/telegram.js";
import { connectorGsc, type GscSource } from "./providers/gsc.js";

export type Deps = {
  gsc: GscSource;
  suggest: SuggestClient;
  dataForSeo: (creds: DataForSeoCredentials) => DataForSeoClient;
  pageSpeed: (opts: { apiKey: string | null }) => PageSpeedClient;
  telegram: (creds: TelegramCredentials) => TelegramClient;
  now: () => Date;
  /** Where a competitor's site is fetched from, given its stored domain. */
  competitorUrl: (domain: string) => string;
};

export const defaultDeps: Deps = {
  gsc: connectorGsc,
  suggest: googleSuggest(),
  dataForSeo: (creds) => dataForSeo(creds),
  pageSpeed: ({ apiKey }) => pageSpeedInsights({ apiKey }),
  telegram: (creds) => telegram(creds),
  now: () => new Date(),
  competitorUrl: (domain) => localCompetitorUrl(domain) ?? `https://${domain}/`,
};

/**
 * Local development only: with ALLOW_PRIVATE_NETWORK=1 (never set in
 * production), COMPETITOR_URL_TEMPLATE (e.g. "http://127.0.0.1:4555/" or
 * "http://{domain}:8080/") points competitor sampling at a site on this
 * machine, which a bare stored domain fetched over https cannot reach.
 */
function localCompetitorUrl(domain: string): string | null {
  const template = process.env.ALLOW_PRIVATE_NETWORK === "1" ? process.env.COMPETITOR_URL_TEMPLATE : undefined;
  return template ? template.replaceAll("{domain}", domain) : null;
}

export function withDeps(partial: Partial<Deps> = {}): Deps {
  return { ...defaultDeps, ...partial };
}
