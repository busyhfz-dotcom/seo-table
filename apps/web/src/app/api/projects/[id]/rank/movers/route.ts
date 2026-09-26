import { rankService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET ?days=7&source=gsc|dataforseo&limit=10 → biggest gains and losses between two equal windows. */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const p = req.nextUrl.searchParams;
  const n = (k: string) => (Number.isFinite(Number(p.get(k))) && p.get(k) ? Number(p.get(k)) : undefined);
  return rankService.movers(project.id, {
    days: n("days"),
    limit: n("limit"),
    source: p.get("source") === "dataforseo" ? "dataforseo" : "gsc",
  });
});
