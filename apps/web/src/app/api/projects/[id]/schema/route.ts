import { BadRequest } from "@seo/core";
import { schemaMarkup } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { pageUrlParam, projectFor } from "../../../../../lib/seo-data";

/**
 * GET ?url= → {types, existing}: the templates the generator offers, and the
 * JSON-LD the page already serves according to the latest scan, each node
 * validated. existing.status: "ok" | "no_scan" | "not_crawled" | "needs_rescan"
 * (a scan from before page details were recorded).
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const url = pageUrlParam(req, project) ?? project.baseUrl;
  if (!/^https?:\/\//i.test(url)) throw new BadRequest("url must be an http(s) address");
  return { types: schemaMarkup.SUPPORTED_TYPES, existing: await schemaMarkup.existingSchema(project.id, url) };
});
