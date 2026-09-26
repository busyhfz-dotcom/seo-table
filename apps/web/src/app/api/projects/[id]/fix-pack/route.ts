import { NextResponse } from "next/server";
import { NotFound, recordAudit } from "@seo/core";
import { buildFixPack, zipFixPack } from "@seo/connectors";
import { handler } from "../../../../../lib/route";
import { getProject } from "../../../../../lib/queries";

/**
 * The fix pack: every open proposal as files to apply by hand (redirects for
 * nginx, Apache and Cloudflare Bulk Redirects, a meta table, image alt text,
 * JSON-LD, sitemap.xml, robots.txt — only what the audit proposes — and a
 * README in Persian and English).
 *
 *   ?run=<runId>  limit to what that run saw (default: the latest successful run)
 *   ?list=1       JSON listing of the files instead of the zip, for a preview
 */
export const GET = handler({ permission: "report:read" }, async ({ req, session, params, actor }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const runId = req.nextUrl.searchParams.get("run") ?? undefined;
  const pack = await buildFixPack(project.id, runId);

  if (req.nextUrl.searchParams.get("list") === "1") {
    return {
      runId: pack.runId,
      counts: pack.counts,
      files: pack.files.map((f) => ({ path: f.path, contentType: f.contentType, bytes: Buffer.byteLength(f.body) })),
    };
  }

  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "fixpack.download",
    targetType: "project",
    targetId: project.id,
    metadata: { runId: pack.runId, files: pack.files.map((f) => f.path), counts: pack.counts },
  });
  const host = new URL(project.baseUrl).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(Buffer.from(zipFixPack(pack)), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="seo-fix-pack-${host}-${date}.zip"`,
      "cache-control": "no-store",
    },
  });
});
