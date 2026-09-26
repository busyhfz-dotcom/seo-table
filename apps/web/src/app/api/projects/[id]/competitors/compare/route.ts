import { competitorService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET → {ours: SiteStats|null, competitors: [{id, domain, name, stats}]} from the latest samples, same method for all. */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return competitorService.compare(project.id);
});
