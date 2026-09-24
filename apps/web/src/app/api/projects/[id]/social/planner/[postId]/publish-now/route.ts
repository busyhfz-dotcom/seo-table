import { enqueueSocialPublish, recordAudit } from "@seo/core";
import { planner } from "@seo/social";
import { handler } from "../../../../../../../../lib/route";
import { requestedBy } from "../../../../../../../../lib/seo-data";
import { socialProjectFor } from "../../../../../../../../lib/social";

/**
 * POST → publish an approved (scheduled) post now, or retry a failed one:
 * {post, jobId}. A post whose last attempt ended mid-publish (error
 * outcome_unknown) may already be live and is refused with 409.
 */
export const POST = handler(
  { permission: "fix:approve_sensitive", sessionOnly: true },
  async ({ session, params, actor, correlationId }) => {
    const project = await socialProjectFor(session, params.id);
    const post = await planner.publishNow(project, params.postId!);
    let jobId: string | null = null;
    try {
      jobId = await enqueueSocialPublish({ postId: post.id, projectId: project.id, requestedBy: requestedBy(actor), correlationId });
    } catch {
      // The publisher's tick picks the post up within a minute anyway.
    }
    await recordAudit({ orgId: session.orgId, actor, action: "social.post_publish_now", targetType: "scheduled_post", targetId: post.id });
    return { post: planner.postView(post), jobId };
  },
);
