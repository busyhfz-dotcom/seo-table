import { z } from "zod";
import { recordAudit } from "@seo/core";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { projectFor } from "../../../../../../../lib/seo-data";

const schema = z.object({ mode: z.enum(["draft", "update"]), postType: z.enum(["posts", "pages"]).optional() });

/**
 * POST {mode: "draft" | "update", postType?} → {publish}: ask to publish the
 * document to WordPress. Content changes are SENSITIVE, so this only records a
 * pending request; a person with fix:approve_sensitive decides it (…/publish/decision).
 * 409 CONNECTOR_NOT_CONNECTED without WordPress; 400 when "update" finds no post at the document's URL.
 */
export const POST = handler({ permission: "content:write", schema }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  const publish = await contentService.requestPublish(project.id, params.docId!, body, actor);
  await recordAudit({ orgId: session.orgId, actor, action: "content.publish_request", targetType: "content_document", targetId: params.docId!, metadata: { mode: body.mode, post: publish.post?.id ?? null } });
  return { publish };
});
