import { rankService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { dateRange, projectFor } from "../../../../../../lib/seo-data";

/** GET ?from&to (default 90 days) → {formula, source:"gsc", series: [{date, visibility 0–100, clicks, impressions, keywords}]} */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const range = dateRange(req, 90);
  return { ...range, ...(await rankService.visibility(project.id, range)) };
});
