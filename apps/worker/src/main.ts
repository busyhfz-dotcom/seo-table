/**
 * Worker process. Two BullMQ workers plus a tiny HTTP server for health checks,
 * because Railway needs something to probe and "is the queue draining" is the
 * question worth answering.
 */
import { createServer } from "node:http";
import { Worker, type Job } from "bullmq";
import {
  AUDIT_QUEUE,
  FIX_QUEUE,
  childLogger,
  closeQueues,
  closeRedis,
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
  type FixJobData,
} from "@seo/core";
import { closeDb, pingDb } from "@seo/db";
import { analyze, execute, markRunFailed, runAgent } from "@seo/pipeline";

process.env.SERVICE_NAME ??= "seo-worker";

const log = childLogger({ component: "worker" });
let shuttingDown = false;

// Release runs a previous crash left in RUNNING, so a restart does not
// permanently block those projects.
const reaped = await scanService.reapStaleRuns(60);
if (reaped > 0) log.warn({ reaped }, "released stale runs from a previous process");

const auditWorker = new Worker<AuditJobData>(
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
      const run = await scanService.getRun(job.data.runId);
      if (run?.status === "CANCELED") controller.abort();
    }, 5_000);

    try {
      const outcome = await analyze(job.data.runId, controller.signal);
      if (outcome.canceled) return { canceled: true };

      // The agent runs after analysis, in the same job, so a scan and its
      // automatic fixes are one unit of work with one audit trail.
      const agentReport = await runAgent(job.data.projectId);
      return { ...outcome, agent: agentReport };
    } catch (err) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await markRunFailed(job.data.runId, err, isLastAttempt);
      jobLog.error(
        { err: (err as Error).message, attempt: job.attemptsMade + 1, isLastAttempt },
        isLastAttempt ? "run failed permanently" : "run attempt failed, will retry",
      );
      throw err;
    } finally {
      clearInterval(onCancelCheck);
    }
  },
  { connection: redis, concurrency: workerConcurrency(), lockDuration: 300_000, prefix: queuePrefix() },
);

const fixWorker = new Worker<FixJobData>(
  FIX_QUEUE,
  async (job: Job<FixJobData>) =>
    execute({
      proposalId: job.data.proposalId,
      dryRun: job.data.dryRun,
      actor: { type: job.data.requestedBy === "agent" ? "AGENT" : "USER", id: job.data.requestedBy },
    }),
  { connection: redis, concurrency: 1, lockDuration: 120_000, prefix: queuePrefix() },
);

for (const [name, worker] of [
  ["audit", auditWorker],
  ["fix", fixWorker],
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

// ---- health server ---------------------------------------------------------
// Railway injects PORT for every service; the worker binds its health server to it.
const port = env().PORT ?? 3001;
const server = createServer(async (req, res) => {
  if (req.url === "/health" || req.url === "/api/health") {
    res.writeHead(shuttingDown ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: shuttingDown ? "draining" : "ok", service: "worker" }));
    return;
  }
  if (req.url === "/ready" || req.url === "/api/ready") {
    const [dbOk, redisOk] = await Promise.all([
      pingDb().catch(() => false),
      pingRedis().catch(() => false),
    ]);
    const depth = await queueDepth().catch(() => null);
    const ok = dbOk && redisOk && !shuttingDown;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: ok ? "ready" : "not_ready",
        checks: { database: dbOk, redis: redisOk },
        queue: depth,
        workers: { audit: auditWorker.isRunning(), fix: fixWorker.isRunning() },
      }),
    );
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, () => log.info({ port }, "worker health server listening"));

// ---- graceful shutdown -----------------------------------------------------
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  server.close();
  // close(false) lets in-flight jobs finish; an interrupted crawl would otherwise
  // leave a run stuck in RUNNING until the reaper catches it.
  await Promise.allSettled([auditWorker.close(), fixWorker.close()]);
  await closeQueues();
  await closeRedis();
  await closeDb();
  logger.flush?.();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandled rejection"));

log.info(
  { concurrency: workerConcurrency(), queues: [AUDIT_QUEUE, FIX_QUEUE] },
  "worker ready",
);
