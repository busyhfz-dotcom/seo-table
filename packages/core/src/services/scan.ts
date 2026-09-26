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
  cuid,
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
import { BadRequest, Conflict, NotFound, ScanAlreadyRunning } from "../errors.js";
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
  // A social project's base URL is instagram.com or t.me: never ours to crawl.
  if (project.kind !== "WEBSITE") {
    throw new BadRequest("Only website projects can be scanned; this project is audited by the social audit", {
      reason: "not_a_website",
      kind: project.kind,
    });
  }

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
  //    The job id is a pure function of the run id, so it is written with the
  //    row: nothing has to be updated after the job exists.
  const runId = cuid();
  let run: AuditRun;
  try {
    const inserted = await db
      .insert(auditRuns)
      .values({
        id: runId,
        jobId: auditJobId(runId),
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
  //    Only a still-QUEUED row is touched: if the add reached Redis after all
  //    and a worker already picked the run up, it is left to finish. A job that
  //    did land on a FAILED run is a no-op for the worker (analyze skips it).
  try {
    await enqueueAudit({
      runId: run.id,
      projectId: run.projectId,
      requestedBy: input.actor.id ?? input.actor.type,
      correlationId,
    });
  } catch (err) {
    await db
      .update(auditRuns)
      .set({
        status: "FAILED",
        errorCode: "ENQUEUE_FAILED",
        error: (err as Error).message,
        finishedAt: new Date(),
      })
      .where(and(eq(auditRuns.id, run.id), eq(auditRuns.status, "QUEUED")));
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
  log.info({ runId: run.id, jobId: run.jobId }, "scan queued");

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
  // Scoped to the organization here as well as in the route: a run id from
  // another tenant is "not found", never cancellable.
  const run = (
    await db
      .select({ run: auditRuns })
      .from(auditRuns)
      .innerJoin(projects, eq(projects.id, auditRuns.projectId))
      .where(and(eq(auditRuns.id, input.runId), eq(projects.orgId, input.orgId)))
      .limit(1)
  )[0]?.run;
  if (!run) throw new NotFound("Run not found");

  // Conditional on the run still being active, so a run that finished (or was
  // reaped) between the read and this write keeps its terminal state.
  const updated = (
    await db
      .update(auditRuns)
      .set({ status: "CANCELED", finishedAt: new Date() })
      .where(and(eq(auditRuns.id, run.id), inArray(auditRuns.status, ACTIVE)))
      .returning()
  )[0];
  if (!updated) {
    const current = await getRun(run.id);
    throw new Conflict(`Run is ${current?.status ?? run.status} and cannot be cancelled`);
  }

  // Best effort: the worker also checks the row's status between pages. An
  // active job holds a lock and cannot be removed; it notices the status instead.
  const { auditQueue } = await import("../queue.js");
  const job = run.jobId ? await auditQueue.getJob(run.jobId).catch(() => null) : null;
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

// ---------------------------------------------------------------- liveness

const HEARTBEAT_INTERVAL_MS = 15_000;
const lastHeartbeat = new Map<string, number>();

/**
 * Records that the worker processing `runId` is alive. Cheap to call on every
 * crawl progress tick: at most one write per run every 15 s from this process.
 */
export async function heartbeat(runId: string): Promise<void> {
  const now = Date.now();
  const last = lastHeartbeat.get(runId);
  if (last !== undefined && now - last < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeat.set(runId, now);
  // Forget runs that stopped beating so the map stays bounded in a long-lived worker.
  if (lastHeartbeat.size > 1000) {
    for (const [id, at] of lastHeartbeat) {
      if (now - at > HEARTBEAT_INTERVAL_MS) lastHeartbeat.delete(id);
    }
  }
  await db
    .update(auditRuns)
    .set({ heartbeatAt: sql`now()` })
    .where(and(eq(auditRuns.id, runId), inArray(auditRuns.status, ACTIVE)));
}

export type ReapOptions = {
  /** A RUNNING run with no heartbeat for this long is a candidate. Default 15. */
  staleMinutes?: number;
  /** Whether the queue still holds a live job (waiting, delayed, active…) for the run. */
  isJobAlive: (runId: string) => Promise<boolean>;
};

/** A QUEUED row is given this long for its job to reach the queue (createScan inserts first). */
const QUEUED_GRACE_MINUTES = 2;

/**
 * Releases runs that a crashed worker or a lost job left behind, so a hard
 * restart cannot permanently block a project's scans (a QUEUED/RUNNING row holds
 * the one-active-run lock).
 *
 * A run is reaped only when BOTH hold: the database says it has gone quiet, and
 * the queue has no live job for it. A long crawl that keeps beating, or a run
 * waiting behind others, or one in retry backoff, is never touched. If the
 * liveness check itself fails the run is kept — reaping on a guess would free
 * the lock under a crawl that is still running.
 */
export async function reapStaleRuns(opts: ReapOptions): Promise<number> {
  const staleMinutes = opts.staleMinutes ?? 15;
  const queuedGrace = Math.min(QUEUED_GRACE_MINUTES, staleMinutes);
  const lastSignOfLife = sql`coalesce(${auditRuns.heartbeatAt}, ${auditRuns.startedAt}, ${auditRuns.queuedAt})`;
  const runningStale = and(
    eq(auditRuns.status, "RUNNING"),
    sql`${lastSignOfLife} < now() - ${staleMinutes}::double precision * interval '1 minute'`,
  );
  const queuedStale = and(
    eq(auditRuns.status, "QUEUED"),
    sql`${auditRuns.queuedAt} < now() - ${queuedGrace}::double precision * interval '1 minute'`,
  );

  const candidates = await db
    .select({ id: auditRuns.id, status: auditRuns.status })
    .from(auditRuns)
    .where(sql`(${runningStale}) OR (${queuedStale})`);

  let reaped = 0;
  for (const candidate of candidates) {
    const alive = await opts.isJobAlive(candidate.id).catch(() => true);
    if (alive) continue;

    // The staleness condition is re-checked in the UPDATE: a heartbeat or a
    // status change since the SELECT wins over the reaper.
    const error =
      candidate.status === "RUNNING"
        ? `No heartbeat for ${staleMinutes} minutes and no live job; released so the project can be scanned again.`
        : "Queued, but its job is no longer in the queue; released so the project can be scanned again.";
    const rows = await db
      .update(auditRuns)
      .set({ status: "DEAD_LETTER", errorCode: "STALE", error, finishedAt: new Date() })
      .where(and(eq(auditRuns.id, candidate.id), candidate.status === "RUNNING" ? runningStale : queuedStale))
      .returning({ id: auditRuns.id });
    reaped += rows.length;
  }
  if (reaped > 0) metric("scan.reaped", reaped);
  return reaped;
}
