import { recordAudit } from "@seo/core";
import { competitorService } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { costLimit, projectFor, providerCall } from "../../../../../../../lib/seo-data";

/**
 * POST → backlink summary for our site and the competitor (DataForSEO
 * Backlinks, a separate subscription), or {configured:false}. 10 per hour per organization.
 */
export const POST = handler({ permission: "tracking:write" }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`backlinks:${session.orgId}`, 10, 3_600_000);
  const result = await providerCall(() => competitorService.backlinkComparison(session.orgId, project.id, params.competitorId!));
  if (result.configured) {
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "keyword.research",
      targetType: "competitor",
      targetId: params.competitorId!,
      metadata: { kind: "backlinks", cost: result.cost },
    });
  }
  return result;
});
