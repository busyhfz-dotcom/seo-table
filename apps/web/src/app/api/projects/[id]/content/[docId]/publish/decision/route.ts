import { z } from "zod";
import { recordAudit } from "@seo/core";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../../../lib/route";
import { projectFor } from "../../../../../../../../lib/seo-data";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).optional() });

/**
 * POST {decision, reason?} → {publish}. Approving performs the WordPress write
 * (status "published" or "failed" with the error). A signed-in person only; 409
 * when there is no pending request or the document changed since it was asked.
 */
export const POST = handler({ permission: "fix:approve_sensitive", schema, sessionOnly: true }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  const publish = await contentService.decidePublish(project.id, params.docId!, { approve: body.decision === "approve", ...(body.reason ? { reason: body.reason } : {}) }, actor);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: body.decision === "approve" ? "content.publish" : "content.publish_reject",
    targetType: "content_document",
    targetId: params.docId!,
    metadata: { mode: publish.mode, status: publish.status, post: publish.post?.id ?? null, ...(publish.error ? { error: publish.error.slice(0, 200) } : {}) },
  });
  return { publish };
});
