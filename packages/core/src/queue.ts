/**
 * BullMQ wiring. One queue for audit scans, one for fix executions.
 *
 * Audit idempotency has two layers:
 *   - the DB unique index on (project_id, idempotency_key) stops a duplicate run
 *     row from existing at all;
 *   - the BullMQ job id is derived from the run id, so even if enqueue is retried
 *     the queue holds a single job.
 *
 * Fix jobs are the opposite: a proposal is legitimately dry-run or applied more
 * than once (after a failure, after a rollback), and BullMQ silently drops an
 * add whose id it still remembers — for as long as removeOnComplete/removeOnFail
 * keep it. So every request gets its own job id, and "only one execution at a
 * time" is enforced by the executor's status-conditional update in the database.
 *
 * Producers use the fail-fast Redis connection: with Redis down, enqueue throws
 * within seconds instead of hanging the HTTP request.
 */
import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import { commandReady, redisCommand } from "./redis.js";
import { env } from "./env.js";
import { newToken } from "./crypto.js";

export const AUDIT_QUEUE = "audit-scan";
export const FIX_QUEUE = "fix-execution";

export type AuditJobData = {
  runId: string;
  projectId: string;
  requestedBy: string;
  /** Echoed into logs so a job can be traced back to the HTTP request. */
  correlationId: string;
};

export type FixJobData = {
  proposalId: string;
  projectId: string;
  dryRun: boolean;
  requestedBy: string;
  correlationId: string;
};

/**
 * Redis key prefix for every queue. Separate deployments (or the test suite)
 * sharing one Redis must not consume each other's jobs.
 */
export function queuePrefix(): string {
  return env().QUEUE_PREFIX;
}

export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000 },
  // Keep a window of finished jobs for debugging, then let Redis reclaim them.
  removeOnComplete: { age: 24 * 3600, count: 500 },
  removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
};

const globalForQueue = globalThis as unknown as {
  __auditQueue?: Queue<AuditJobData>;
  __fixQueue?: Queue<FixJobData>;
};

export const auditQueue: Queue<AuditJobData> =
  globalForQueue.__auditQueue ??
  new Queue<AuditJobData>(AUDIT_QUEUE, { connection: redisCommand(), defaultJobOptions, prefix: queuePrefix() });

export const fixQueue: Queue<FixJobData> =
  globalForQueue.__fixQueue ??
  new Queue<FixJobData>(FIX_QUEUE, { connection: redisCommand(), defaultJobOptions, prefix: queuePrefix() });

if (process.env.NODE_ENV === "development") {
  globalForQueue.__auditQueue = auditQueue;
  globalForQueue.__fixQueue = fixQueue;
}

// BullMQ rejects a custom job id containing ":", so these use "-".
export function auditJobId(runId: string): string {
  return `audit-${runId}`;
}

/** Unique per request (see the header): a repeat dry run or re-apply must not be deduplicated away. */
export function fixJobId(proposalId: string, dryRun: boolean): string {
  return `fix-${proposalId}-${dryRun ? "dry" : "live"}-${Date.now().toString(36)}${newToken(6)}`;
}

const QUEUE_DEADLINE_MS = 5_000;

/**
 * BullMQ waits for its connection to become ready before sending a command,
 * with no deadline of its own, so an add (or a count for /ready) during an
 * outage would hang the request. Refuse at once when the connection is down,
 * and bound the operation.
 * An add that times out may still land once Redis is back; consumers treat a
 * job whose row is no longer QUEUED/runnable as a no-op.
 */
async function withDeadline<T>(op: () => Promise<T>): Promise<T> {
  const client = await commandReady().catch(() => null);
  if (client?.status !== "ready") throw new Error("Job queue unavailable: Redis is not connected");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Job queue unavailable: timed out")), QUEUE_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function enqueueAudit(data: AuditJobData): Promise<string> {
  const jobId = auditJobId(data.runId);
  await withDeadline(() => auditQueue.add("scan", data, { jobId }));
  return jobId;
}

export async function enqueueFix(data: FixJobData): Promise<string> {
  const jobId = fixJobId(data.proposalId, data.dryRun);
  await withDeadline(() => fixQueue.add("execute", data, { jobId, attempts: 1 }));
  return jobId;
}

export type QueueDepth = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

export async function queueDepth(queue: Queue = auditQueue): Promise<QueueDepth> {
  const [waiting, active, delayed, failed, completed] = await withDeadline(() =>
    Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getFailedCount(),
      queue.getCompletedCount(),
    ]),
  );
  return { waiting, active, delayed, failed, completed };
}

export function workerConcurrency(): number {
  return env().WORKER_CONCURRENCY;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([auditQueue.close(), fixQueue.close()]);
}

export { Queue, QueueEvents };
