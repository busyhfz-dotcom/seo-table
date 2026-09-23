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
  competitorUrl: (domain) => `https://${domain}/`,
};

export function withDeps(partial: Partial<Deps> = {}): Deps {
  return { ...defaultDeps, ...partial };
}
