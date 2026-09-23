/**
 * @seo/seo-data — keyword, rank, PageSpeed, competitor, schedule, alert and
 * notification services, and the data providers behind them.
 */
export { withDeps, defaultDeps, type Deps } from "./deps.js";
export { ProviderError } from "./http.js";
export { reasonText } from "./reasons.js";
export { SUPPORTED_COUNTRIES, isSupportedCountry, gscCountry, dataForSeoLocation } from "./countries.js";
export { normalizePhrase, phraseKey, toDomain, isoDate, daysAgo } from "./text.js";

export * from "./providers/types.js";
export { dataForSeo, dataForSeoReason, DATAFORSEO_API, type DataForSeoClient, type DataForSeoCredentials } from "./providers/dataforseo.js";
export {
  pageSpeedInsights,
  assessCwv,
  rate as rateCwv,
  CWV_THRESHOLDS,
  PAGESPEED_API,
  type PageSpeedClient,
  type PageSpeedMeasurement,
  type CwvAssessment,
  type CwvRating,
} from "./providers/pagespeed.js";
export { googleSuggest, SUGGEST_API, type SuggestClient } from "./providers/autocomplete.js";
export { telegram, TELEGRAM_API, type TelegramClient } from "./providers/telegram.js";
export { connectorGsc, type GscSource } from "./providers/gsc.js";

export * as integrations from "./integrations.js";
export * as keywordService from "./keywords.js";
export * as rankService from "./rank.js";
export * as discovery from "./discovery.js";
export * as pagespeedService from "./pagespeed.js";
export * as competitorService from "./competitors.js";
export * as scheduleService from "./schedules.js";
export * as alertService from "./alerts.js";
export * as notificationService from "./notifications.js";
export { samplePages, type SampledPage } from "./sampler.js";
export { runRankJob, runPageSpeedJob, runCompetitorJob, dispatchSchedule } from "./jobs.js";
