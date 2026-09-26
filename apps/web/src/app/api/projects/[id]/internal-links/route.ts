import { internalLinks } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../lib/seo-data";

/**
 * GET → the site's internal link report from the latest scan: link equity
 * (PageRank over the internal graph, 0–100), orphans, weakly linked important
 * pages (by Search Console clicks), an in-link histogram and source→target
 * suggestions with anchor candidates. status "no_scan" | "needs_rescan" when
 * there is no graph yet. 30 per 10 minutes per project.
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`internal-links:${project.id}`, 30, 600_000);
  return internalLinks.siteLinks(project.id, project);
});
