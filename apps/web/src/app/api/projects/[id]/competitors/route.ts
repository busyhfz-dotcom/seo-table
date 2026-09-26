import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { competitorService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { projectFor } from "../../../../../lib/seo-data";

/** GET → competitors with when each was last analysed and how many pages were sampled. */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return { competitors: await competitorService.listCompetitors(project.id), max: competitorService.MAX_COMPETITORS };
});

/** POST {domain, name?} → 201 {competitor}. A domain or URL; stored as the bare host. At most 10. */
export const POST = handler(
  { permission: "tracking:write", schema: competitorService.competitorInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const competitor = await competitorService.addCompetitor(project.id, body);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "competitor.add",
      targetType: "competitor",
      targetId: competitor.id,
      metadata: { domain: competitor.domain },
    });
    return NextResponse.json({ competitor }, { status: 201 });
  },
);
