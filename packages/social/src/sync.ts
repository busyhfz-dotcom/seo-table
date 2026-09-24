/**
 * Pulling what the platforms report into social_accounts, social_posts and
 * social_metrics_daily. Idempotent: posts upsert on (project, external id),
 * daily rows on (project, date, source), so a retried or repeated sync only
 * refreshes numbers.
 */
import {
  db,
  eq,
  socialAccounts,
  socialMetricsDaily,
  socialPosts,
  sql,
  type SocialAccount,
  type SocialPostFeatures,
  type SocialPostMetrics,
  type SocialPostType,
  type SocialSource,
} from "@seo/db";
import { childLogger, sealJson } from "@seo/core";
import {
  ConnectorError,
  InstagramError,
  instagramClient,
  refreshInstagramToken,
  telegramBot,
  telegramMessageLink,
  type InstagramMedia,
  type TgMessage,
} from "@seo/connectors";
import { connectedAccount, recheck, saveInstagramProfile, type SocialSecret } from "./accounts.js";
import { cachedPreview } from "./preview.js";
import { extractHashtags, isoDay } from "./text.js";

/** Recent media read per sync, and how many of the newest get insights (one API call each). */
const IG_MEDIA_MAX = 100;
const IG_INSIGHTS_MAX = 40;
const IG_INSIGHTS_DAYS = 30;
/** Refresh a long-lived token once it has fewer than this many days left (it lasts 60). */
const IG_REFRESH_BEFORE_DAYS = 20;
const DAY = 86_400_000;

export type SyncResult = {
  platform: "INSTAGRAM" | "TELEGRAM";
  ok: boolean;
  reason: string | null;
  posts: number;
  /** Parts that failed without failing the sync (insights refused, no public preview, …). */
  warnings: string[];
  tokenRefreshed?: boolean;
};

type PostRow = {
  externalId: string;
  permalink: string | null;
  type: SocialPostType;
  caption: string | null;
  mediaUrls: string[];
  altTexts: Array<string | null> | null;
  hashtags: string[];
  publishedAt: Date | null;
  metrics?: SocialPostMetrics;
  features: SocialPostFeatures;
  source: SocialSource;
};

async function upsertPosts(projectId: string, platform: "INSTAGRAM" | "TELEGRAM", rows: PostRow[], now: Date): Promise<void> {
  for (const r of rows) {
    await db
      .insert(socialPosts)
      .values({
        projectId,
        platform,
        externalId: r.externalId,
        permalink: r.permalink,
        type: r.type,
        caption: r.caption,
        mediaUrls: r.mediaUrls,
        altTexts: r.altTexts as string[] | null,
        hashtags: r.hashtags,
        publishedAt: r.publishedAt,
        metrics: r.metrics ?? {},
        metricsAt: r.metrics ? now : null,
        features: r.features,
        source: r.source,
      })
      .onConflictDoUpdate({
        target: [socialPosts.projectId, socialPosts.externalId],
        set: {
          permalink: sql`coalesce(excluded.permalink, ${socialPosts.permalink})`,
          caption: sql`coalesce(excluded.caption, ${socialPosts.caption})`,
          mediaUrls: sql`case when cardinality(excluded.media_urls) > 0 then excluded.media_urls else ${socialPosts.mediaUrls} end`,
          altTexts: sql`coalesce(excluded.alt_texts, ${socialPosts.altTexts})`,
          hashtags: sql`excluded.hashtags`,
          publishedAt: sql`coalesce(excluded.published_at, ${socialPosts.publishedAt})`,
          // New numbers are merged over old ones: a source that reports only views keeps the likes another reported.
          metrics: sql`${socialPosts.metrics} || excluded.metrics`,
          metricsAt: sql`coalesce(excluded.metrics_at, ${socialPosts.metricsAt})`,
          features: sql`${socialPosts.features} || excluded.features`,
          updatedAt: now,
        },
      });
  }
}

async function upsertDaily(
  projectId: string,
  date: string,
  source: SocialSource,
  values: { followers?: number | null; reach?: number | null; views?: number | null; profileViews?: number | null; engagement?: number | null },
): Promise<void> {
  const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));
  if (Object.keys(set).length === 0) return;
  await db
    .insert(socialMetricsDaily)
    .values({ projectId, date, source, ...set })
    .onConflictDoUpdate({ target: [socialMetricsDaily.projectId, socialMetricsDaily.date, socialMetricsDaily.source], set });
}

// ---------------------------------------------------------------- Instagram

function igType(m: InstagramMedia): SocialPostType {
  if (m.mediaType === "CAROUSEL_ALBUM") return "carousel";
  if (m.mediaType === "IMAGE") return "image";
  // Every feed video has been a reel since 2022; media_product_type says so when the API reports it.
  if (m.mediaType === "VIDEO") return m.productType && m.productType !== "REELS" ? "video" : "reel";
  return "other";
}

function igAltTexts(m: InstagramMedia): Array<string | null> | null {
  if (m.altText === undefined) return null;
  if (m.mediaType === "CAROUSEL_ALBUM") {
    const images = m.children.filter((c) => c.mediaType === "IMAGE");
    if (images.some((c) => c.altText === undefined)) return null;
    return images.map((c) => (c.altText ? c.altText : null));
  }
  return m.mediaType === "IMAGE" ? [m.altText ? m.altText : null] : [];
}

function textFeatures(text: string | null): SocialPostFeatures {
  const t = text ?? "";
  return { length: [...t].length, lineBreaks: (t.match(/\n/g) ?? []).length, links: (t.match(/https?:\/\/\S+/g) ?? []).length };
}

async function maybeRefreshToken(row: SocialAccount, secret: SocialSecret, now: Date): Promise<{ token: string; refreshed: boolean; error: string | null }> {
  const token = secret.accessToken ?? "";
  const expires = row.tokenExpiresAt?.getTime() ?? 0;
  const lastRefresh = row.tokenRefreshedAt?.getTime() ?? 0;
  // The API refuses to refresh a token younger than 24 hours.
  if (expires - now.getTime() > IG_REFRESH_BEFORE_DAYS * DAY || now.getTime() - lastRefresh < DAY) {
    return { token, refreshed: false, error: null };
  }
  try {
    const fresh = await refreshInstagramToken(token);
    const sealed = sealJson({ accessToken: fresh.accessToken } satisfies SocialSecret);
    await db
      .update(socialAccounts)
      .set({ secretCipher: sealed.cipher, secretIv: sealed.iv, secretTag: sealed.tag, tokenExpiresAt: fresh.expiresAt, tokenRefreshedAt: now })
      .where(eq(socialAccounts.id, row.id));
    return { token: fresh.accessToken, refreshed: true, error: null };
  } catch (err) {
    return { token, refreshed: false, error: err instanceof InstagramError ? err.code : "network_error" };
  }
}

async function syncInstagram(row: SocialAccount & { secret: SocialSecret }, now: Date): Promise<SyncResult> {
  const warnings: string[] = [];
  const refresh = await maybeRefreshToken(row, row.secret, now);
  if (refresh.error) warnings.push(`token_refresh:${refresh.error}`);
  const client = instagramClient(refresh.token, row.externalId!);

  const profile = await client.profile();
  await saveInstagramProfile(row, profile);
  await upsertDaily(row.projectId, isoDay(now), "api", { followers: profile.followers });

  const media = await client.media(IG_MEDIA_MAX);
  const rows: PostRow[] = media.map((m) => ({
    externalId: m.id,
    permalink: m.permalink,
    type: igType(m),
    caption: m.caption,
    mediaUrls: (m.children.length ? m.children.map((c) => c.mediaUrl) : [m.mediaUrl]).filter((u): u is string => Boolean(u)).slice(0, 10),
    altTexts: igAltTexts(m),
    hashtags: extractHashtags(m.caption ?? ""),
    publishedAt: m.timestamp ? new Date(m.timestamp) : null,
    metrics: {
      ...(m.likes !== null ? { likes: m.likes } : {}),
      ...(m.comments !== null ? { comments: m.comments } : {}),
    },
    features: textFeatures(m.caption),
    source: "api",
  }));

  // Insights for recent posts only: older numbers barely move, and each post is one call.
  let insightsDenied = false;
  const recent = rows.filter((r) => r.publishedAt && now.getTime() - r.publishedAt.getTime() < IG_INSIGHTS_DAYS * DAY).slice(0, IG_INSIGHTS_MAX);
  for (const r of recent) {
    if (insightsDenied) break;
    try {
      const metrics = await client.mediaInsights(r.externalId);
      if (metrics) r.metrics = { ...r.metrics, ...metrics };
    } catch (err) {
      if (err instanceof InstagramError && (err.code === "permission_denied" || err.code === "rate_limited")) {
        insightsDenied = true;
        warnings.push(`media_insights:${err.code}`);
      } else if (err instanceof InstagramError) {
        warnings.push(`media_insights:${err.code}`);
      } else throw err;
    }
  }
  await upsertPosts(row.projectId, "INSTAGRAM", rows, now);

  const yesterday = isoDay(new Date(now.getTime() - DAY));
  try {
    const day = await client.accountInsights(yesterday);
    await upsertDaily(row.projectId, yesterday, "api", { reach: day.reach, views: day.views, engagement: day.interactions });
  } catch (err) {
    if (!(err instanceof InstagramError)) throw err;
    warnings.push(`account_insights:${err.code}`);
  }

  return { platform: "INSTAGRAM", ok: true, reason: null, posts: rows.length, warnings, tokenRefreshed: refresh.refreshed };
}

// ---------------------------------------------------------------- Telegram

function tgType(m: TgMessage): SocialPostType {
  if (m.media_group_id) return "album";
  if (m.photo) return "photo";
  if (m.video) return "video";
  if (m.text) return "text";
  return "other";
}

const FORMAT_ENTITIES = new Set(["bold", "italic", "underline", "strikethrough", "code", "pre", "blockquote", "expandable_blockquote", "spoiler"]);

export function telegramPostRow(m: TgMessage): PostRow | null {
  const text = m.text ?? m.caption ?? null;
  // An album arrives as one message per item; the captioned one stands for the album.
  if (m.media_group_id && !text) return null;
  const entities = m.entities ?? m.caption_entities ?? [];
  return {
    externalId: String(m.message_id),
    permalink: telegramMessageLink({ id: m.chat.id, username: m.chat.username ?? null }, m.message_id),
    type: tgType(m),
    caption: text,
    mediaUrls: [],
    altTexts: null,
    hashtags: extractHashtags(text ?? ""),
    publishedAt: new Date(m.date * 1000),
    features: {
      ...textFeatures(text),
      formatted: entities.some((e) => FORMAT_ENTITIES.has(e.type)),
      links: entities.filter((e) => e.type === "url" || e.type === "text_link").length,
    },
    source: "api",
  };
}

/** Channel posts delivered by the webhook or getUpdates, for this account's chat only. */
export async function ingestTelegramMessages(row: SocialAccount, messages: TgMessage[], now = new Date()): Promise<number> {
  const mine = messages.filter((m) => String(m.chat.id) === row.externalId);
  const rows = mine.map(telegramPostRow).filter((r): r is PostRow => r !== null);
  await upsertPosts(row.projectId, "TELEGRAM", rows, now);
  return rows.length;
}

/** Local development without a public https address: read pending channel posts with getUpdates. */
export async function pollTelegramUpdates(row: SocialAccount & { secret: SocialSecret }, now = new Date()): Promise<number> {
  const bot = telegramBot(row.secret.botToken ?? "");
  const offset = row.profile.updates?.offset;
  const updates = await bot.getUpdates(offset);
  if (updates.length === 0) return 0;
  const messages = updates.flatMap((u) => [u.channel_post, u.edited_channel_post].filter((m): m is TgMessage => Boolean(m)));
  const count = await ingestTelegramMessages(row, messages, now);
  const next = Math.max(...updates.map((u) => u.update_id)) + 1;
  await db
    .update(socialAccounts)
    .set({ profile: sql`jsonb_set(${socialAccounts.profile}, '{updates,offset}', ${String(next)}::jsonb, true)` })
    .where(eq(socialAccounts.id, row.id));
  return count;
}

async function syncTelegram(row: SocialAccount & { secret: SocialSecret }, now: Date): Promise<SyncResult> {
  const warnings: string[] = [];
  const checked = await recheck(row.projectId);
  if (!checked.ok && (checked.reason === "invalid_token" || checked.reason === "chat_not_found" || checked.reason === "not_admin")) {
    return { platform: "TELEGRAM", ok: false, reason: checked.reason, posts: 0, warnings };
  }
  if (checked.reason) warnings.push(`check:${checked.reason}`);
  const account = checked.account;
  await upsertDaily(row.projectId, isoDay(now), "api", { followers: account.followers });

  let posts = 0;
  if (account.profile.updates?.mode !== "webhook") {
    try {
      posts += await pollTelegramUpdates({ ...account, secret: row.secret }, now);
    } catch (err) {
      warnings.push(`updates:${(err as ConnectorError).code ?? "error"}`);
    }
  }

  let publicPreview = false;
  if (account.username) {
    try {
      const preview = await cachedPreview(account.username);
      publicPreview = true;
      const rows: PostRow[] = preview.posts.map((p) => ({
        externalId: String(p.id),
        permalink: p.permalink,
        type: p.type,
        caption: p.text || null,
        mediaUrls: p.mediaUrls,
        altTexts: null,
        hashtags: p.hashtags,
        publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
        metrics: p.views !== null ? { views: p.views } : undefined,
        features: p.features,
        source: "public_preview",
      }));
      await upsertPosts(row.projectId, "TELEGRAM", rows, now);
      posts += rows.length;
      if (preview.subscribers !== null) await upsertDaily(row.projectId, isoDay(now), "public_preview", { followers: preview.subscribers });
    } catch (err) {
      warnings.push(`preview:${(err as ConnectorError).code ?? "error"}`);
    }
  } else {
    warnings.push("preview:no_public_username");
  }
  await db
    .update(socialAccounts)
    .set({ profile: sql`${socialAccounts.profile} || ${JSON.stringify({ publicPreview })}::jsonb` })
    .where(eq(socialAccounts.id, row.id));
  return { platform: "TELEGRAM", ok: true, reason: null, posts, warnings };
}

// ---------------------------------------------------------------- entry

export async function syncProject(projectId: string, now = new Date()): Promise<SyncResult> {
  const log = childLogger({ component: "social-sync", projectId });
  const row = await connectedAccount(projectId);
  let result: SyncResult;
  try {
    result = row.platform === "INSTAGRAM" ? await syncInstagram(row, now) : await syncTelegram(row, now);
  } catch (err) {
    const reason = err instanceof ConnectorError ? err.code : null;
    if (!reason) throw err;
    result = { platform: row.platform, ok: false, reason, posts: 0, warnings: [] };
  }
  await db
    .update(socialAccounts)
    .set({
      lastSyncAt: now,
      ...(result.ok ? {} : { lastError: result.reason, ...(result.reason === "invalid_token" ? { status: "ERROR" as const } : {}) }),
      updatedAt: now,
    })
    .where(eq(socialAccounts.id, row.id));
  log.info({ ok: result.ok, reason: result.reason, posts: result.posts, warnings: result.warnings }, "social sync finished");
  return result;
}
