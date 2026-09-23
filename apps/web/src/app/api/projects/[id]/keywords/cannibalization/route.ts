import { discovery } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET ?days=28 → queries where several of the site's pages split impressions (Search Console), or {configured:false}. */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const days = Number(req.nextUrl.searchParams.get("days") ?? 28);
  return discovery.cannibalization(project.id, {}, { days: Number.isFinite(days) ? days : 28 });
});
