import { db, desc, eq, socialPosts, sql } from "@seo/db";
import { handler, pagination } from "../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../lib/social";
import { socialAccounts, socialAnalytics } from "@seo/social";

/**
 * GET ?page=&perPage=&sort=recent|top → synced posts with their metrics and
 * each post's source ('api' or 'public_preview'), plus ER / view rate.
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await socialProjectFor(session, params.id);
  const { limit, offset, page, perPage } = pagination(req, 30);
  const top = req.nextUrl.searchParams.get("sort") === "top";
  const order =
    project.kind === "TELEGRAM"
      ? sql`coalesce((${socialPosts.metrics}->>'views')::int, -1) desc`
      : sql`coalesce((${socialPosts.metrics}->>'interactions')::int, coalesce((${socialPosts.metrics}->>'likes')::int, 0) + coalesce((${socialPosts.metrics}->>'comments')::int, 0)) desc`;
  const where = eq(socialPosts.projectId, project.id);
  const [rows, total] = await Promise.all([
    db.select().from(socialPosts).where(where).orderBy(top ? order : desc(socialPosts.publishedAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(socialPosts).where(where),
  ]);
  const account = await socialAccounts.getAccount(project.id);
  const followers = account?.followers ?? null;
  return {
    page,
    perPage,
    total: total[0]?.n ?? 0,
    posts: rows.map((p) => ({
      id: p.id,
      externalId: p.externalId,
      permalink: p.permalink,
      type: p.type,
      caption: p.caption,
      mediaUrls: p.mediaUrls,
      altTexts: p.altTexts,
      hashtags: p.hashtags,
      publishedAt: p.publishedAt?.toISOString() ?? null,
      metrics: p.metrics,
      metricsAt: p.metricsAt?.toISOString() ?? null,
      source: p.source,
      erByReach: project.kind === "INSTAGRAM" ? socialAnalytics.erByReach(p) : null,
      erByFollowers: project.kind === "INSTAGRAM" ? socialAnalytics.erByFollowers(p, followers) : null,
      viewRate: project.kind === "TELEGRAM" ? socialAnalytics.viewRate(p, followers) : null,
    })),
  };
});
