/**
 * Organization-wide integrations: DataForSEO (paid keyword/SERP/backlink data),
 * a PageSpeed Insights API key, and a Telegram bot for alerts.
 *
 * Credentials are verified live before they are stored, sealed with AES-GCM,
 * and never returned: the public view carries status, non-secret facts (login,
 * balance, chat id, a key's last four characters) and the last error.
 */
import { z } from "zod";
import { and, db, eq, orgIntegrations, providerUsage, gte, sql, type IntegrationKind, type OrgIntegration } from "@seo/db";
import { BadRequest, env, sealJson, unsealJson, type SealedSecret } from "@seo/core";
import { withDeps, type Deps } from "./deps.js";
import type { DataForSeoClient, DataForSeoCredentials } from "./providers/dataforseo.js";
import type { PageSpeedClient } from "./providers/pagespeed.js";
import { TELEGRAM_TOKEN, type TelegramClient } from "./providers/telegram.js";
import type { ProviderCheck } from "./providers/types.js";
import { reasonText } from "./reasons.js";

export const INTEGRATION_KINDS: readonly IntegrationKind[] = ["DATAFORSEO", "PAGESPEED", "TELEGRAM_ALERTS"];

export function integrationKind(raw: string | undefined): IntegrationKind {
  const kind = (raw ?? "").toUpperCase().replace(/-/g, "_");
  if (!INTEGRATION_KINDS.includes(kind as IntegrationKind)) throw new BadRequest("Unknown integration", { kind: raw });
  return kind as IntegrationKind;
}

export const integrationInput = {
  DATAFORSEO: z.object({
    login: z.string().trim().min(3).max(200),
    password: z.string().min(4).max(200),
    /** Daily SERP checks for tracked keywords (costs per check). Default on. */
    rankTracking: z.boolean().default(true),
    /** Upper bound on SERP checks per project per daily sync. */
    maxDailySerpChecks: z.coerce.number().int().min(0).max(5000).default(200),
  }),
  PAGESPEED: z.object({
    apiKey: z.string().trim().regex(/^[A-Za-z0-9_-]{20,80}$/, "must be a Google API key"),
  }),
  TELEGRAM_ALERTS: z.object({
    botToken: z.string().trim().regex(TELEGRAM_TOKEN, "must be a Telegram bot token (123456:ABC…)"),
    /** Numeric chat id (groups/channels are negative) or @channelusername. */
    chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, "must be a chat id or @channel"),
  }),
} as const;

type Secrets = {
  DATAFORSEO: DataForSeoCredentials;
  PAGESPEED: { apiKey: string };
  TELEGRAM_ALERTS: { botToken: string };
};

export type DataForSeoSettings = { rankTracking: boolean; maxDailySerpChecks: number };

export type IntegrationView = {
  kind: IntegrationKind;
  configured: boolean;
  status: OrgIntegration["status"];
  /** Non-secret facts: DATAFORSEO {login, balance, rankTracking, maxDailySerpChecks}; PAGESPEED {keyHint}; TELEGRAM_ALERTS {chatId, botUsername, chatTitle}. */
  config: Record<string, unknown>;
  lastError: string | null;
  lastErrorText: { fa: string; en: string } | null;
  lastCheckedAt: string | null;
  updatedAt: string | null;
};

function view(kind: IntegrationKind, row: OrgIntegration | undefined): IntegrationView {
  return {
    kind,
    configured: row?.status === "CONNECTED",
    status: row?.status ?? "NOT_CONNECTED",
    config: row?.config ?? {},
    lastError: row?.lastError ?? null,
    lastErrorText: reasonText(row?.lastError),
    lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

async function row(orgId: string, kind: IntegrationKind): Promise<OrgIntegration | undefined> {
  return (
    await db
      .select()
      .from(orgIntegrations)
      .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, kind)))
      .limit(1)
  )[0];
}

function secretsOf<K extends IntegrationKind>(r: OrgIntegration | undefined): Secrets[K] | null {
  if (!r?.secretCipher || !r.secretIv || !r.secretTag) return null;
  return unsealJson<Secrets[K]>({ cipher: r.secretCipher, iv: r.secretIv, tag: r.secretTag });
}

export async function listIntegrations(orgId: string): Promise<IntegrationView[]> {
  const rows = await db.select().from(orgIntegrations).where(eq(orgIntegrations.orgId, orgId));
  return INTEGRATION_KINDS.map((k) => view(k, rows.find((r) => r.kind === k)));
}

export async function getIntegration(orgId: string, kind: IntegrationKind): Promise<IntegrationView> {
  return view(kind, await row(orgId, kind));
}

export type SaveResult = IntegrationView & {
  ok: boolean;
  reason: string | null;
  message: string | null;
  messageText: { fa: string; en: string } | null;
};

async function checkCredentials(kind: IntegrationKind, input: unknown, deps: Deps): Promise<{
  check: ProviderCheck;
  secret: Secrets[IntegrationKind];
  config: Record<string, unknown>;
}> {
  if (kind === "DATAFORSEO") {
    const body = integrationInput.DATAFORSEO.parse(input);
    const check = await deps.dataForSeo({ login: body.login, password: body.password }).check();
    return {
      check,
      secret: { login: body.login, password: body.password },
      config: {
        login: body.login,
        balance: check.detail?.balance ?? null,
        rankTracking: body.rankTracking,
        maxDailySerpChecks: body.maxDailySerpChecks,
      },
    };
  }
  if (kind === "PAGESPEED") {
    const body = integrationInput.PAGESPEED.parse(input);
    const check = await deps.pageSpeed({ apiKey: body.apiKey }).check();
    return { check, secret: { apiKey: body.apiKey }, config: { keyHint: `…${body.apiKey.slice(-4)}` } };
  }
  const body = integrationInput.TELEGRAM_ALERTS.parse(input);
  const check = await deps.telegram({ botToken: body.botToken }).check(body.chatId);
  return {
    check,
    secret: { botToken: body.botToken },
    config: {
      chatId: body.chatId,
      botUsername: check.detail?.botUsername ?? null,
      chatTitle: check.detail?.chatTitle ?? null,
    },
  };
}

/**
 * Verify, then store. A failed check stores the ERROR status and reason but no
 * credential: nothing unverified is kept to be used later by a job.
 */
export async function saveIntegration(
  orgId: string,
  kind: IntegrationKind,
  input: unknown,
  partial: Partial<Deps> = {},
): Promise<SaveResult> {
  const deps = withDeps(partial);
  const { check, secret, config } = await checkCredentials(kind, input, deps);
  const sealed: SealedSecret | null = check.ok ? sealJson(secret) : null;
  const now = deps.now();
  const values = {
    status: check.ok ? ("CONNECTED" as const) : ("ERROR" as const),
    secretCipher: sealed?.cipher ?? null,
    secretIv: sealed?.iv ?? null,
    secretTag: sealed?.tag ?? null,
    config,
    lastError: check.ok ? null : (check.reason ?? "provider_error"),
    lastCheckedAt: now,
    updatedAt: now,
  };
  const saved = (
    await db
      .insert(orgIntegrations)
      .values({ orgId, kind, ...values })
      .onConflictDoUpdate({ target: [orgIntegrations.orgId, orgIntegrations.kind], set: values })
      .returning()
  )[0]!;
  return {
    ...view(kind, saved),
    ok: check.ok,
    reason: check.ok ? null : (check.reason ?? "provider_error"),
    message: check.message ?? null,
    messageText: check.ok ? null : reasonText(check.reason ?? "provider_error"),
  };
}

/** Update DataForSEO settings without re-entering the password. */
export async function updateDataForSeoSettings(orgId: string, settings: Partial<DataForSeoSettings>): Promise<IntegrationView> {
  const current = await row(orgId, "DATAFORSEO");
  if (!current || current.status !== "CONNECTED") throw new BadRequest("DataForSEO is not configured");
  const config = { ...current.config, ...settings };
  const updated = (
    await db
      .update(orgIntegrations)
      .set({ config, updatedAt: new Date() })
      .where(eq(orgIntegrations.id, current.id))
      .returning()
  )[0]!;
  return view("DATAFORSEO", updated);
}

export async function deleteIntegration(orgId: string, kind: IntegrationKind): Promise<void> {
  await db.delete(orgIntegrations).where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, kind)));
}

/**
 * Re-check stored credentials. For Telegram this is the "send test" button: it
 * posts a real message to the chat.
 */
export async function testIntegration(
  orgId: string,
  kind: IntegrationKind,
  partial: Partial<Deps> = {},
  testMessage?: string,
): Promise<SaveResult> {
  const deps = withDeps(partial);
  const current = await row(orgId, kind);
  const secret = secretsOf(current);
  if (!current || !secret) {
    return {
      ...view(kind, current),
      ok: false,
      reason: "not_configured",
      message: `${kind} is not configured`,
      messageText: reasonText("not_configured"),
    };
  }
  let check: ProviderCheck;
  let config = current.config;
  if (kind === "DATAFORSEO") {
    check = await deps.dataForSeo(secret as Secrets["DATAFORSEO"]).check();
    config = { ...config, balance: check.detail?.balance ?? config.balance ?? null };
  } else if (kind === "PAGESPEED") {
    check = await deps.pageSpeed({ apiKey: (secret as Secrets["PAGESPEED"]).apiKey }).check();
  } else {
    const client = deps.telegram(secret as Secrets["TELEGRAM_ALERTS"]);
    const chatId = String(config.chatId ?? "");
    try {
      await client.send(chatId, testMessage ?? "SEO Table: test message / پیام آزمایشی");
      check = { ok: true, message: "Test message sent." };
    } catch (err) {
      const reason = (err as { reason?: string }).reason ?? "network_error";
      check = { ok: false, reason, message: (err as Error).message };
    }
  }
  const now = deps.now();
  const updated = (
    await db
      .update(orgIntegrations)
      .set({
        // A transient failure (rate limit, network) does not disconnect a
        // working integration; a rejected credential does.
        status: check.ok ? "CONNECTED" : check.reason === "invalid_credentials" ? "ERROR" : current.status,
        lastError: check.ok ? null : (check.reason ?? "provider_error"),
        lastCheckedAt: now,
        config,
        updatedAt: now,
      })
      .where(eq(orgIntegrations.id, current.id))
      .returning()
  )[0]!;
  return {
    ...view(kind, updated),
    ok: check.ok,
    reason: check.ok ? null : (check.reason ?? "provider_error"),
    message: check.message ?? null,
    messageText: check.ok ? null : reasonText(check.reason ?? "provider_error"),
  };
}

/** Record a provider failure that means the stored credential no longer works. */
export async function markIntegrationFailed(orgId: string, kind: IntegrationKind, reason: string): Promise<void> {
  await db
    .update(orgIntegrations)
    .set({
      lastError: reason,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
      // Only a rejected credential disconnects: an empty balance is shown as the
      // error and clears itself on the next successful call or test.
      ...(reason === "invalid_credentials" ? { status: "ERROR" as const } : {}),
    })
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, kind)));
}

/** A call succeeded again: drop an error left by an earlier failure (an empty balance since topped up). */
export async function clearIntegrationError(orgId: string, kind: IntegrationKind): Promise<void> {
  await db
    .update(orgIntegrations)
    .set({ lastError: null, updatedAt: new Date() })
    .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.kind, kind), sql`${orgIntegrations.lastError} IS NOT NULL`));
}

// ---------------------------------------------------------------- loaders for services

export type LoadedDataForSeo = { client: DataForSeoClient; settings: DataForSeoSettings };

/** The org's DataForSEO client, or null when it is not configured (the honest "not configured" state). */
export async function loadDataForSeo(orgId: string, partial: Partial<Deps> = {}): Promise<LoadedDataForSeo | null> {
  const r = await row(orgId, "DATAFORSEO");
  if (r?.status !== "CONNECTED") return null;
  const secret = secretsOf<"DATAFORSEO">(r);
  if (!secret) return null;
  return {
    client: withDeps(partial).dataForSeo(secret),
    settings: {
      rankTracking: r.config.rankTracking !== false,
      maxDailySerpChecks: typeof r.config.maxDailySerpChecks === "number" ? r.config.maxDailySerpChecks : 200,
    },
  };
}

/** PageSpeed always works: the org's key, else PAGESPEED_API_KEY, else keyless. */
export async function loadPageSpeed(
  orgId: string,
  partial: Partial<Deps> = {},
): Promise<{ client: PageSpeedClient; keySource: "org" | "env" | "none" }> {
  const r = await row(orgId, "PAGESPEED");
  const orgKey = r?.status === "CONNECTED" ? secretsOf<"PAGESPEED">(r)?.apiKey : undefined;
  const envKey = env().PAGESPEED_API_KEY;
  const apiKey = orgKey ?? envKey ?? null;
  return { client: withDeps(partial).pageSpeed({ apiKey }), keySource: orgKey ? "org" : envKey ? "env" : "none" };
}

export async function pageSpeedKeySource(orgId: string): Promise<"org" | "env" | "none"> {
  const r = await row(orgId, "PAGESPEED");
  if (r?.status === "CONNECTED") return "org";
  return env().PAGESPEED_API_KEY ? "env" : "none";
}

export async function loadTelegram(
  orgId: string,
  partial: Partial<Deps> = {},
): Promise<{ client: TelegramClient; chatId: string } | null> {
  const r = await row(orgId, "TELEGRAM_ALERTS");
  if (r?.status !== "CONNECTED") return null;
  const secret = secretsOf<"TELEGRAM_ALERTS">(r);
  const chatId = typeof r.config.chatId === "string" ? r.config.chatId : null;
  if (!secret || !chatId) return null;
  return { client: withDeps(partial).telegram(secret), chatId };
}

// ---------------------------------------------------------------- spend

export async function recordUsage(input: {
  orgId: string;
  projectId?: string | null;
  provider: string;
  endpoint: string;
  cost: number | null;
}): Promise<void> {
  await db.insert(providerUsage).values({
    orgId: input.orgId,
    projectId: input.projectId ?? null,
    provider: input.provider,
    endpoint: input.endpoint,
    cost: input.cost,
  });
}

export async function usageSummary(
  orgId: string,
  days = 30,
): Promise<{ days: number; totalCost: number; calls: number; byEndpoint: Array<{ endpoint: string; calls: number; cost: number }> }> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      endpoint: providerUsage.endpoint,
      calls: sql<number>`count(*)::int`,
      cost: sql<number>`coalesce(sum(${providerUsage.cost}), 0)::float8`,
    })
    .from(providerUsage)
    .where(and(eq(providerUsage.orgId, orgId), gte(providerUsage.createdAt, since)))
    .groupBy(providerUsage.endpoint);
  return {
    days,
    totalCost: Number(rows.reduce((s, r) => s + r.cost, 0).toFixed(4)),
    calls: rows.reduce((s, r) => s + r.calls, 0),
    byEndpoint: rows.sort((a, b) => b.cost - a.cost),
  };
}
