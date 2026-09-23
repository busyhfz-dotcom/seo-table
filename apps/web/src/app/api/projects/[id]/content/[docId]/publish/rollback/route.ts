import { recordAudit } from "@seo/core";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../../../lib/route";
import { projectFor } from "../../../../../../../../lib/seo-data";

/**
 * POST → {publish}: undo a publish — the post's previous title and content come
 * back (update), or the created draft goes to the WordPress trash (draft).
 * 409 when the post was edited in WordPress since.
 */
export const POST = handler({ permission: "fix:rollback", sessionOnly: true }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  const publish = await contentService.rollbackPublish(project.id, params.docId!);
  await recordAudit({ orgId: session.orgId, actor, action: "content.publish_rollback", targetType: "content_document", targetId: params.docId!, metadata: { mode: publish.mode, post: publish.post?.id ?? null } });
  return { publish };
});
