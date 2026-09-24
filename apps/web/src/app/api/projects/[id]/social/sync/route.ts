import { NextResponse } from "next/server";
import { Conflict, enqueueSocialSync, recordAudit } from "@seo/core";
import { socialAccounts } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { costLimit, requestedBy } from "../../../../../../lib/seo-data";
import { socialProjectFor } from "../../../../../../lib/social";

/**
 * POST → queue a sync now (profile, posts, metrics, then audit, competitors and
 * alerts): 202 {jobId, deduplicated}. It is done when account.lastSyncAt on
 * GET /social moves. 409 when not connected; 429 beyond 12 an hour.
 */
export const POST = handler({ permission: "social:write" }, async ({ session, params, actor, correlationId }) => {
  const project = await socialProjectFor(session, params.id);
  const account = await socialAccounts.getAccount(project.id);
  if (!account || account.status === "NOT_CONNECTED") throw new Conflict("The account is not connected", { reason: "not_connected" });
  await costLimit(`social-sync:${project.id}`, 12, 60 * 60_000);
  const job = await enqueueSocialSync({ projectId: project.id, trigger: "MANUAL", requestedBy: requestedBy(actor), correlationId });
  await recordAudit({ orgId: session.orgId, actor, action: "social.sync", targetType: "project", targetId: project.id, metadata: { queued: true, jobId: job.jobId } });
  return NextResponse.json(job, { status: 202 });
});
