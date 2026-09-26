import { NextResponse } from "next/server";
import { NotFound } from "@seo/core";
import { sitemapService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET ?path=/sitemap.xml&images=1 → the generated file (application/xml attachment), for manual upload. */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const path = req.nextUrl.searchParams.get("path") ?? "/sitemap.xml";
  const sitemap = await sitemapService.generateSitemap(project.id, { images: req.nextUrl.searchParams.get("images") === "1" });
  const file = sitemap.files.find((f) => f.path === path);
  if (!file) throw new NotFound("No such sitemap file");
  return new NextResponse(file.body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${path.slice(1)}"`,
      "x-content-type-options": "nosniff",
    },
  });
});
