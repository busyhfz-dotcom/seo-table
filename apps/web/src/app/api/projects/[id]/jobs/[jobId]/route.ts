import { NotFound, dataQueue } from "@seo/core";
import { reasonText, type rankService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/**
 * The queue each data job id belongs to, from the prefix core/queue.ts gives it
 * (rank-…, psi-…, comp-…). Report jobs have their own route.
 */
const QUEUES = { rank: "rank", psi: "pagespeed", comp: "competitor" } as const;

/**
 * GET → {jobId, kind, state, queuedAt, finishedAt, result, error}: a rank sync,
 * PageSpeed run or competitor analysis the screen started, so it can say when
 * the work is done and what failed on the way (a PageSpeed page Google could not
 * load, for instance) instead of guessing from the data. Another project's job
 * answers "not found".
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  const jobId = params.jobId ?? "";
  const prefix = jobId.split("-")[0] as keyof typeof QUEUES;
  const kind = QUEUES[prefix];
  if (!kind) throw new NotFound("Job not found");
  const job = await dataQueue(kind).getJob(jobId);
  if (!job || job.data.projectId !== project.id) throw new NotFound("Job not found");
  const state = await job.getState();
  return {
    jobId,
    kind,
    state,
    queuedAt: new Date(job.timestamp).toISOString(),
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    result: kind === "pagespeed" ? pageSpeedResult(job.returnvalue) : summary(job.returnvalue),
    // The worker's own message is English and for the logs; the screen shows that it failed.
    error: state === "failed" ? { message: job.failedReason || null, text: reasonText("provider_error") } : null,
  };
});

type PageSpeedReturn = { measured?: number; failed?: Array<{ url: string; strategy: string; reason: string }> } | null | undefined;

/** Which pages PageSpeed could not measure, each with its reason in both languages. */
function pageSpeedResult(value: unknown) {
  const r = value as PageSpeedReturn;
  if (!r) return null;
  return {
    measured: r.measured ?? 0,
    failed: (r.failed ?? []).map((f) => ({ url: f.url, strategy: f.strategy, reason: f.reason, text: reasonText(f.reason) })),
  };
}

type CompetitorReturn = Array<{ domain: string; self: boolean; pages: number; robots: string; error: string | null }>;
type RankReturn = { sync?: rankService.RankSyncResult };

/**
 * Rank and competitor jobs: counts and states, not the worker's English error
 * sentences (a competitor that failed is flagged; the reason is in the logs).
 */
function summary(value: unknown) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    return {
      sites: (value as CompetitorReturn).map((c) => ({ domain: c.domain, self: c.self, pages: c.pages, robots: c.robots, failed: Boolean(c.error) })),
    };
  }
  const sync = (value as RankReturn).sync;
  if (!sync) return null;
  return {
    gsc: { configured: sync.gsc.configured, keywords: sync.gsc.keywords, rows: sync.gsc.rows },
    dataforseo: {
      configured: sync.dataforseo.configured,
      disabled: sync.dataforseo.disabled,
      checked: sync.dataforseo.checked,
      failed: sync.dataforseo.failed,
      cost: sync.dataforseo.cost,
      stopped: sync.dataforseo.stoppedReason ? reasonText(sync.dataforseo.stoppedReason) : null,
    },
  };
}
