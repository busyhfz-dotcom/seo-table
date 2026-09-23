import { NextResponse } from "next/server";
import { enqueueRankSync, recordAudit } from "@seo/core";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor, requestedBy } from "../../../../../../lib/seo-data";

/**
 * POST → 202 {jobId, deduplicated}: sync positions now (Search Console, and
 * DataForSEO SERPs when configured). A sync already waiting or running for the
 * project is reused (deduplicated: true). 6 per hour per project.
 */
export const POST = handler({ permission: "tracking:write" }, async ({ session, params, actor, correlationId }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`rank-sync:${project.id}`, 6, 3_600_000);
  const job = await enqueueRankSync({ projectId: project.id, trigger: "MANUAL", requestedBy: requestedBy(actor), correlationId });
  await recordAudit({ orgId: session.orgId, actor, action: "rank.sync", targetType: "project", targetId: project.id, metadata: { ...job } });
  return NextResponse.json(job, { status: 202 });
});
