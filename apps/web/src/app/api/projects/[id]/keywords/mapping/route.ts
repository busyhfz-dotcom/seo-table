import { discovery } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET → per tracked keyword: target URL vs the URL that actually ranks (and which source says so). */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return { items: await discovery.mapping(project.id) };
});
