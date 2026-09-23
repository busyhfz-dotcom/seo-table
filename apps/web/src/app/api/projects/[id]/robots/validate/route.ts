import { z } from "zod";
import { robotsService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({ content: z.string().max(robotsService.MAX_ROBOTS_BYTES + 1) });

/**
 * POST {content} → {issues, diff: [{op: "="|"+"|"-", line, oldNo, newNo}],
 * newlyBlocked: [{url, clicks, rule}], newlyAllowed, checkedUrls, current}:
 * the edited file checked, compared line by line with the live one, and tested
 * against the pages that matter (homepage, top Search Console pages, crawled
 * indexable pages). 30 per 10 minutes per project.
 */
export const POST = handler({ permission: "project:read", schema }, async ({ session, params, body }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`robots-review:${project.id}`, 30, 600_000);
  return robotsService.reviewRobots(project.id, body.content);
});
