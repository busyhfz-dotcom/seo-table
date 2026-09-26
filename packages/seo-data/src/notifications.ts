/**
 * Notifications: the in-app inbox, plus delivery of the same event to a
 * signed webhook and/or Telegram.
 *
 * One row per event (dedupe_key), however often the evaluator runs or a job is
 * retried. External deliveries go through the notify queue with retries and
 * backoff; each channel's outcome is kept on the row (deliveries jsonb).
 */
import { createHmac } from "node:crypto";
import {
  alertRules,
  and,
  count,
  db,
  desc,
  eq,
  inArray,
  isNull,
  notifications,
  projects,
  sql,
  type AlertChannel,
  type AlertRule,
  type LocalizedText,
  type Notification,
  type NotificationDelivery,
  type Severity,
} from "@seo/db";
import { childLogger, enqueueNotify, env, unseal } from "@seo/core";
import { withDeps, type Deps } from "./deps.js";
import { fetchJson, ProviderError } from "./http.js";
import { loadTelegram } from "./integrations.js";

export type AlertEvent = {
  kind: string;
  severity: Severity;
  title: LocalizedText;
  body: LocalizedText;
  link: string | null;
  data: Record<string, unknown>;
  /** Identifies the event (not the rule): "score_drop:<runId>". */
  dedupeKey: string;
};

const EXTERNAL: Array<Exclude<AlertChannel, "in_app">> = ["webhook", "telegram"];

/**
 * Record an event for one rule (or none: a system notice) and queue its
 * external deliveries. Returns null when this event was already recorded.
 */
export async function notify(input: {
  orgId: string;
  projectId: string | null;
  rule: AlertRule | null;
  event: AlertEvent;
  now?: Date;
}): Promise<Notification | null> {
  const now = input.now ?? new Date();
  const channels: AlertChannel[] = input.rule?.channels ?? ["in_app"];
  const external = EXTERNAL.filter((c) => channels.includes(c) && (c !== "webhook" || Boolean(input.rule?.webhookUrl)));
  const deliveries: Record<string, NotificationDelivery> = Object.fromEntries(
    external.map((c) => [c, { status: "pending", attempts: 0, at: now.toISOString() }]),
  );
  const inserted = await db
    .insert(notifications)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      alertRuleId: input.rule?.id ?? null,
      kind: input.event.kind,
      severity: input.event.severity,
      title: input.event.title,
      body: input.event.body,
      link: input.event.link,
      data: input.event.data,
      dedupeKey: input.rule ? `${input.event.dedupeKey}:${input.rule.id}` : input.event.dedupeKey,
      deliveries,
      // A rule that does not want the inbox still leaves the record, already read.
      readAt: channels.includes("in_app") ? null : now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) return null;
  for (const channel of external) {
    try {
      await enqueueNotify({ notificationId: row.id, channel });
    } catch (err) {
      await setDelivery(row.id, channel, { status: "failed", attempts: 0, error: "queue_unavailable", at: new Date().toISOString() });
      childLogger({ component: "notify" }).error({ notificationId: row.id, channel, err: (err as Error).message }, "delivery not queued");
    }
  }
  return row;
}

async function setDelivery(id: string, channel: string, value: NotificationDelivery): Promise<void> {
  await db
    .update(notifications)
    .set({ deliveries: sql`jsonb_set(${notifications.deliveries}, ${`{${channel}}`}::text[], ${JSON.stringify(value)}::jsonb, true)` })
    .where(eq(notifications.id, id));
}

// ---------------------------------------------------------------- webhook

/**
 * X-SeoTable-Signature: "sha256=" + hex HMAC-SHA256(secret, "<timestamp>.<raw body>").
 * The timestamp (X-SeoTable-Timestamp, unix seconds) is signed too, so a
 * receiver can reject replays older than a few minutes.
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function absoluteLink(link: string | null): string | null {
  const base = env().APP_URL;
  if (!link) return null;
  return base ? new URL(link, base).toString() : link;
}

export type WebhookPayload = {
  id: string;
  event: string;
  severity: Severity;
  project: { id: string; name: string; url: string } | null;
  title: LocalizedText;
  body: LocalizedText;
  link: string | null;
  data: unknown;
  createdAt: string;
};

export async function postWebhook(url: string, secret: string, payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  // fetchJson is SSRF-guarded: a webhook URL is typed by a customer and must
  // not reach the internal network, now or after a DNS change.
  const res = await fetchJson<unknown>(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "SeoTable-Webhook/1",
      "x-seotable-event": payload.event,
      "x-seotable-delivery": payload.id,
      "x-seotable-timestamp": String(timestamp),
      "x-seotable-signature": signWebhook(secret, timestamp, body),
    },
    body,
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError(res.status === 429 ? "rate_limited" : "webhook_rejected", `Webhook answered HTTP ${res.status}`, { status: res.status });
  }
}

export function webhookSecret(rule: Pick<AlertRule, "webhookSecretCipher" | "webhookSecretIv" | "webhookSecretTag">): string | null {
  if (!rule.webhookSecretCipher || !rule.webhookSecretIv || !rule.webhookSecretTag) return null;
  return unseal({ cipher: rule.webhookSecretCipher, iv: rule.webhookSecretIv, tag: rule.webhookSecretTag });
}

// ---------------------------------------------------------------- telegram

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function telegramText(n: Pick<Notification, "title" | "body" | "link">, locale: "fa" | "en", projectName: string | null): string {
  const lines = [`<b>${escapeHtml(n.title[locale])}</b>`];
  if (projectName) lines.push(escapeHtml(projectName));
  lines.push("", escapeHtml(n.body[locale]));
  const link = absoluteLink(n.link);
  if (link && /^https?:\/\//.test(link)) lines.push("", `<a href="${escapeHtml(link)}">${locale === "fa" ? "مشاهده در پنل" : "Open in the panel"}</a>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- delivery job

/**
 * Deliver one notification to one channel. Throws on a failure worth retrying
 * (the queue retries with backoff); returns "skipped" when the channel is no
 * longer set up, which no retry would change.
 */
export async function deliver(
  notificationId: string,
  channel: "webhook" | "telegram",
  opts: { attempt: number; final: boolean },
  partial: Partial<Deps> = {},
): Promise<"sent" | "skipped"> {
  const deps = withDeps(partial);
  const n = (await db.select().from(notifications).where(eq(notifications.id, notificationId)).limit(1))[0];
  if (!n) return "skipped";
  const rule = n.alertRuleId ? (await db.select().from(alertRules).where(eq(alertRules.id, n.alertRuleId)).limit(1))[0] : undefined;
  const project = n.projectId ? (await db.select().from(projects).where(eq(projects.id, n.projectId)).limit(1))[0] : undefined;
  const skip = async (error: string) => {
    await setDelivery(n.id, channel, { status: "skipped", attempts: opts.attempt, error, at: deps.now().toISOString() });
    return "skipped" as const;
  };
  try {
    if (channel === "webhook") {
      const secret = rule ? webhookSecret(rule) : null;
      if (!rule?.webhookUrl || !secret || !rule.channels.includes("webhook")) return await skip("webhook_not_configured");
      await postWebhook(rule.webhookUrl, secret, {
        id: n.id,
        event: n.kind,
        severity: n.severity,
        project: project ? { id: project.id, name: project.name, url: project.baseUrl } : null,
        title: n.title,
        body: n.body,
        link: absoluteLink(n.link),
        data: n.data,
        createdAt: n.createdAt.toISOString(),
      });
    } else {
      const tg = await loadTelegram(n.orgId, deps);
      if (!tg) return await skip("telegram_not_configured");
      const locale = project?.locale === "en" ? "en" : "fa";
      await tg.client.send(tg.chatId, telegramText(n, locale, project?.name ?? null));
    }
  } catch (err) {
    const reason = err instanceof ProviderError ? err.reason : "network_error";
    await setDelivery(n.id, channel, {
      status: opts.final ? "failed" : "pending",
      attempts: opts.attempt,
      error: reason,
      at: deps.now().toISOString(),
    });
    throw err;
  }
  await setDelivery(n.id, channel, { status: "sent", attempts: opts.attempt, error: null, at: deps.now().toISOString() });
  return "sent";
}

// ---------------------------------------------------------------- inbox

export async function listNotifications(
  orgId: string,
  opts: { page: number; perPage: number; unreadOnly?: boolean; projectId?: string },
): Promise<{ unread: number; total: number; page: number; perPage: number; items: Notification[] }> {
  const scope = [eq(notifications.orgId, orgId)];
  if (opts.projectId) scope.push(eq(notifications.projectId, opts.projectId));
  const filtered = opts.unreadOnly ? [...scope, isNull(notifications.readAt)] : scope;
  const [items, totalRow, unreadRow] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(and(...filtered))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(opts.perPage)
      .offset((opts.page - 1) * opts.perPage),
    db.select({ n: count() }).from(notifications).where(and(...filtered)),
    db.select({ n: count() }).from(notifications).where(and(...scope, isNull(notifications.readAt))),
  ]);
  return { unread: unreadRow[0]?.n ?? 0, total: totalRow[0]?.n ?? 0, page: opts.page, perPage: opts.perPage, items };
}

export async function markRead(orgId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.orgId, orgId), inArray(notifications.id, ids), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function markAllRead(orgId: string, projectId?: string): Promise<number> {
  const scope = [eq(notifications.orgId, orgId), isNull(notifications.readAt)];
  if (projectId) scope.push(eq(notifications.projectId, projectId));
  const rows = await db.update(notifications).set({ readAt: new Date() }).where(and(...scope)).returning({ id: notifications.id });
  return rows.length;
}
