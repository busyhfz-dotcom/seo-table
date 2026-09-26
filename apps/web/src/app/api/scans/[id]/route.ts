import { NotFound } from "@seo/core";
import { handler, pagination } from "../../../../lib/route";
import { getRun, issueCountsByUrl, runPages } from "../../../../lib/queries";

/**
 * Scan status and result. Poll this while `status` is QUEUED or RUNNING;
 * `pagesCrawled`/`pagesTotal` move as the crawl proceeds.
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const run = await getRun(session.orgId, params.id!);
  if (!run) throw new NotFound("Run not found");

  const { limit, offset, page, perPage } = pagination(req);
  const includePages = req.nextUrl.searchParams.get("pages") !== "0";
  const pages = includePages ? await runPages(run.id, { limit, offset }) : { rows: [], total: 0 };
  const counts = includePages ? await issueCountsByUrl(run.id) : new Map<string, number>();

  return {
    run: {
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      trigger: run.trigger,
      attempts: run.attempts,
      pagesCrawled: run.pagesCrawled,
      pagesTotal: run.pagesTotal,
      score: run.score,
      scoreBreakdown: run.scoreBreakdown,
      error: run.error,
      errorCode: run.errorCode,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    project: { id: run.project.id, name: run.project.name, baseUrl: run.project.baseUrl },
    pages: {
      page,
      perPage,
      total: pages.total,
      rows: pages.rows.map((p) => ({ ...p, issueCount: counts.get(p.normalizedUrl) ?? 0 })),
    },
  };
});
