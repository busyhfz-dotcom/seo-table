import { NextResponse } from "next/server";
import { z } from "zod";
import { enqueueReport, recordAudit } from "@seo/core";
import { reportService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { costLimit, projectFor, requestedBy } from "../../../../../lib/seo-data";

/**
 * GET → {reports: [{id, kind, fileKey, bytes, createdAt, createdById, runId, brandName}],
 * pending: [{jobId, kind, state, queuedAt}]} — finished PDFs and ones being generated.
 */
export const GET = handler({ permission: "report:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  const [reports, pending] = await Promise.all([reportService.listReports(project.id), reportService.pendingJobs(project.id).catch(() => [])]);
  return { reports, pending };
});

const schema = z.object({ kind: z.enum(["audit", "executive", "keywords"]), locale: z.enum(["fa", "en"]).optional() });

/**
 * POST {kind, locale?} → 202 {jobId, deduplicated}: the worker renders the PDF
 * (report-generate queue) and sends an in-app notification when it is ready.
 * A second request for the same kind while one is queued returns that job.
 * 10 an hour per project.
 */
export const POST = handler({ permission: "report:write", schema }, async ({ session, params, body, actor, correlationId }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`report:${project.id}`, 10, 3_600_000);
  const job = await enqueueReport({
    projectId: project.id,
    kind: body.kind,
    ...(body.locale ? { locale: body.locale } : {}),
    trigger: "MANUAL",
    requestedBy: requestedBy(actor),
    correlationId,
  });
  await recordAudit({ orgId: session.orgId, actor, action: "report.create", targetType: "project", targetId: project.id, metadata: { kind: body.kind, locale: body.locale ?? null, ...job } });
  return NextResponse.json(job, { status: 202 });
});
