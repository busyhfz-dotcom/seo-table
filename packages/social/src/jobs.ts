/**
 * What the worker runs for social projects. Kept here, not in the worker, so
 * tests drive exactly the code production runs.
 */
import { and, db, eq, projects, socialAccounts, sql, type Notification } from "@seo/db";
import { SYSTEM, childLogger, recordAudit, type SocialPublishJobData, type SocialSyncJobData } from "@seo/core";
import { connectedAccount } from "./accounts.js";
import { evaluateAfterSync } from "./alerts.js";
import { runAudit, type AuditOutcome } from "./audit.js";
import { listCompetitors, refreshCompetitors } from "./competitors.js";
import { publishPost, type PublishOutcome } from "./planner.js";
import { pollTelegramUpdates, syncProject, type SyncResult } from "./sync.js";

export type SocialSyncOutcome = {
  sync: SyncResult;
  audit: Pick<AuditOutcome, "runId" | "score" | "proposals"> & { findings: number } | null;
  alerts: number;
  competitors: number;
};

/** Sync, then audit what was synced, refresh competitors, and evaluate the alerts. */
export async function runSocialSyncJob(data: SocialSyncJobData, now = new Date()): Promise<SocialSyncOutcome> {
  const project = (await db.select().from(projects).where(eq(projects.id, data.projectId)).limit(1))[0];
  if (!project || project.kind === "WEBSITE") throw new Error("not a social project");
  const log = childLogger({ component: "social-job", projectId: project.id, correlationId: data.correlationId });
  const sync = await syncProject(project.id, now);
  let audit: SocialSyncOutcome["audit"] = null;
  let alerts: Notification[] = [];
  let competitors = 0;
  if (sync.ok) {
    const actor = data.trigger === "SCHEDULE" ? SYSTEM : { type: "USER" as const, id: data.requestedBy };
    const a = await runAudit({ project, actor, trigger: data.trigger === "SCHEDULE" ? "SCHEDULE" : "MANUAL", now });
    audit = { runId: a.runId, score: a.score, proposals: a.proposals, findings: a.findings.length };
    if ((await listCompetitors(project.id)).length) {
      try {
        competitors = (await refreshCompetitors(project.id, undefined, now)).length;
      } catch (err) {
        log.warn({ err: (err as Error).message }, "competitor refresh failed");
      }
    }
  }
  try {
    alerts = await evaluateAfterSync(project.id, now);
  } catch (err) {
    log.error({ err: (err as Error).message }, "social alert evaluation failed");
  }
  if (sync.tokenRefreshed) {
    await recordAudit({ orgId: project.orgId, actor: SYSTEM, action: "social.token_refresh", targetType: "project", targetId: project.id });
  }
  await recordAudit({
    orgId: project.orgId,
    actor: data.trigger === "SCHEDULE" ? SYSTEM : { type: "USER", id: data.requestedBy },
    action: "social.sync",
    targetType: "project",
    targetId: project.id,
    metadata: { ok: sync.ok, reason: sync.reason, posts: sync.posts, warnings: sync.warnings, score: audit?.score ?? null },
  });
  return { sync, audit, alerts: alerts.length, competitors };
}

export function runSocialPublishJob(data: SocialPublishJobData): Promise<PublishOutcome> {
  return publishPost(data.postId);
}

/** Local development without a public https address: read channel posts every tick instead of by webhook. */
export async function pollTelegramChannels(): Promise<number> {
  const rows = await db
    .select({ projectId: socialAccounts.projectId })
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.platform, "TELEGRAM"),
        eq(socialAccounts.status, "CONNECTED"),
        sql`coalesce(${socialAccounts.profile}->'updates'->>'mode', 'polling') = 'polling'`,
      ),
    )
    .limit(50);
  let total = 0;
  for (const r of rows) {
    try {
      total += await pollTelegramUpdates(await connectedAccount(r.projectId));
    } catch {
      // The daily sync records connection problems; polling stays quiet.
    }
  }
  return total;
}
