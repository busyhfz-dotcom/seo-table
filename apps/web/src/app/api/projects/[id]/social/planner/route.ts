import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { planner } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { instantRange, socialProjectFor } from "../../../../../../lib/social";

/**
 * GET ?from=&to=&status=a,b → {posts[]}: planned posts (drafts without a time
 * are always included). Default window: 30 days back to 90 ahead.
 * POST {payload, publishAt?, submit?} → 201 {post}. `payload` is
 *   {op:"post", format, text, media:[{url, type, altText?}], pin?, silent?, shareToFeed?}
 *   {op:"edit", messageId, text, target:"text"|"caption"}   (Telegram)
 *   {op:"pin", messageId, silent?}                           (Telegram)
 * Instagram formats: image | carousel | reel (JPEG images, https URLs Meta can
 * download; alt text per image). Telegram: text | photo | album | video, text in
 * Telegram HTML. Anything the platform would refuse is a 400 with
 * details.problems[] now, not a failure at publishing time. submit:true asks
 * for approval right away; nothing is published before a person approves.
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await socialProjectFor(session, params.id);
  const { from, to } = instantRange(req, 90, 30);
  const status = req.nextUrl.searchParams.get("status")?.split(",").filter(Boolean);
  const rows = await planner.listPosts(project.id, { from, to, status });
  return { posts: rows.map(planner.postView) };
});

export const POST = handler({ permission: "social:write", schema: planner.postInput }, async ({ session, params, body, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const post = await planner.createPost(project, body, session.userId);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: body.submit ? "social.post_submit" : "social.post_create",
    targetType: "scheduled_post",
    targetId: post.id,
    metadata: { platform: post.platform, op: post.payload.op, publishAt: post.publishAt?.toISOString() ?? null },
  });
  return NextResponse.json({ post: planner.postView(post) }, { status: 201 });
});
