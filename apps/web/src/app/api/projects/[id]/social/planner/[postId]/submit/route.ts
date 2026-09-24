import { recordAudit } from "@seo/core";
import { planner } from "@seo/social";
import { handler } from "../../../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../../../lib/social";

/** POST → ask for approval (draft or rejected → awaiting_approval): {post}. */
export const POST = handler({ permission: "social:write" }, async ({ session, params, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const post = await planner.submitPost(project, params.postId!, session.userId);
  await recordAudit({ orgId: session.orgId, actor, action: "social.post_submit", targetType: "scheduled_post", targetId: post.id });
  return { post: planner.postView(post) };
});
