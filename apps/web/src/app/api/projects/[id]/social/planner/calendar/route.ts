import { planner } from "@seo/social";
import { handler } from "../../../../../../../lib/route";
import { instantRange, socialProjectFor } from "../../../../../../../lib/social";

/**
 * GET ?from=&to= (default: today to 35 days ahead) → {timeZone, days: [{date,
 * posts[]}]}: planned and published posts grouped by day in the profile's
 * timezone (settings.timezone, default Asia/Tehran).
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await socialProjectFor(session, params.id);
  const { from, to } = instantRange(req, 35, 0);
  return planner.calendar(project.id, from, to);
});
