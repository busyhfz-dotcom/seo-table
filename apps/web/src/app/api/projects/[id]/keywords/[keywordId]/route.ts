import { recordAudit } from "@seo/core";
import { keywordService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** PATCH {targetUrl?, tags?, archived?} */
export const PATCH = handler(
  { permission: "tracking:write", schema: keywordService.updateKeywordInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const keyword = await keywordService.updateKeyword(project.id, params.keywordId!, body);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: body.archived === undefined ? "keyword.update" : "keyword.archive",
      targetType: "keyword",
      targetId: keyword.id,
      metadata: { fields: Object.keys(body) },
    });
    return { keyword };
  },
);

/** DELETE removes the keyword and its position history (archive keeps both). */
export const DELETE = handler({ permission: "tracking:write" }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  await keywordService.deleteKeyword(project.id, params.keywordId!);
  await recordAudit({ orgId: session.orgId, actor, action: "keyword.delete", targetType: "keyword", targetId: params.keywordId! });
  return { ok: true };
});
