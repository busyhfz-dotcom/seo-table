import { integrations } from "@seo/seo-data";
import { handler } from "../../../../lib/route";

/** GET ?days=30 → {days, totalCost, calls, byEndpoint: [{endpoint, calls, cost}]} — paid-provider spend (USD, as reported by the provider). */
export const GET = handler({ permission: "integration:manage" }, async ({ req, session }) => {
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days") ?? 30) || 30, 1), 365);
  return integrations.usageSummary(session.orgId, days);
});
