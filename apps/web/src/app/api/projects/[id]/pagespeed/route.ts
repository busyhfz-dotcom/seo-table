import { NextResponse } from "next/server";
import { z } from "zod";
import { BadRequest, enqueuePageSpeed, recordAudit } from "@seo/core";
import { pagespeedService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { costLimit, projectFor, requestedBy } from "../../../../../lib/seo-data";

/**
 * GET → latest PageSpeed/CWV per page and strategy, with Google's pass/fail
 * (field data when Google has it, otherwise lab, labelled), totals per strategy,
 * and which API key is in use.
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return pagespeedService.summary(project.id);
});

const schema = z.object({ urls: z.array(z.string().trim().url().max(2000)).max(10).optional() });

/**
 * POST {urls?} → 202 {jobId, deduplicated}. Without urls: the homepage and the
 * top pages (Search Console clicks, else crawl importance). 10 per hour per project.
 */
export const POST = handler({ permission: "tracking:write", schema }, async ({ session, params, body, actor, correlationId }) => {
  const project = await projectFor(session, params.id);
  if (body.urls?.length && !(await pagespeedService.urlsBelongToProject(project.id, body.urls))) {
    throw new BadRequest("Every URL must be on this project's site");
  }
  await costLimit(`pagespeed:${project.id}`, 10, 3_600_000);
  const job = await enqueuePageSpeed({ projectId: project.id, urls: body.urls, trigger: "MANUAL", requestedBy: requestedBy(actor), correlationId });
  await recordAudit({ orgId: session.orgId, actor, action: "pagespeed.run", targetType: "project", targetId: project.id, metadata: { ...job, urls: body.urls?.length ?? null } });
  return NextResponse.json(job, { status: 202 });
});
