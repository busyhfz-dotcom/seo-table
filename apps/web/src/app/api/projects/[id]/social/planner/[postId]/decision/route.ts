import { z } from "zod";
import { recordAudit } from "@seo/core";
import { planner } from "@seo/social";
import { handler } from "../../../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../../../lib/social";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).optional() });

/**
 * POST {decision, reason?} → {post}. Publishing is SENSITIVE: only a signed-in
 * person with fix:approve_sensitive decides (never an API key or the agent).
 * Approve → scheduled for its publishAt (now when it has none); reject → rejected.
 */
export const POST = handler(
  { permission: "fix:approve_sensitive", schema, sessionOnly: true },
  async ({ session, params, body, actor }) => {
    const project = await socialProjectFor(session, params.id);
    const post = await planner.decidePost(project, params.postId!, { approve: body.decision === "approve", reason: body.reason ?? null, actor: { type: actor.type, id: actor.id ?? null } });
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: body.decision === "approve" ? "social.post_approve" : "social.post_reject",
      targetType: "scheduled_post",
      targetId: post.id,
      metadata: { reason: body.reason ?? null, publishAt: post.publishAt?.toISOString() ?? null },
    });
    return { post: planner.postView(post) };
  },
);
