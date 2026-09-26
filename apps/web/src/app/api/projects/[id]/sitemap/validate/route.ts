import { z } from "zod";
import { sitemapService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({ url: z.string().trim().url().max(2000).optional() });

/**
 * POST {url?} → {sources, urls, truncated, issues, problems: {not_200, redirect,
 * noindex, not_canonical, blocked_by_robots, other_host, not_crawled}, examples,
 * scannedAt}: the site's sitemaps (the given one, else those in robots.txt, else
 * /sitemap.xml) checked against the latest scan. 10 an hour per project.
 */
export const POST = handler({ permission: "project:read", schema }, async ({ session, params, body }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`sitemap-validate:${project.id}`, 10, 3_600_000);
  return sitemapService.validateSitemaps(project.id, body.url ? { url: body.url } : {});
});
