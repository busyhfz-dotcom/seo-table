/**
 * The connected Instagram account or Telegram channel of a social project.
 *
 * Tokens are sealed (AES-GCM) in social_accounts and decrypted only here; the
 * public view carries facts and status, never a token or a hint of one.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  and,
  db,
  eq,
  projects,
  socialAccounts,
  type LocalizedText,
  type Project,
  type SocialAccount,
  type SocialPlatform,
  type SocialProfile,
  type SocialSettings,
} from "@seo/db";
import { BadRequest, Conflict, NotFound, childLogger, constantTimeEquals, env, sealJson, unsealJson } from "@seo/core";
import {
  InstagramError,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT,
  checkTelegramChannel,
  instagramClient,
  telegramBot,
  type InstagramApp,
  type InstagramProfile,
  type TelegramCheck,
} from "@seo/connectors";
import { socialReasonText } from "./reasons.js";

export type SocialSecret = { accessToken?: string; botToken?: string };

export function assertSocialProject(project: Project, platform?: SocialPlatform): SocialPlatform {
  if (project.kind === "WEBSITE") throw new BadRequest("This is a website project, not an Instagram or Telegram one", { reason: "not_social" });
  if (platform && project.kind !== platform) throw new BadRequest(`This project is ${project.kind}, not ${platform}`, { reason: "wrong_platform" });
  return project.kind;
}

export async function getAccount(projectId: string): Promise<SocialAccount | null> {
  return (await db.select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId)).limit(1))[0] ?? null;
}

/** The row exists from project creation on, so every read has something to show. */
export async function ensureAccount(projectId: string, platform: SocialPlatform): Promise<SocialAccount> {
  await db.insert(socialAccounts).values({ projectId, platform }).onConflictDoNothing();
  return (await getAccount(projectId))!;
}

export function secretOf(row: SocialAccount): SocialSecret {
  if (!row.secretCipher || !row.secretIv || !row.secretTag) throw new Conflict("The account is not connected", { reason: "not_connected" });
  return unsealJson<SocialSecret>({ cipher: row.secretCipher, iv: row.secretIv, tag: row.secretTag });
}

export async function connectedAccount(projectId: string): Promise<SocialAccount & { secret: SocialSecret }> {
  const row = await getAccount(projectId);
  if (!row || row.status === "NOT_CONNECTED" || !row.externalId) throw new Conflict("The account is not connected", { reason: "not_connected" });
  return { ...row, secret: secretOf(row) };
}

export type AccountView = {
  platform: SocialPlatform;
  status: SocialAccount["status"];
  connected: boolean;
  externalId: string | null;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  website: string | null;
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  profile: SocialProfile;
  settings: SocialSettings;
  scopes: string[];
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastErrorText: LocalizedText | null;
  lastSyncAt: string | null;
  connectedAt: string | null;
};

export function accountView(row: SocialAccount): AccountView {
  return {
    platform: row.platform,
    status: row.status,
    connected: row.status === "CONNECTED",
    externalId: row.externalId,
    username: row.username,
    displayName: row.displayName,
    bio: row.bio,
    website: row.website,
    followers: row.followers,
    following: row.following,
    mediaCount: row.mediaCount,
    profile: row.profile,
    settings: row.settings,
    scopes: row.scopes,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorText: socialReasonText(row.lastError),
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    connectedAt: row.connectedAt?.toISOString() ?? null,
  };
}

export const settingsInput = z.object({
  keywords: z.array(z.string().trim().min(2).max(60)).max(10).optional(),
  cta: z.string().trim().max(80).nullable().optional(),
  link: z.string().trim().max(200).url().nullable().optional(),
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone")
    .nullable()
    .optional(),
});

export async function updateSettings(projectId: string, input: z.infer<typeof settingsInput>): Promise<SocialAccount> {
  const row = await getAccount(projectId);
  if (!row) throw new NotFound("No social account for this project");
  const settings: SocialSettings = { ...row.settings };
  if (input.keywords !== undefined) settings.keywords = [...new Set(input.keywords)];
  if (input.cta !== undefined) settings.cta = input.cta;
  if (input.link !== undefined) settings.link = input.link;
  if (input.timezone !== undefined) settings.timezone = input.timezone;
  return (await db.update(socialAccounts).set({ settings, updatedAt: new Date() }).where(eq(socialAccounts.id, row.id)).returning())[0]!;
}

// ---------------------------------------------------------------- Telegram

export const telegramConnectInput = z.object({
  botToken: z.string().trim().regex(TELEGRAM_BOT_TOKEN, "must be a Telegram bot token (123456:ABC…)"),
  /** @channelusername, t.me/<username>, or the numeric id (-100…). */
  channel: z
    .string()
    .trim()
    .transform((v) => v.replace(/^https?:\/\/t\.me\//i, "@").replace(/^([A-Za-z][A-Za-z0-9_]{3,31})$/, "@$1"))
    .pipe(z.string().regex(TELEGRAM_CHAT, "must be @channel or a channel id")),
});

/** Telegram's secret_token for this account's webhook: derived, so nothing extra is stored. */
export function webhookSecret(accountId: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(`telegram-webhook:${accountId}`).digest("hex");
}

export function verifyWebhookSecret(accountId: string, header: string | null): boolean {
  return Boolean(header) && constantTimeEquals(header!, webhookSecret(accountId));
}

/** Webhooks need a public https address; without one (local development) the sync polls getUpdates. */
export function webhookUrl(accountId: string): string | null {
  const base = env().APP_URL;
  if (!base || !/^https:\/\//i.test(base)) return null;
  return new URL(`/api/social/telegram/webhook/${accountId}`, base).toString();
}

function telegramProfile(c: TelegramCheck, previous: SocialProfile): SocialProfile {
  return {
    ...previous,
    botId: c.bot?.id,
    botUsername: c.bot?.username ?? null,
    rights: c.rights ? { ...c.rights } : previous.rights,
    pinnedMessageId: c.chat?.pinned_message?.message_id ?? null,
    pinnedText: (c.chat?.pinned_message?.text ?? c.chat?.pinned_message?.caption ?? null)?.slice(0, 500) ?? null,
  };
}

/**
 * Verify the bot can manage the channel, then store it. A refused check stores
 * nothing and answers {ok:false, reason}; the token is never kept for a
 * channel it cannot manage.
 */
export async function connectTelegram(
  project: Project,
  input: z.infer<typeof telegramConnectInput>,
  userId: string | null,
): Promise<{ ok: boolean; reason?: string; missing?: string[]; account: SocialAccount }> {
  assertSocialProject(project, "TELEGRAM");
  const row = await ensureAccount(project.id, "TELEGRAM");
  const c = await checkTelegramChannel(input.botToken, input.channel);
  if (!c.ok || !c.chat) {
    return { ok: false, reason: c.reason, ...(c.missing ? { missing: c.missing } : {}), account: row };
  }
  const sealed = sealJson({ botToken: input.botToken } satisfies SocialSecret);
  let profile = telegramProfile(c, {});
  const now = new Date();
  let saved = (
    await db
      .update(socialAccounts)
      .set({
        externalId: String(c.chat.id),
        username: c.chat.username ?? null,
        displayName: c.chat.title ?? null,
        bio: c.chat.description ?? null,
        followers: c.members ?? null,
        profile,
        secretCipher: sealed.cipher,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        scopes: Object.entries(c.rights ?? {}).filter(([, v]) => v).map(([k]) => k),
        status: "CONNECTED",
        lastError: null,
        connectedAt: now,
        connectedById: userId,
        updatedAt: now,
      })
      .where(eq(socialAccounts.id, row.id))
      .returning()
  )[0]!;
  profile = { ...profile, updates: await setupUpdates(saved, input.botToken) };
  saved = (await db.update(socialAccounts).set({ profile }).where(eq(socialAccounts.id, row.id)).returning())[0]!;
  if (c.chat.username) {
    await db.update(projects).set({ baseUrl: `https://t.me/${c.chat.username}` }).where(eq(projects.id, project.id));
  }
  return { ok: true, account: saved };
}

async function setupUpdates(row: SocialAccount, botToken: string): Promise<NonNullable<SocialProfile["updates"]>> {
  const bot = telegramBot(botToken);
  const url = webhookUrl(row.id);
  const at = new Date().toISOString();
  if (url) {
    try {
      await bot.setWebhook(url, webhookSecret(row.id));
      return { mode: "webhook", setAt: at, error: null };
    } catch (err) {
      childLogger({ component: "social" }).warn({ accountId: row.id, reason: (err as { code?: string }).code }, "telegram webhook not set");
      return { mode: "polling", setAt: at, error: "webhook_failed" };
    }
  }
  // getUpdates refuses to work while a webhook is set.
  await bot.deleteWebhook().catch(() => undefined);
  return { mode: "polling", setAt: at, error: null };
}

/** Re-run the connection check and record what is true now (rights can be taken away in Telegram). */
export async function recheck(projectId: string): Promise<{ ok: boolean; reason: string | null; account: SocialAccount }> {
  const row = await connectedAccount(projectId);
  if (row.platform === "TELEGRAM") {
    const c = await checkTelegramChannel(row.secret.botToken ?? "", row.externalId!);
    const profile = telegramProfile(c, row.profile);
    const updated = (
      await db
        .update(socialAccounts)
        .set({
          status: c.ok ? "CONNECTED" : c.reason === "network_error" ? row.status : "ERROR",
          lastError: c.ok ? null : (c.reason ?? "api_error"),
          profile,
          ...(c.chat ? { displayName: c.chat.title ?? null, bio: c.chat.description ?? null, username: c.chat.username ?? null } : {}),
          ...(c.members != null ? { followers: c.members } : {}),
          updatedAt: new Date(),
        })
        .where(eq(socialAccounts.id, row.id))
        .returning()
    )[0]!;
    return { ok: c.ok, reason: c.ok ? null : (c.reason ?? null), account: updated };
  }
  try {
    const p = await instagramClient(row.secret.accessToken ?? "", row.externalId!).profile();
    const updated = await saveInstagramProfile(row, p);
    return { ok: true, reason: null, account: updated };
  } catch (err) {
    const reason = err instanceof InstagramError ? err.code : "network_error";
    const updated = (
      await db
        .update(socialAccounts)
        .set({ status: reason === "network_error" ? row.status : "ERROR", lastError: reason, updatedAt: new Date() })
        .where(eq(socialAccounts.id, row.id))
        .returning()
    )[0]!;
    return { ok: false, reason, account: updated };
  }
}

/** Forget the token (the platform keeps the page/channel as it is); collected history stays. */
export async function disconnect(projectId: string): Promise<SocialAccount> {
  const row = await getAccount(projectId);
  if (!row) throw new NotFound("No social account for this project");
  if (row.platform === "TELEGRAM" && row.secretCipher && row.profile.updates?.mode === "webhook") {
    // Best effort: a webhook left behind would only be refused by our route anyway.
    await telegramBot(secretOf(row).botToken ?? "").deleteWebhook().catch(() => undefined);
  }
  return (
    await db
      .update(socialAccounts)
      .set({
        secretCipher: null,
        secretIv: null,
        secretTag: null,
        tokenExpiresAt: null,
        status: "NOT_CONNECTED",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(socialAccounts.id, row.id))
      .returning()
  )[0]!;
}

// ---------------------------------------------------------------- Instagram

/** The Instagram app from the environment, or null: then Instagram reports not_configured. */
export function instagramApp(): InstagramApp | null {
  const e = env();
  if (!e.META_APP_ID || !e.META_APP_SECRET || !e.APP_URL) return null;
  return { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, redirectUri: new URL("/api/oauth/instagram/callback", e.APP_URL).toString() };
}

export async function saveInstagramProfile(row: SocialAccount, p: InstagramProfile): Promise<SocialAccount> {
  return (
    await db
      .update(socialAccounts)
      .set({
        username: p.username || row.username,
        displayName: p.name,
        bio: p.biography,
        website: p.website,
        followers: p.followers,
        following: p.follows,
        mediaCount: p.mediaCount,
        profile: { ...row.profile, pictureUrl: p.pictureUrl, accountType: p.accountType },
        status: "CONNECTED",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(socialAccounts.id, row.id))
      .returning()
  )[0]!;
}

export async function storeInstagramToken(
  project: Project,
  input: { userId: string; accessToken: string; expiresAt: Date; permissions: string[]; profile: InstagramProfile; connectedBy: string },
): Promise<SocialAccount> {
  const row = await ensureAccount(project.id, "INSTAGRAM");
  const sealed = sealJson({ accessToken: input.accessToken } satisfies SocialSecret);
  const now = new Date();
  const updated = (
    await db
      .update(socialAccounts)
      .set({
        externalId: input.profile.id || input.userId,
        secretCipher: sealed.cipher,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        tokenExpiresAt: input.expiresAt,
        tokenRefreshedAt: now,
        scopes: input.permissions,
        connectedAt: now,
        connectedById: input.connectedBy,
      })
      .where(and(eq(socialAccounts.id, row.id), eq(socialAccounts.projectId, project.id)))
      .returning()
  )[0]!;
  const saved = await saveInstagramProfile(updated, input.profile);
  if (input.profile.username) {
    await db.update(projects).set({ baseUrl: `https://www.instagram.com/${input.profile.username}/` }).where(eq(projects.id, project.id));
  }
  return saved;
}
