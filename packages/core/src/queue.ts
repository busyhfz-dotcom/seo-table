/**
 * BullMQ wiring. One queue for audit scans, one for fix executions.
 *
 * Idempotency has two layers:
 *   - the DB unique index on (project_id, idempotency_key) stops a duplicate run
 *     row from existing at all;
 *   - the BullMQ job id is derived from the run id, so even if enqueue is retried
 *     the queue holds a single job.
 */
import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import { redis } from "./redis.js";
import { env } from "./env.js";

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
  new Queue<AuditJobData>(AUDIT_QUEUE, { connection: redis, defaultJobOptions, prefix: queuePrefix() });

export const fixQueue: Queue<FixJobData> =
  globalForQueue.__fixQueue ??
  new Queue<FixJobData>(FIX_QUEUE, { connection: redis, defaultJobOptions, prefix: queuePrefix() });

if (process.env.NODE_ENV === "development") {
  globalForQueue.__auditQueue = auditQueue;
  globalForQueue.__fixQueue = fixQueue;
}

// BullMQ rejects a custom job id containing ":", so these use "-".
export function auditJobId(runId: string): string {
  return `audit-${runId}`;
}

export function fixJobId(proposalId: string, dryRun: boolean): string {
  return `fix-${proposalId}-${dryRun ? "dry" : "live"}`;
}

export async function enqueueAudit(data: AuditJobData): Promise<string> {
  const jobId = auditJobId(data.runId);
  await auditQueue.add("scan", data, { jobId });
  return jobId;
}

export async function enqueueFix(data: FixJobData): Promise<string> {
  const jobId = fixJobId(data.proposalId, data.dryRun);
  await fixQueue.add("execute", data, { jobId, attempts: 1 });
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
  const [waiting, active, delayed, failed, completed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getDelayedCount(),
    queue.getFailedCount(),
    queue.getCompletedCount(),
  ]);
  return { waiting, active, delayed, failed, completed };
}

export function workerConcurrency(): number {
  return env().WORKER_CONCURRENCY;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([auditQueue.close(), fixQueue.close()]);
}

export { Queue, QueueEvents };
