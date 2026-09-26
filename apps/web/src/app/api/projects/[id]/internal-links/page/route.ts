import { BadRequest } from "@seo/core";
import { internalLinks } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, pageUrlParam, projectFor } from "../../../../../../lib/seo-data";

/** GET ?url= → one page: its in-links (with anchors), out-links, equity, and pages to link from / to. */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const url = pageUrlParam(req, project);
  if (!url || !/^https?:\/\//i.test(url)) throw new BadRequest("url is required", { field: "url" });
  await costLimit(`internal-links:${project.id}`, 30, 600_000);
  return internalLinks.pageLinks(project.id, project, url);
});
