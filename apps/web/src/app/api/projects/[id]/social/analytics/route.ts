import { Conflict } from "@seo/core";
import { socialAccounts, socialAnalytics } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { dateRange } from "../../../../../../lib/seo-data";
import { socialProjectFor } from "../../../../../../lib/social";

/**
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: last 28 days) → followers
 * (series, net, percent), daily reach/views/engagement (Instagram), posts per
 * week and by type, engagement averages, top posts, best hours and weekdays,
 * hashtag lift, the formulas (fa/en) and each figure's source. Only what the
 * platforms reported: an empty range is empty, never estimated.
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await socialProjectFor(session, params.id);
  const account = await socialAccounts.getAccount(project.id);
  if (!account) throw new Conflict("The account is not connected", { reason: "not_connected" });
  return socialAnalytics.analytics(account, dateRange(req, 28));
});
