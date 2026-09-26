import { NotFound, recordAudit } from "@seo/core";
import { planner } from "@seo/social";
import { handler } from "../../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../../lib/social";

/**
 * GET → {post}.
 * PATCH {payload?, publishAt?, submit?} → {post}. Only draft, awaiting_approval
 * or rejected posts; an edit withdraws the approval request (submit again).
 * DELETE → cancel ({post} with status canceled). A post being published or
 * already published cannot be canceled.
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await socialProjectFor(session, params.id);
  const post = (await planner.listPosts(project.id)).find((p) => p.id === params.postId);
  if (!post) throw new NotFound("Planned post not found");
  return { post: planner.postView(post) };
});

export const PATCH = handler({ permission: "social:write", schema: planner.postUpdateInput }, async ({ session, params, body, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const post = await planner.updatePost(project, params.postId!, body, session.userId);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: body.submit ? "social.post_submit" : "social.post_update",
    targetType: "scheduled_post",
    targetId: post.id,
  });
  return { post: planner.postView(post) };
});

export const DELETE = handler({ permission: "social:write" }, async ({ session, params, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const post = await planner.cancelPost(project, params.postId!);
  await recordAudit({ orgId: session.orgId, actor, action: "social.post_cancel", targetType: "scheduled_post", targetId: post.id });
  return { post: planner.postView(post) };
});
