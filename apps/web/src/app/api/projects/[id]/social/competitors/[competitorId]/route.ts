import { recordAudit } from "@seo/core";
import { socialCompetitors } from "@seo/social";
import { handler } from "../../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../../lib/social";

/** DELETE → stop tracking this competitor (its snapshot goes with it). */
export const DELETE = handler({ permission: "social:write" }, async ({ session, params, actor }) => {
  const project = await socialProjectFor(session, params.id);
  await socialCompetitors.deleteCompetitor(project.id, params.competitorId!);
  await recordAudit({ orgId: session.orgId, actor, action: "social.competitor_delete", targetType: "social_competitor", targetId: params.competitorId! });
  return { ok: true };
});
