import { NextResponse } from "next/server";
import { z } from "zod";
import { enqueueCompetitors, recordAudit } from "@seo/core";
import { competitorService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor, requestedBy } from "../../../../../../lib/seo-data";

/**
 * POST {competitorId?} → 202 {jobId, deduplicated}: sample the competitor(s)
 * (≤30 pages each, 1 request/s) and our own site. 6 per hour per project.
 */
export const POST = handler(
  { permission: "tracking:write", schema: z.object({ competitorId: z.string().min(1).max(30).optional() }) },
  async ({ session, params, body, actor, correlationId }) => {
    const project = await projectFor(session, params.id);
    if (body.competitorId) await competitorService.getCompetitor(project.id, body.competitorId);
    await costLimit(`competitors:${project.id}`, 6, 3_600_000);
    const job = await enqueueCompetitors({
      projectId: project.id,
      competitorId: body.competitorId,
      trigger: "MANUAL",
      requestedBy: requestedBy(actor),
      correlationId,
    });
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "competitor.analyze",
      targetType: "project",
      targetId: project.id,
      metadata: { ...job, competitorId: body.competitorId ?? null },
    });
    return NextResponse.json(job, { status: 202 });
  },
);
