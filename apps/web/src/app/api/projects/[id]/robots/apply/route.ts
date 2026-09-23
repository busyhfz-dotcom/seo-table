import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@seo/core";
import { robotsService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({ content: z.string().min(1).max(robotsService.MAX_ROBOTS_BYTES) });

/**
 * POST {content} → 201 {proposal, target, review}: a ROBOTS_TXT fix proposal
 * (SENSITIVE; RESTRICTED when it newly blocks crawled pages) that serves the
 * file from the Cloudflare edge once approved and applied. 400 {issues} for a
 * file with errors; 409 {reason, manual: true} when the write target cannot
 * serve robots.txt — download the file and upload it by hand instead.
 */
export const POST = handler({ permission: "fix:propose", schema }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  const result = await robotsService.proposeRobots({ projectId: project.id, orgId: session.orgId, actor, content: body.content });
  await recordAudit({ orgId: session.orgId, actor, action: "robots.propose", targetType: "fix_proposal", targetId: result.proposal.id, metadata: { newlyBlocked: result.review.newlyBlocked.length, risk: result.proposal.risk } });
  return NextResponse.json(result, { status: 201 });
});
