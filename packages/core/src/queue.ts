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
/** Phase 2 queues: SEO data collection and alert delivery. */
export const RANK_QUEUE = "rank-sync";
export const PAGESPEED_QUEUE = "pagespeed";
export const COMPETITOR_QUEUE = "competitor-snapshot";
export const NOTIFY_QUEUE = "notify-deliver";
export const REPORT_QUEUE = "report-generate";

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

/** Who started a data job: a person (or API key) now, or a project schedule. */
export type DataJobTrigger = "MANUAL" | "SCHEDULE";

type DataJobBase = {
  projectId: string;
  trigger: DataJobTrigger;
  /** User id, "api-key:<id>" or "scheduler". */
  requestedBy: string;
  correlationId: string;
};

export type RankJobData = DataJobBase;
export type PageSpeedJobData = DataJobBase & {
  /** Explicit pages to measure; absent = homepage plus the project's top pages. */
  urls?: string[];
};
export type CompetitorJobData = DataJobBase & {
  /** One competitor, or every competitor of the project when absent. */
  competitorId?: string;
};
export type ReportJobData = DataJobBase & { kind: "audit" | "executive" | "keywords" };
export type NotifyJobData = { notificationId: string; channel: "webhook" | "telegram" };

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

// The data queues are created on first use: the web process imports this
// module for every route and most routes never touch them.
type DataQueues = {
  rank: Queue<RankJobData>;
  pagespeed: Queue<PageSpeedJobData>;
  competitor: Queue<CompetitorJobData>;
  notify: Queue<NotifyJobData>;
  report: Queue<ReportJobData>;
};
const globalForData = globalThis as unknown as { __dataQueues?: Partial<DataQueues> };
const dataQueues: Partial<DataQueues> = globalForData.__dataQueues ?? {};
if (process.env.NODE_ENV === "development") globalForData.__dataQueues = dataQueues;

const DATA_QUEUE_NAMES: Record<keyof DataQueues, string> = {
  rank: RANK_QUEUE,
  pagespeed: PAGESPEED_QUEUE,
  competitor: COMPETITOR_QUEUE,
  notify: NOTIFY_QUEUE,
  report: REPORT_QUEUE,
};

export function dataQueue<K extends keyof DataQueues>(kind: K): DataQueues[K] {
  const existing = dataQueues[kind];
  if (existing) return existing as DataQueues[K];
  const queue = new Queue(DATA_QUEUE_NAMES[kind], {
    connection: redisCommand(),
    defaultJobOptions,
    prefix: queuePrefix(),
  }) as DataQueues[K];
  dataQueues[kind] = queue;
  return queue;
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

export type EnqueueResult = {
  jobId: string;
  /** True when a job for the same project was already waiting or running, and that one stands. */
  deduplicated: boolean;
};

/**
 * One job per project and kind at a time. BullMQ's deduplication id holds only
 * while that job is waiting or running, so a finished sync never blocks the
 * next one (a fixed job id would, for as long as the finished job is kept).
 */
async function addDeduplicated<T extends DataJobBase>(
  queue: Queue<T>,
  name: string,
  data: T,
  dedupeId: string,
  jobId: string,
): Promise<EnqueueResult> {
  const job = await withDeadline(() =>
    // BullMQ's generic job-name typing does not follow a Queue<T> through a helper.
    (queue as unknown as Queue).add(name, data, { jobId, deduplication: { id: dedupeId } }),
  );
  return { jobId: job.id ?? jobId, deduplicated: job.id !== undefined && job.id !== jobId };
}

function dataJobId(kind: string, projectId: string): string {
  return `${kind}-${projectId}-${Date.now().toString(36)}${newToken(4)}`;
}

export function enqueueRankSync(data: RankJobData): Promise<EnqueueResult> {
  return addDeduplicated(dataQueue("rank"), "sync", data, `rank-${data.projectId}`, dataJobId("rank", data.projectId));
}

export function enqueuePageSpeed(data: PageSpeedJobData): Promise<EnqueueResult> {
  return addDeduplicated(dataQueue("pagespeed"), "measure", data, `psi-${data.projectId}`, dataJobId("psi", data.projectId));
}

export function enqueueCompetitors(data: CompetitorJobData): Promise<EnqueueResult> {
  const scope = data.competitorId ?? "all";
  return addDeduplicated(
    dataQueue("competitor"),
    "snapshot",
    data,
    `comp-${data.projectId}-${scope}`,
    dataJobId("comp", data.projectId),
  );
}

export function enqueueReport(data: ReportJobData): Promise<EnqueueResult> {
  return addDeduplicated(dataQueue("report"), "generate", data, `report-${data.projectId}-${data.kind}`, dataJobId("report", data.projectId));
}

/** Delivery retries with backoff; the job id makes a repeated enqueue for the same channel a no-op. */
export async function enqueueNotify(data: NotifyJobData): Promise<string> {
  const jobId = `notify-${data.notificationId}-${data.channel}`;
  await withDeadline(() =>
    dataQueue("notify").add("deliver", data, { jobId, attempts: 4, backoff: { type: "exponential", delay: 30_000 } }),
  );
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
  await Promise.allSettled([auditQueue.close(), fixQueue.close(), ...Object.values(dataQueues).map((q) => q.close())]);
}

export { Queue, QueueEvents };
