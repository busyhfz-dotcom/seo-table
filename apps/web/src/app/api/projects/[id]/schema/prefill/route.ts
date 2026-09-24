import { BadRequest } from "@seo/core";
import { schemaMarkup } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { pageUrlParam, projectFor } from "../../../../../../lib/seo-data";

/**
 * GET ?type=Article&url= → {data, from}: the template's form fields filled from
 * the crawl (title, H1, description, image, Last-Modified) and the page's own
 * markup of that type. `from` lists the sources used ("crawl", "page_markup").
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const type = req.nextUrl.searchParams.get("type") ?? "";
  if (!(schemaMarkup.SUPPORTED_TYPES as readonly string[]).includes(type)) throw new BadRequest("Unknown schema type", { field: "type" });
  const url = pageUrlParam(req, project);
  if (url && !/^https?:\/\//i.test(url)) throw new BadRequest("url must be an http(s) address");
  return schemaMarkup.prefill(project.id, type as schemaMarkup.SchemaType, url);
});
