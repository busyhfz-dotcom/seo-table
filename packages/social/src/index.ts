/**
 * @seo/social — Instagram pages and Telegram channels: connection, sync,
 * audit, analytics, competitors, the post planner and its publisher, alerts.
 */
export * as socialAccounts from "./accounts.js";
export * as socialAudit from "./audit.js";
export * as socialAnalytics from "./analytics.js";
export * as socialCompetitors from "./competitors.js";
export * as planner from "./planner.js";
export * as socialAlerts from "./alerts.js";
export { startInstagramOAuth, completeInstagramOAuth, createState, verifyState } from "./oauth.js";
export { syncProject, ingestTelegramMessages, pollTelegramUpdates, type SyncResult } from "./sync.js";
export { handleTelegramWebhook } from "./webhook.js";
export { runSocialSyncJob, runSocialPublishJob, pollTelegramChannels, type SocialSyncOutcome } from "./jobs.js";
export { socialReasonText } from "./reasons.js";
export { SOCIAL_RULES, socialRule, socialScore } from "./audit.js";
export * as socialText from "./text.js";
