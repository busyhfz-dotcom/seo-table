import { recordAudit } from "@seo/core";
import { keywordService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** POST {action: archive|unarchive|delete|add_tag|remove_tag, ids: string[≤500], tag?} → {affected} */
export const POST = handler(
  { permission: "tracking:write", schema: keywordService.bulkKeywordInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const result = await keywordService.bulkKeywords(project.id, body);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: body.action === "delete" ? "keyword.delete" : body.action.endsWith("archive") ? "keyword.archive" : "keyword.update",
      targetType: "project",
      targetId: project.id,
      metadata: { action: body.action, affected: result.affected, tag: body.tag ?? null },
    });
    return result;
  },
);
