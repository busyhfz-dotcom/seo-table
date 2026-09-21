/**
 * Scan lifecycle.
 *
 * Starting a scan has to be safe under three kinds of duplication:
 *   - the same request replayed (Idempotency-Key → the original run is returned);
 *   - two different requests racing (partial unique index → 409);
 *   - a queue retry (job id derived from the run id → one job).
 */
import {
  and,
  auditRuns,
  db,
  desc,
  eq,
  inArray,
  isUniqueViolation,
  projects,
  sql,
  type AuditRun,
  type RunTrigger,
} from "@seo/db";
import { Conflict, NotFound, ScanAlreadyRunning } from "../errors.js";
import { childLogger, metric } from "../logger.js";
import { auditJobId, enqueueAudit } from "../queue.js";
import { scanLimit } from "../ratelimit.js";
import { record as recordAudit, type Actor } from "../auditlog.js";
import { newToken } from "../crypto.js";

const ACTIVE: AuditRun["status"][] = ["QUEUED", "RUNNING"];

export type CreateScanInput = {
  projectId: string;
  orgId: string;
  actor: Actor;
  trigger?: RunTrigger;
  /** Client-supplied Idempotency-Key. One is generated when absent. */
  idempotencyKey?: string;
  correlationId?: string;
  /** Skips the per-project rate limit; only the scheduler may set it. */
  bypassRateLimit?: boolean;
};

export type CreateScanResult = {
  run: AuditRun;
  /** True when an existing run was returned instead of a new one being created. */
  replayed: boolean;
};

export async function createScan(input: CreateScanInput): Promise<CreateScanResult> {
  const log = childLogger({ component: "scan", projectId: input.projectId });
  const idempotencyKey = input.idempotencyKey ?? `auto-${newToken(12)}`;
  const correlationId = input.correlationId ?? newToken(8);

  const project = (
    await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1)
  )[0];
  if (!project) throw new NotFound("Project not found");
  if (project.orgId !== input.orgId) throw new NotFound("Project not found");

  // 1) Replay: the same key always returns the same run, never a second crawl.
  const existingByKey = (
    await db
      .select()
      .from(auditRuns)
      .where(
        and(eq(auditRuns.projectId, input.projectId), eq(auditRuns.idempotencyKey, idempotencyKey)),
      )
      .limit(1)
  )[0];
  if (existingByKey) {
    log.info({ runId: existingByKey.id, idempotencyKey }, "scan request replayed");
    metric("scan.replayed");
    return { run: existingByKey, replayed: true };
  }

  // 2) Overlap: refuse while a run is active. The index below is the real guard;
  //    this read only produces the nicer error message with the active run id.
  const active = (
    await db
      .select()
      .from(auditRuns)
      .where(and(eq(auditRuns.projectId, input.projectId), inArray(auditRuns.status, ACTIVE)))
      .limit(1)
  )[0];
  if (active) {
    await recordAudit({
      orgId: input.orgId,
      actor: input.actor,
      action: "scan.refused_overlap",
      targetType: "project",
      targetId: input.projectId,
      metadata: { activeRunId: active.id },
    });
    metric("scan.refused_overlap");
    throw new ScanAlreadyRunning(active.id);
  }

  if (!input.bypassRateLimit) await scanLimit(input.projectId);

  // 3) Insert. A concurrent request loses here rather than in application code.
  let run: AuditRun;
  try {
    const inserted = await db
      .insert(auditRuns)
      .values({
        projectId: input.projectId,
        status: "QUEUED",
        trigger: input.trigger ?? "MANUAL",
        idempotencyKey,
        pagesTotal: project.pageCap,
        createdById: input.actor.id ?? null,
      })
      .returning();
    run = inserted[0]!;
  } catch (err) {
    if (isUniqueViolation(err, "audit_runs_one_active_per_project")) {
      metric("scan.refused_overlap_race");
      throw new ScanAlreadyRunning();
    }
    if (isUniqueViolation(err, "audit_runs_project_idem_uq")) {
      const again = (
        await db
          .select()
          .from(auditRuns)
          .where(
            and(
              eq(auditRuns.projectId, input.projectId),
              eq(auditRuns.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
      )[0];
      if (again) return { run: again, replayed: true };
    }
    throw err;
  }

  // 4) Enqueue. If this throws the run is marked FAILED rather than left QUEUED
  //    forever, because a QUEUED row blocks every future scan of the project.
  try {
    const jobId = await enqueueAudit({
      runId: run.id,
      projectId: run.projectId,
      requestedBy: input.actor.id ?? input.actor.type,
      correlationId,
    });
    const updated = await db
      .update(auditRuns)
      .set({ jobId })
      .where(eq(auditRuns.id, run.id))
      .returning();
    run = updated[0] ?? run;
  } catch (err) {
    await db
      .update(auditRuns)
      .set({
        status: "FAILED",
        errorCode: "ENQUEUE_FAILED",
        error: (err as Error).message,
        finishedAt: new Date(),
      })
      .where(eq(auditRuns.id, run.id));
    throw new Conflict("Could not queue the scan; the job queue is unavailable");
  }

  await recordAudit({
    orgId: input.orgId,
    actor: input.actor,
    action: "scan.enqueue",
    targetType: "audit_run",
    targetId: run.id,
    metadata: { idempotencyKey, correlationId, trigger: run.trigger },
  });
  metric("scan.enqueued");
  log.info({ runId: run.id, jobId: auditJobId(run.id) }, "scan queued");

  return { run, replayed: false };
}

export async function getRun(runId: string): Promise<AuditRun | null> {
  const rows = await db.select().from(auditRuns).where(eq(auditRuns.id, runId)).limit(1);
  return rows[0] ?? null;
}

export async function latestRun(projectId: string): Promise<AuditRun | null> {
  const rows = await db
    .select()
    .from(auditRuns)
    .where(eq(auditRuns.projectId, projectId))
    .orderBy(desc(auditRuns.queuedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function activeRun(projectId: string): Promise<AuditRun | null> {
  const rows = await db
    .select()
    .from(auditRuns)
    .where(and(eq(auditRuns.projectId, projectId), inArray(auditRuns.status, ACTIVE)))
    .limit(1);
  return rows[0] ?? null;
}

export async function cancelScan(input: {
  runId: string;
  orgId: string;
  actor: Actor;
}): Promise<AuditRun> {
  const run = await getRun(input.runId);
  if (!run) throw new NotFound("Run not found");
  if (!ACTIVE.includes(run.status)) {
    throw new Conflict(`Run is ${run.status} and cannot be cancelled`);
  }
  const updated = (
    await db
      .update(auditRuns)
      .set({ status: "CANCELED", finishedAt: new Date() })
      .where(eq(auditRuns.id, run.id))
      .returning()
  )[0]!;

  // Best effort: the worker also checks the row's status between pages.
  const { auditQueue } = await import("../queue.js");
  const job = run.jobId ? await auditQueue.getJob(run.jobId) : null;
  await job?.remove().catch(() => {});

  await recordAudit({
    orgId: input.orgId,
    actor: input.actor,
    action: "scan.cancel",
    targetType: "audit_run",
    targetId: run.id,
  });
  return updated;
}

/**
 * Releases runs that a crashed worker left behind. Called by the worker on
 * startup and by the readiness probe, so a hard restart cannot permanently block
 * a project's scans.
 */
export async function reapStaleRuns(olderThanMinutes = 60): Promise<number> {
  const result = await db
    .update(auditRuns)
    .set({
      status: "DEAD_LETTER",
      errorCode: "STALE",
      error: `Run exceeded ${olderThanMinutes} minutes with no completion; released so the project can be scanned again.`,
      finishedAt: new Date(),
    })
    .where(
      and(
        inArray(auditRuns.status, ACTIVE),
        sql`${auditRuns.queuedAt} < now() - (${olderThanMinutes} || ' minutes')::interval`,
      ),
    )
    .returning({ id: auditRuns.id });
  if (result.length > 0) metric("scan.reaped", result.length);
  return result.length;
}
