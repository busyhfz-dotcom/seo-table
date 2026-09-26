/**
 * Alert rules and their evaluation.
 *
 * Evaluated where the data is produced:
 *   after a scan        score_drop, new_critical, page_down (homepage in the crawl)
 *   after a rank sync   rank_drop, index_drop, page_down (a daily homepage check)
 *   after PageSpeed     cwv_regression
 *
 * Thresholds, per kind:
 *   score_drop       points the site score fell since the previous successful scan (default 5)
 *   new_critical     none — any CRITICAL issue first seen in this scan (not on a first scan)
 *   rank_drop        positions a tracked keyword fell, 7-day window vs the 7 before (default 5)
 *   page_down        none — homepage unreachable, 5xx, 404 or 410
 *   cwv_regression   performance-score points lost on a page, or Core Web Vitals pass → fail (default 10)
 *   index_drop       % fall in pages with Search Console impressions, last 7 days vs the 7 before (default 20)
 */
import { z } from "zod";
import {
  alertRules,
  and,
  auditRuns,
  db,
  desc,
  eq,
  inArray,
  lt,
  pageSnapshots,
  pageSpeed,
  projects,
  seoIssues,
  type AlertKind,
  type AlertRule,
  type Notification,
  type PageSpeedRow,
  type Project,
} from "@seo/db";
import { BadRequest, NotFound, assertPublicUrl, guardedFetch, newToken, normalizeUrl, seal } from "@seo/core";
import { withDeps, type Deps } from "./deps.js";
import { notify, postWebhook, telegramText, webhookSecret, type AlertEvent } from "./notifications.js";
import { loadTelegram } from "./integrations.js";
import { assessCwv } from "./providers/pagespeed.js";
import { movers } from "./rank.js";
import { daysAgo, isoDate } from "./text.js";

export const ALERT_KINDS: readonly AlertKind[] = [
  "score_drop",
  "new_critical",
  "rank_drop",
  "page_down",
  "cwv_regression",
  "index_drop",
  // Instagram / Telegram projects (evaluated by @seo/social after each sync or publish).
  "follower_drop",
  "engagement_drop",
  "token_expiring",
  "publish_failed",
];

export const DEFAULT_THRESHOLDS: Record<AlertKind, number | null> = {
  score_drop: 5,
  new_critical: null,
  rank_drop: 5,
  page_down: null,
  cwv_regression: 10,
  index_drop: 20,
  /** Percent fewer followers than seven days earlier. */
  follower_drop: 5,
  /** Percent lower engagement (Instagram) or view rate (Telegram), last 10 posts against the 10 before. */
  engagement_drop: 30,
  /** Days before the Instagram token expires with its refresh failing. */
  token_expiring: 7,
  publish_failed: null,
};

const channel = z.enum(["in_app", "webhook", "telegram"]);

function plainHttpAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK === "1" || process.env.NODE_ENV !== "production";
}

const webhookUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => /^https:\/\//i.test(u) || (plainHttpAllowed() && /^http:\/\//i.test(u)), "must be an https URL");

export const createAlertInput = z.object({
  kind: z.enum(ALERT_KINDS as [AlertKind, ...AlertKind[]]),
  threshold: z.number().positive().max(100).nullable().optional(),
  channels: z.array(channel).min(1).max(3).default(["in_app"]),
  webhookUrl: webhookUrl.nullable().optional(),
  enabled: z.boolean().default(true),
});

export const updateAlertInput = z.object({
  threshold: z.number().positive().max(100).nullable().optional(),
  channels: z.array(channel).min(1).max(3).optional(),
  webhookUrl: webhookUrl.nullable().optional(),
  enabled: z.boolean().optional(),
  /** Issue a new signing secret (returned once). */
  rotateSecret: z.boolean().optional(),
});

/** A rule as the API shows it: never the signing secret, only whether one exists. */
export type AlertRuleView = Omit<AlertRule, "webhookSecretCipher" | "webhookSecretIv" | "webhookSecretTag"> & {
  hasWebhookSecret: boolean;
};

export function ruleView(r: AlertRule): AlertRuleView {
  const { webhookSecretCipher, webhookSecretIv: _iv, webhookSecretTag: _tag, ...rest } = r;
  return { ...rest, hasWebhookSecret: Boolean(webhookSecretCipher) };
}

function normaliseThreshold(kind: AlertKind, threshold: number | null | undefined): number | null {
  if (DEFAULT_THRESHOLDS[kind] === null) return null;
  return threshold ?? DEFAULT_THRESHOLDS[kind];
}

async function checkWebhook(channels: string[], url: string | null | undefined): Promise<void> {
  if (channels.includes("webhook") && !url) throw new BadRequest("A webhook channel needs a webhook URL", { field: "webhookUrl" });
  if (url) await assertPublicUrl(url);
}

function newSecret(): { secret: string; sealed: ReturnType<typeof seal> } {
  const secret = `whsec_${newToken(24)}`;
  return { secret, sealed: seal(secret) };
}

export async function listRules(projectId: string): Promise<AlertRuleView[]> {
  const rows = await db.select().from(alertRules).where(eq(alertRules.projectId, projectId)).orderBy(alertRules.kind, alertRules.createdAt);
  return rows.map(ruleView);
}

/** Returns the signing secret once, when the rule has a webhook. */
export async function createRule(
  projectId: string,
  input: z.infer<typeof createAlertInput>,
): Promise<{ rule: AlertRuleView; webhookSecret: string | null }> {
  await checkWebhook(input.channels, input.webhookUrl);
  const s = input.webhookUrl ? newSecret() : null;
  const rule = (
    await db
      .insert(alertRules)
      .values({
        projectId,
        kind: input.kind,
        threshold: normaliseThreshold(input.kind, input.threshold),
        channels: [...new Set(input.channels)],
        webhookUrl: input.webhookUrl ?? null,
        webhookSecretCipher: s?.sealed.cipher ?? null,
        webhookSecretIv: s?.sealed.iv ?? null,
        webhookSecretTag: s?.sealed.tag ?? null,
        enabled: input.enabled,
      })
      .returning()
  )[0]!;
  return { rule: ruleView(rule), webhookSecret: s?.secret ?? null };
}

export async function updateRule(
  projectId: string,
  ruleId: string,
  input: z.infer<typeof updateAlertInput>,
): Promise<{ rule: AlertRuleView; webhookSecret: string | null }> {
  const current = (await db.select().from(alertRules).where(and(eq(alertRules.id, ruleId), eq(alertRules.projectId, projectId))).limit(1))[0];
  if (!current) throw new NotFound("Alert rule not found");
  const channels = input.channels ? [...new Set(input.channels)] : current.channels;
  const url = input.webhookUrl !== undefined ? input.webhookUrl : current.webhookUrl;
  await checkWebhook(channels, url);
  // A new URL gets a new secret: the old receiver's secret must not sign for the new one.
  const needsSecret = Boolean(url) && (input.rotateSecret || !current.webhookSecretCipher || url !== current.webhookUrl);
  const s = needsSecret ? newSecret() : null;
  const updated = (
    await db
      .update(alertRules)
      .set({
        threshold: input.threshold !== undefined ? normaliseThreshold(current.kind, input.threshold) : current.threshold,
        channels,
        webhookUrl: url ?? null,
        enabled: input.enabled ?? current.enabled,
        ...(s ? { webhookSecretCipher: s.sealed.cipher, webhookSecretIv: s.sealed.iv, webhookSecretTag: s.sealed.tag } : {}),
        ...(!url ? { webhookSecretCipher: null, webhookSecretIv: null, webhookSecretTag: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(alertRules.id, ruleId))
      .returning()
  )[0]!;
  return { rule: ruleView(updated), webhookSecret: s?.secret ?? null };
}

export async function deleteRule(projectId: string, ruleId: string): Promise<void> {
  const gone = await db.delete(alertRules).where(and(eq(alertRules.id, ruleId), eq(alertRules.projectId, projectId))).returning({ id: alertRules.id });
  if (!gone[0]) throw new NotFound("Alert rule not found");
}

/**
 * Send a clearly-marked test event through the rule's external channels now,
 * without recording a notification, and report each channel's outcome.
 */
export async function testRule(
  projectId: string,
  ruleId: string,
  partial: Partial<Deps> = {},
): Promise<Record<"webhook" | "telegram", { ok: boolean; reason: string | null } | null>> {
  const deps = withDeps(partial);
  const rule = (await db.select().from(alertRules).where(and(eq(alertRules.id, ruleId), eq(alertRules.projectId, projectId))).limit(1))[0];
  if (!rule) throw new NotFound("Alert rule not found");
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0]!;
  const event = {
    title: { fa: "آزمایش هشدار", en: "Alert test" },
    body: { fa: `این یک پیام آزمایشی برای قانون «${rule.kind}» است.`, en: `This is a test message for the "${rule.kind}" rule.` },
    link: `/alerts?project=${projectId}`,
  };
  const out: Record<"webhook" | "telegram", { ok: boolean; reason: string | null } | null> = { webhook: null, telegram: null };
  const secret = webhookSecret(rule);
  if (rule.channels.includes("webhook") && rule.webhookUrl && secret) {
    try {
      await postWebhook(rule.webhookUrl, secret, {
        id: `test_${newToken(8)}`,
        event: "test",
        severity: "INFO",
        project: { id: project.id, name: project.name, url: project.baseUrl },
        title: event.title,
        body: event.body,
        link: event.link,
        data: { ruleId: rule.id, kind: rule.kind, test: true },
        createdAt: deps.now().toISOString(),
      });
      out.webhook = { ok: true, reason: null };
    } catch (err) {
      out.webhook = { ok: false, reason: (err as { reason?: string }).reason ?? "network_error" };
    }
  }
  if (rule.channels.includes("telegram")) {
    const tg = await loadTelegram(project.orgId, deps);
    if (!tg) out.telegram = { ok: false, reason: "not_configured" };
    else {
      try {
        await tg.client.send(tg.chatId, telegramText(event, project.locale === "en" ? "en" : "fa", project.name));
        out.telegram = { ok: true, reason: null };
      } catch (err) {
        out.telegram = { ok: false, reason: (err as { reason?: string }).reason ?? "network_error" };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- evaluation

async function enabledRules(projectId: string, kinds: AlertKind[]): Promise<AlertRule[]> {
  return db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.projectId, projectId), eq(alertRules.enabled, true), inArray(alertRules.kind, kinds)));
}

const fa = (n: number) => n.toLocaleString("fa-IR", { maximumFractionDigits: 1 });
const en = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** Fire `build(threshold)` for every enabled rule of `kind` whose threshold it meets. */
async function fire(
  project: Project,
  rules: AlertRule[],
  kind: AlertKind,
  build: (threshold: number | null) => AlertEvent | null,
  now: Date,
): Promise<Notification[]> {
  const out: Notification[] = [];
  for (const rule of rules.filter((r) => r.kind === kind)) {
    const event = build(rule.threshold ?? DEFAULT_THRESHOLDS[kind]);
    if (!event) continue;
    const n = await notify({ orgId: project.orgId, projectId: project.id, rule, event, now });
    if (n) out.push(n);
  }
  return out;
}

function pageDownEvent(project: Project, status: number, key: string): AlertEvent {
  const what = status === 0 ? { fa: "پاسخی نداد", en: "did not answer" } : { fa: `کد ${fa(status)} برگرداند`, en: `answered HTTP ${status}` };
  return {
    kind: "page_down",
    severity: "CRITICAL",
    title: { fa: "صفحهٔ اصلی سایت در دسترس نیست", en: "The homepage is down" },
    body: { fa: `${project.baseUrl} ${what.fa}.`, en: `${project.baseUrl} ${what.en}.` },
    link: `/audit?project=${project.id}`,
    data: { url: project.baseUrl, status },
    dedupeKey: key,
  };
}

const isDown = (status: number) => status === 0 || status >= 500 || status === 404 || status === 410;

export async function evaluateAfterScan(runId: string, partial: Partial<Deps> = {}): Promise<Notification[]> {
  const deps = withDeps(partial);
  const run = (await db.select().from(auditRuns).where(eq(auditRuns.id, runId)).limit(1))[0];
  if (!run || run.status !== "SUCCEEDED") return [];
  const project = (await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1))[0];
  if (!project) return [];
  const rules = await enabledRules(project.id, ["score_drop", "new_critical", "page_down"]);
  if (!rules.length) return [];
  const now = deps.now();
  const previous = (
    await db
      .select()
      .from(auditRuns)
      .where(and(eq(auditRuns.projectId, project.id), eq(auditRuns.status, "SUCCEEDED"), lt(auditRuns.queuedAt, run.queuedAt)))
      .orderBy(desc(auditRuns.queuedAt))
      .limit(1)
  )[0];
  const out: Notification[] = [];

  if (previous?.score != null && run.score != null) {
    const drop = previous.score - run.score;
    out.push(
      ...(await fire(project, rules, "score_drop", (t) =>
        drop >= (t ?? 5)
          ? {
              kind: "score_drop",
              severity: drop >= 15 ? "CRITICAL" : "SERIOUS",
              title: { fa: `امتیاز سئو ${fa(drop)} واحد افت کرد`, en: `SEO score fell ${en(drop)} points` },
              body: {
                fa: `امتیاز از ${fa(previous.score!)} به ${fa(run.score!)} رسید.`,
                en: `The score went from ${en(previous.score!)} to ${en(run.score!)}.`,
              },
              link: `/audit?project=${project.id}`,
              data: { runId, previousRunId: previous.id, score: run.score, previousScore: previous.score },
              dedupeKey: `score_drop:${runId}`,
            }
          : null,
      now)),
    );
  }

  // The first scan finds everything for the first time; "new" only means something against a baseline.
  if (previous) {
    const fresh = await db
      .select({ id: seoIssues.id, title: seoIssues.title, pageCount: seoIssues.pageCount })
      .from(seoIssues)
      .where(and(eq(seoIssues.projectId, project.id), eq(seoIssues.firstSeenRunId, runId), eq(seoIssues.severity, "CRITICAL"), eq(seoIssues.status, "OPEN")));
    if (fresh.length) {
      out.push(
        ...(await fire(project, rules, "new_critical", () => ({
          kind: "new_critical",
          severity: "CRITICAL",
          title: { fa: `${fa(fresh.length)} مشکل بحرانی تازه`, en: `${en(fresh.length)} new critical issue${fresh.length === 1 ? "" : "s"}` },
          body: {
            fa: fresh.slice(0, 5).map((i) => `• ${i.title}`).join("\n"),
            en: fresh.slice(0, 5).map((i) => `• ${i.title}`).join("\n"),
          },
          link: `/issues?project=${project.id}&severity=CRITICAL`,
          data: { runId, issueIds: fresh.map((i) => i.id) },
          dedupeKey: `new_critical:${runId}`,
        }), now)),
      );
    }
  }

  const home = normalizeUrl(project.baseUrl);
  const snap = home
    ? (await db
        .select({ statusCode: pageSnapshots.statusCode })
        .from(pageSnapshots)
        .where(and(eq(pageSnapshots.auditRunId, runId), eq(pageSnapshots.normalizedUrl, home)))
        .limit(1))[0]
    : undefined;
  if (snap && isDown(snap.statusCode)) {
    out.push(...(await fire(project, rules, "page_down", () => pageDownEvent(project, snap.statusCode, `page_down:${runId}`), now)));
  }
  return out;
}

/** Fetch the homepage once (following up to five same-site redirects); 0 = no answer. */
export async function homepageStatus(baseUrl: string): Promise<number> {
  let url = baseUrl;
  for (let hop = 0; hop < 6; hop++) {
    try {
      const res = await guardedFetch(url, { method: "GET", timeoutMs: 20_000, maxBytes: 256 * 1024, headers: { accept: "text/html" } });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        continue;
      }
      return res.status;
    } catch {
      return 0;
    }
  }
  return 0;
}

export async function evaluateAfterRankSync(projectId: string, partial: Partial<Deps> = {}): Promise<Notification[]> {
  const deps = withDeps(partial);
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) return [];
  const rules = await enabledRules(projectId, ["rank_drop", "index_drop", "page_down"]);
  if (!rules.length) return [];
  const now = deps.now();
  const today = isoDate(now);
  const out: Notification[] = [];

  if (rules.some((r) => r.kind === "rank_drop")) {
    const [gsc, serp] = await Promise.all([
      movers(projectId, { days: 7, source: "gsc", limit: 100 }),
      movers(projectId, { days: 1, source: "dataforseo", limit: 100 }),
    ]);
    out.push(
      ...(await fire(project, rules, "rank_drop", (t) => {
        const threshold = t ?? 5;
        const dropped = new Map<string, { phrase: string; from: number; to: number; source: string }>();
        for (const [source, m] of [["dataforseo", serp], ["gsc", gsc]] as const) {
          for (const l of m.losses) {
            if (l.change === null || -l.change < threshold || dropped.has(l.keywordId)) continue;
            dropped.set(l.keywordId, { phrase: l.phrase, from: l.previousPosition!, to: l.position!, source });
          }
        }
        if (!dropped.size) return null;
        const list = [...dropped.values()].sort((a, b) => b.to - b.from - (a.to - a.from));
        const lines = (loc: "fa" | "en") =>
          list
            .slice(0, 10)
            .map((d) => (loc === "fa" ? `• ${d.phrase}: ${fa(d.from)} ← ${fa(d.to)}` : `• ${d.phrase}: ${en(d.from)} → ${en(d.to)}`))
            .join("\n");
        const anchor = gsc.current?.to ?? serp.current?.to ?? today;
        return {
          kind: "rank_drop",
          severity: "SERIOUS",
          title: {
            fa: `افت رتبهٔ ${fa(list.length)} کلمهٔ کلیدی`,
            en: `${en(list.length)} tracked keyword${list.length === 1 ? "" : "s"} dropped`,
          },
          body: { fa: lines("fa"), en: lines("en") },
          link: `/keywords?project=${projectId}`,
          data: { keywords: [...dropped.entries()].map(([id, d]) => ({ keywordId: id, ...d })), threshold },
          dedupeKey: `rank_drop:${projectId}:${anchor}`,
        };
      }, now)),
    );
  }

  if (rules.some((r) => r.kind === "index_drop")) {
    const window = async (fromDays: number, toDays: number) =>
      deps.gsc.query(projectId, { start: daysAgo(fromDays, now), end: daysAgo(toDays, now), dimensions: ["page"], limit: 25_000 });
    // Search Console lags ~3 days; comparing the most recent complete weeks.
    const current = await window(9, 3);
    const previous = current ? await window(16, 10) : null;
    if (current && previous && previous.length >= 10) {
      const drop = ((previous.length - current.length) / previous.length) * 100;
      out.push(
        ...(await fire(project, rules, "index_drop", (t) =>
          drop >= (t ?? 20)
            ? {
                kind: "index_drop",
                severity: "SERIOUS",
                title: {
                  fa: `صفحات دارای نمایش در گوگل ${fa(Math.round(drop))}٪ کم شد`,
                  en: `Pages shown in Google fell ${en(Math.round(drop))}%`,
                },
                body: {
                  fa: `صفحاتی که در Search Console نمایش داشتند از ${fa(previous.length)} به ${fa(current.length)} رسید (هفتهٔ اخیر در برابر هفتهٔ قبل).`,
                  en: `Pages with Search Console impressions went from ${en(previous.length)} to ${en(current.length)} (latest week vs the week before).`,
                },
                link: `/connectors?project=${projectId}`,
                data: { previousPages: previous.length, currentPages: current.length, dropPercent: Math.round(drop) },
                dedupeKey: `index_drop:${projectId}:${isoDate(daysAgo(3, now))}`,
              }
            : null,
        now)),
      );
    }
  }

  if (rules.some((r) => r.kind === "page_down")) {
    const status = await homepageStatus(project.baseUrl);
    if (isDown(status)) out.push(...(await fire(project, rules, "page_down", () => pageDownEvent(project, status, `page_down:${projectId}:${today}`), now)));
  }
  return out;
}

export async function evaluateAfterPageSpeed(projectId: string, measured: PageSpeedRow[], partial: Partial<Deps> = {}): Promise<Notification[]> {
  const deps = withDeps(partial);
  if (!measured.length) return [];
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) return [];
  const rules = await enabledRules(projectId, ["cwv_regression"]);
  if (!rules.length) return [];
  const pairs: Array<{ current: PageSpeedRow; previous: PageSpeedRow }> = [];
  for (const m of measured) {
    const previous = (
      await db
        .select()
        .from(pageSpeed)
        .where(and(eq(pageSpeed.projectId, projectId), eq(pageSpeed.url, m.url), eq(pageSpeed.strategy, m.strategy), lt(pageSpeed.fetchedAt, m.fetchedAt)))
        .orderBy(desc(pageSpeed.fetchedAt))
        .limit(1)
    )[0];
    if (previous) pairs.push({ current: m, previous });
  }
  const batch = measured[0]!.fetchedAt.toISOString();
  return fire(project, rules, "cwv_regression", (t) => {
    const threshold = t ?? 10;
    const hits = pairs.flatMap(({ current, previous }) => {
      const lost = previous.performanceScore !== null && current.performanceScore !== null ? previous.performanceScore - current.performanceScore : 0;
      const failedNow = assessCwv(previous).passed && !assessCwv(current).passed;
      return lost >= threshold || failedNow
        ? [{ url: current.url, strategy: current.strategy, from: previous.performanceScore, to: current.performanceScore, cwvFailed: failedNow }]
        : [];
    });
    if (!hits.length) return null;
    const strategyFa = (s: string) => (s === "mobile" ? "موبایل" : "دسکتاپ");
    return {
      kind: "cwv_regression",
      severity: hits.some((h) => h.cwvFailed) ? "SERIOUS" : "WARNING",
      title: { fa: `افت سرعت در ${fa(hits.length)} صفحه`, en: `Page speed regressed on ${en(hits.length)} page${hits.length === 1 ? "" : "s"}` },
      body: {
        fa: hits
          .slice(0, 10)
          .map((h) => `• ${h.url} (${strategyFa(h.strategy)}): ${h.from === null ? "—" : fa(h.from)} ← ${h.to === null ? "—" : fa(h.to)}${h.cwvFailed ? " — Core Web Vitals رد شد" : ""}`)
          .join("\n"),
        en: hits
          .slice(0, 10)
          .map((h) => `• ${h.url} (${h.strategy}): ${h.from ?? "—"} → ${h.to ?? "—"}${h.cwvFailed ? " — Core Web Vitals now failing" : ""}`)
          .join("\n"),
      },
      link: `/pagespeed?project=${projectId}`,
      data: { pages: hits, threshold },
      dedupeKey: `cwv_regression:${projectId}:${batch}`,
    };
  }, deps.now());
}

