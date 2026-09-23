import { applyTarget, sitemapService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { projectFor } from "../../../../../lib/seo-data";

/**
 * GET ?images=1 → the sitemap the latest scan supports, without the file
 * bodies: {status: "ok"|"no_scan", files: [{path, urls, bytes}], urls,
 * withLastmod, images, excluded: {reason: count}, scannedAt, apply}.
 * Download a file with …/sitemap/file?path=/sitemap.xml.
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const images = req.nextUrl.searchParams.get("images") === "1";
  const [sitemap, apply] = await Promise.all([sitemapService.generateSitemap(project.id, { images }), applyTarget(project.id, "SITEMAP_XML")]);
  return { ...sitemap, files: sitemap.files.map((f) => ({ path: f.path, urls: f.urls, bytes: Buffer.byteLength(f.body) })), apply };
});
