/**
 * What the worker runs for each data job and for each due schedule. Kept here,
 * not in the worker, so tests drive exactly the code production runs.
 */
import {
  SYSTEM,
  ScanAlreadyRunning,
  enqueueCompetitors,
  enqueuePageSpeed,
  enqueueRankSync,
  enqueueReport,
  newToken,
  scanService,
  type CompetitorJobData,
  type PageSpeedJobData,
  type RankJobData,
} from "@seo/core";
import type { Notification } from "@seo/db";
import { evaluateAfterPageSpeed, evaluateAfterRankSync } from "./alerts.js";
import { snapshotCompetitors, type SnapshotResult } from "./competitors.js";
import type { Deps } from "./deps.js";
import { runPageSpeed, type PageSpeedRunResult } from "./pagespeed.js";
import { syncRank, type RankSyncResult } from "./rank.js";
import type { Dispatch } from "./schedules.js";

export async function runRankJob(
  data: RankJobData,
  deps: Partial<Deps> = {},
): Promise<{ sync: RankSyncResult; alerts: number }> {
  const sync = await syncRank(data.projectId, deps);
  const alerts: Notification[] = await evaluateAfterRankSync(data.projectId, deps);
  return { sync, alerts: alerts.length };
}

export async function runPageSpeedJob(
  data: PageSpeedJobData,
  deps: Partial<Deps> = {},
): Promise<{ measured: number; failed: PageSpeedRunResult["failed"]; alerts: number }> {
  const result = await runPageSpeed(data.projectId, { urls: data.urls }, deps);
  const alerts = await evaluateAfterPageSpeed(data.projectId, result.measured, deps);
  return { measured: result.measured.length, failed: result.failed, alerts: alerts.length };
}

export async function runCompetitorJob(
  data: CompetitorJobData,
  signal?: AbortSignal,
  deps: Partial<Deps> = {},
): Promise<SnapshotResult> {
  return snapshotCompetitors(data.projectId, { competitorId: data.competitorId, signal }, deps);
}

/** A due schedule becomes a job (a scan becomes a run row plus its job). */
export const dispatchSchedule: Dispatch = async (s) => {
  const base = { projectId: s.projectId, trigger: "SCHEDULE" as const, requestedBy: "scheduler", correlationId: `sched-${newToken(6)}` };
  switch (s.kind) {
    case "scan":
      try {
        await scanService.createScan({
          projectId: s.projectId,
          orgId: s.orgId,
          actor: SYSTEM,
          trigger: "SCHEDULE",
          // One run per schedule firing, even if this dispatch is retried.
          idempotencyKey: `schedule-${s.id}-${Math.floor(Date.now() / 60_000)}`,
          bypassRateLimit: true,
          correlationId: base.correlationId,
        });
      } catch (err) {
        // A scan already running covers this firing; the schedule records why it did not start one.
        if (err instanceof ScanAlreadyRunning) throw Object.assign(new Error("scan_active"), { code: "scan_active" });
        throw err;
      }
      return;
    case "rank":
      await enqueueRankSync(base);
      return;
    case "pagespeed":
      await enqueuePageSpeed(base);
      return;
    case "competitors":
      await enqueueCompetitors(base);
      return;
    case "report":
      await enqueueReport({ ...base, kind: "executive" });
      return;
  }
};
