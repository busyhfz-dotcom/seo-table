/**
 * Worker process. BullMQ workers (scans, fix executions, and the SEO data jobs:
 * rank sync, PageSpeed, competitor snapshots, alert delivery), the schedule
 * loop, and a tiny HTTP server for health checks, because Railway needs
 * something to probe and "is the queue draining" is the question worth
 * answering.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import {
  AUDIT_QUEUE,
  COMPETITOR_QUEUE,
  FIX_QUEUE,
  NOTIFY_QUEUE,
  PAGESPEED_QUEUE,
  RANK_QUEUE,
  auditJobId,
  auditQueue,
  childLogger,
  closeQueues,
  closeRedis,
  commandReady,
  env,
  logger,
  metric,
  pingRedis,
  queueDepth,
  queuePrefix,
  redis,
  scanService,
  workerConcurrency,
  type AuditJobData,
  type CompetitorJobData,
  type FixJobData,
  type NotifyJobData,
  type PageSpeedJobData,
  type RankJobData,
} from "@seo/core";
import { closeDb, pingDb, pool } from "@seo/db";
import { BrowserManager } from "@seo/browser";
import { analyze, execute, isPermanentFailure, markRunFailed, runAgent } from "@seo/pipeline";
import {
  alertService,
  dispatchSchedule,
  notificationService,
  runCompetitorJob,
  runPageSpeedJob,
  runRankJob,
  scheduleService,
} from "@seo/seo-data";
import { browserApi } from "./browser-api.js";

process.env.SERVICE_NAME ??= "seo-worker";

const log = childLogger({ component: "worker" });
let shuttingDown = false;
let auditWorker: Worker<AuditJobData> | undefined;
let fixWorker: Worker<FixJobData> | undefined;
/** Rank sync, PageSpeed, competitor snapshots and alert delivery. */
const dataWorkers: Worker[] = [];
let reaperTimer: NodeJS.Timeout | undefined;
let schedulerTimer: NodeJS.Timeout | undefined;
/** Created on the first browser request; Chromium itself starts only when a session or render needs it. */
let browserManager: BrowserManager | undefined;

/** Readiness answers within this, whatever state Postgres and Redis are in. */
const PROBE_TIMEOUT_MS = 2_500;
/** Railway sends SIGKILL `drainingSeconds` (60, railway.json) after SIGTERM. */
const DRAIN_TIMEOUT_MS = 50_000;
const SHUTDOWN_HARD_LIMIT_MS = 57_000;
const REAP_EVERY_MS = 5 * 60_000;
const REAP_STALE_MINUTES = 15;
const MIGRATION_WAIT_MS = 3 * 60_000;
const SCHEDULER_EVERY_MS = 60_000;
/** BullMQ states in which a job will still run (or is running). */
const ALIVE_STATES = new Set(["active", "waiting", "delayed", "prioritized", "waiting-children"]);

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

// ---- health server ---------------------------------------------------------
// Started first so the platform can see the process while it waits for the
// schema; /api/ready stays 503 until the workers run.
// Railway injects PORT for every service; the worker binds its health server to it.
const port = env().PORT ?? 3001;
const handleBrowser = browserApi({
  manager: () =>
    (browserManager ??= new BrowserManager({
      maxSessions: env().BROWSER_MAX_SESSIONS,
      maxSessionsPerOrg: env().BROWSER_MAX_SESSIONS_PER_ORG,
      maxRenders: env().BROWSER_MAX_RENDERS,
      idleMs: env().BROWSER_IDLE_TIMEOUT_MS,
      maxSessionMs: env().BROWSER_MAX_SESSION_MS,
      executablePath: env().BROWSER_EXECUTABLE_PATH,
    })),
  sessionSecret: env().SESSION_SECRET,
  draining: () => shuttingDown,
});
const server = createServer(async (req, res) => {
  if (await handleBrowser(req, res)) return;
  if (req.url === "/health" || req.url === "/api/health") {
    res.writeHead(shuttingDown ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: shuttingDown ? "draining" : "ok", service: "worker" }));
    return;
  }
  if (req.url === "/ready" || req.url === "/api/ready") {
    // pg waits up to its 10 s connect timeout and a queue count up to 5 s;
    // a probe must answer sooner than the platform gives up on it.
    const [dbOk, redisOk, depth] = await Promise.all([
      withTimeout(pingDb(), PROBE_TIMEOUT_MS, false),
      pingRedis(),
      withTimeout(queueDepth(), PROBE_TIMEOUT_MS, null),
    ]);
    const started = Boolean(auditWorker && fixWorker);
    const ok = dbOk && redisOk && started && !shuttingDown;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: ok ? "ready" : started ? "not_ready" : "starting",
        checks: { database: dbOk, redis: redisOk },
        queue: depth,
        workers: {
          audit: auditWorker?.isRunning() ?? false,
          fix: fixWorker?.isRunning() ?? false,
          data: dataWorkers.length > 0 && dataWorkers.every((w) => w.isRunning()),
        },
      }),
    );
    return;
  }
  res.writeHead(404).end();
});
// "::" because Railway's private network (how web reaches /internal/browser) is
// IPv6; on a host without IPv6 it falls back to every IPv4 interface.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EAFNOSUPPORT" && err.syscall === "listen") {
    server.listen(port, "0.0.0.0");
    return;
  }
  log.error({ err: err.message }, "worker HTTP server error");
  process.exit(1);
});
server.on("listening", () => log.info({ address: server.address() }, "worker HTTP server listening"));
server.listen(port, "::");

// ---- graceful shutdown -----------------------------------------------------
async function closeWorkers(): Promise<void> {
  const workers = [auditWorker, fixWorker, ...dataWorkers].filter((w): w is Worker => w !== undefined);
  // close() lets in-flight jobs finish; an interrupted crawl would otherwise be
  // picked up again only after BullMQ notices the stall.
  const drained = await withTimeout(
    Promise.allSettled(workers.map((w) => w.close())).then(() => true),
    DRAIN_TIMEOUT_MS,
    false,
  );
  if (!drained) {
    // Out of time: stop waiting. The unfinished jobs lose their lock and another
    // worker retries them (the run is still QUEUED/RUNNING, so analyze resumes it).
    log.warn({ timeoutMs: DRAIN_TIMEOUT_MS }, "jobs still running at the drain deadline; forcing close");
    await withTimeout(Promise.allSettled(workers.map((w) => w.close(true))), 3_000, []);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  // Whatever hangs below (a Redis quit during an outage, say), exit before SIGKILL.
  setTimeout(() => process.exit(1), SHUTDOWN_HARD_LIMIT_MS).unref();
  let code = 0;
  try {
    clearInterval(reaperTimer);
    clearInterval(schedulerTimer);
    server.close();
    // Browser sessions end with the process; closing Chromium properly frees its
    // temp profiles instead of leaving them to the container.
    await Promise.all([closeWorkers(), browserManager?.close()]);
    await closeQueues();
    await closeRedis();
    await closeDb();
  } catch (err) {
    code = 1;
    log.error({ err: (err as Error).message }, "shutdown did not complete cleanly");
  } finally {
    logger.flush?.();
    process.exit(code);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandled rejection"));

// ---- wait for the schema -----------------------------------------------------
/**
 * The web service applies migrations when it starts; on a fresh deploy both
 * services start together, and a worker querying a column that does not exist
 * yet would fail every job. Wait until the newest migration in the repository is
 * recorded as applied (drizzle stores each migration's journal timestamp).
 */
async function waitForMigrations(): Promise<void> {
  const journalUrl = new URL("../../../packages/db/migrations/meta/_journal.json", import.meta.url);
  const journal = JSON.parse(await readFile(journalUrl, "utf8")) as { entries: { when: number; tag: string }[] };
  const latest = journal.entries.at(-1);
  if (!latest) return;

  const deadline = Date.now() + MIGRATION_WAIT_MS;
  let delay = 1_000;
  for (;;) {
    try {
      const res = await pool.query<{ last: string | null }>(
        "select max(created_at)::text as last from drizzle.__drizzle_migrations",
      );
      const last = res.rows[0]?.last;
      if (last && Number(last) >= latest.when) return;
    } catch {
      // No migrations table yet, or the database is still unreachable.
    }
    if (Date.now() + delay > deadline) {
      throw new Error(`database schema is not at ${latest.tag} after ${MIGRATION_WAIT_MS / 1000}s`);
    }
    log.info({ waitingFor: latest.tag, retryInMs: delay }, "waiting for the web service to apply migrations");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 15_000);
  }
}

try {
  await waitForMigrations();
} catch (err) {
  log.error({ err: (err as Error).message }, "worker cannot start");
  // Exit non-zero so the platform's restart policy tries again later.
  await closeDb().catch(() => {});
  process.exit(1);
}

// ---- stale-run reaper ------------------------------------------------------
async function isJobAlive(runId: string): Promise<boolean> {
  // Throws when Redis is unavailable, and the reaper keeps a run whose liveness is unknown.
  await commandReady();
  const job = await auditQueue.getJob(auditJobId(runId));
  if (!job) return false;
  return ALIVE_STATES.has(await job.getState());
}

let reaping = false;
async function reap(): Promise<void> {
  if (reaping || shuttingDown) return;
  reaping = true;
  try {
    const reaped = await scanService.reapStaleRuns({ staleMinutes: REAP_STALE_MINUTES, isJobAlive });
    if (reaped > 0) log.warn({ reaped }, "released stale runs");
  } catch (err) {
    log.error({ err: (err as Error).message }, "stale-run reaper failed");
  } finally {
    reaping = false;
  }
}

// A previous process that crashed can leave runs holding their project's lock.
await reap();
reaperTimer = setInterval(() => void reap(), REAP_EVERY_MS);

// ---- workers ---------------------------------------------------------------
auditWorker = new Worker<AuditJobData>(
  AUDIT_QUEUE,
  async (job: Job<AuditJobData>) => {
    const jobLog = childLogger({
      component: "audit-job",
      jobId: job.id,
      runId: job.data.runId,
      correlationId: job.data.correlationId,
    });
    jobLog.info({ attempt: job.attemptsMade + 1 }, "run started");

    const controller = new AbortController();
    const onCancelCheck = setInterval(async () => {
      try {
        const run = await scanService.getRun(job.data.runId);
        if (run?.status === "CANCELED") controller.abort();
      } catch (err) {
        // A missed check is retried on the next tick; it must not become an unhandled rejection.
        jobLog.warn({ err: (err as Error).message }, "cancel check failed");
      }
    }, 5_000);

    let outcome: Awaited<ReturnType<typeof analyze>>;
    try {
      outcome = await analyze(job.data.runId, controller.signal);
    } catch (err) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      let final = isLastAttempt || isPermanentFailure(err);
      try {
        final = (await markRunFailed(job.data.runId, err, isLastAttempt)).final;
      } catch (markErr) {
        // The `failed` listener tries again once BullMQ has recorded the failure.
        jobLog.error({ err: (markErr as Error).message }, "could not record the failed attempt");
      }
      jobLog.error(
        { err: (err as Error).message, attempt: job.attemptsMade + 1, final },
        final ? "run failed permanently" : "run attempt failed, will retry",
      );
      // A final failure must not be retried by BullMQ: the run is already dead.
      if (final) throw new UnrecoverableError((err as Error).message ?? String(err));
      throw err;
    } finally {
      clearInterval(onCancelCheck);
    }

    if (outcome.canceled || outcome.skipped) {
      jobLog.info({ canceled: outcome.canceled, skipped: outcome.skipped }, "run not analysed further");
      return { runId: outcome.runId, canceled: outcome.canceled, skipped: outcome.skipped };
    }

    // The agent runs after analysis, in the same job, so a scan and its
    // automatic fixes are one unit of work with one audit trail. Its failure is
    // its own: the scan already succeeded and must stay that way.
    let agent: Awaited<ReturnType<typeof runAgent>> | { error: string };
    try {
      agent = await runAgent(job.data.projectId);
    } catch (err) {
      metric("agent.failed");
      jobLog.error({ err: (err as Error).message }, "agent failed after a successful scan");
      agent = { error: (err as Error).message };
    }
    // Alerts (score drop, new critical issues, homepage down) after the scan is
    // final; a failure here is logged and never fails the scan.
    let alerts = 0;
    try {
      alerts = (await alertService.evaluateAfterScan(outcome.runId)).length;
    } catch (err) {
      jobLog.error({ err: (err as Error).message }, "alert evaluation failed after a scan");
    }
    return { runId: outcome.runId, score: outcome.score, pagesCrawled: outcome.pagesCrawled, agent, alerts };
  },
  { connection: redis, concurrency: workerConcurrency(), lockDuration: 300_000, prefix: queuePrefix() },
);

fixWorker = new Worker<FixJobData>(
  FIX_QUEUE,
  async (job: Job<FixJobData>) => {
    const outcome = await execute({
      proposalId: job.data.proposalId,
      dryRun: job.data.dryRun,
      actor: { type: job.data.requestedBy === "agent" ? "AGENT" : "USER", id: job.data.requestedBy },
    });
    log.info(
      { jobId: job.id, proposalId: job.data.proposalId, status: outcome.status, applied: outcome.applied, failed: outcome.failed },
      "fix execution finished",
    );
    return outcome;
  },
  { connection: redis, concurrency: 1, lockDuration: 120_000, prefix: queuePrefix() },
);

// ---- SEO data workers ---------------------------------------------------------
// Each job is idempotent (upserts keyed by day, dedupe keys on notifications),
// so BullMQ's retries and a stalled job picked up again are safe.
const dataOpts = { connection: redis, prefix: queuePrefix() };
dataWorkers.push(
  new Worker<RankJobData>(RANK_QUEUE, async (job) => runRankJob(job.data), { ...dataOpts, concurrency: 2, lockDuration: 300_000 }),
  // One at a time: PageSpeed Insights quota is per key, and the key is shared.
  new Worker<PageSpeedJobData>(PAGESPEED_QUEUE, async (job) => runPageSpeedJob(job.data), { ...dataOpts, concurrency: 1, lockDuration: 600_000 }),
  new Worker<CompetitorJobData>(COMPETITOR_QUEUE, async (job) => runCompetitorJob(job.data), { ...dataOpts, concurrency: 1, lockDuration: 600_000 }),
  new Worker<NotifyJobData>(
    NOTIFY_QUEUE,
    async (job) => {
      const attempt = job.attemptsMade + 1;
      return notificationService.deliver(job.data.notificationId, job.data.channel, {
        attempt,
        final: attempt >= (job.opts.attempts ?? 1),
      });
    },
    { ...dataOpts, concurrency: 4, lockDuration: 60_000 },
  ),
);

// ---- schedules --------------------------------------------------------------
// A loop over the schedules table (see seo-data/schedules.ts for why this and
// not repeatable jobs): safe with any number of workers, and restarts lose nothing.
let ticking = false;
async function runSchedules(): Promise<void> {
  if (ticking || shuttingDown) return;
  ticking = true;
  try {
    const dispatched = await scheduleService.tick(dispatchSchedule);
    if (dispatched > 0) log.info({ dispatched }, "scheduled jobs dispatched");
  } catch (err) {
    log.error({ err: (err as Error).message }, "schedule tick failed");
  } finally {
    ticking = false;
  }
}
void runSchedules();
schedulerTimer = setInterval(() => void runSchedules(), SCHEDULER_EVERY_MS);

/**
 * A job can fail without its processor's catch running: BullMQ fails a job that
 * stalled too often (its worker died mid-run) with an UnrecoverableError on the
 * next pickup. Such a run would otherwise stay RUNNING until the reaper. Only
 * final failures are recorded here; a retry that follows keeps the run QUEUED.
 */
auditWorker.on("failed", (job, err) => {
  if (!job) return;
  const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!final) return;
  // markRunFailed only touches a QUEUED/RUNNING run, so a run the processor
  // already ended is left as it is.
  markRunFailed(job.data.runId, err, true).catch((markErr: Error) =>
    log.error({ jobId: job.id, runId: job.data.runId, err: markErr.message }, "could not mark the failed run"),
  );
});

for (const [name, worker] of [
  ["audit", auditWorker],
  ["fix", fixWorker],
  ...dataWorkers.map((w) => [w.name, w] as const),
] as const) {
  worker.on("completed", (job) => {
    metric(`${name}.job.completed`);
    log.info({ jobId: job.id }, `${name} job completed`);
  });
  worker.on("failed", (job, err) => {
    metric(`${name}.job.failed`);
    log.error({ jobId: job?.id, err: err.message }, `${name} job failed`);
  });
  worker.on("error", (err) => log.error({ err: err.message }, `${name} worker error`));
}

log.info(
  { concurrency: workerConcurrency(), queues: [AUDIT_QUEUE, FIX_QUEUE, ...dataWorkers.map((w) => w.name)] },
  "worker ready",
);
