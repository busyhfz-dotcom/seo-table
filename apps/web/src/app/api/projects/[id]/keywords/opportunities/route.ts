import { discovery } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/**
 * GET ?days=28&minImpressions=20 → Search Console queries at positions 4–20
 * that are not tracked yet, or {configured:false} without Search Console.
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const p = req.nextUrl.searchParams;
  const num = (k: string) => (p.get(k) && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : undefined);
  return discovery.gscOpportunities(project.id, {}, { days: num("days"), minImpressions: num("minImpressions") });
});
