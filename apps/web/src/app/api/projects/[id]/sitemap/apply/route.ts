import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@seo/core";
import { sitemapService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({ images: z.boolean().optional() });

/**
 * POST {images?} → 201 {proposal, target, sitemap}: a SITEMAP_XML fix proposal
 * (SENSITIVE) serving the generated sitemap file(s) from the Cloudflare edge.
 * 409 {reason, manual: true} when the write target cannot serve files.
 */
export const POST = handler({ permission: "fix:propose", schema }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  const result = await sitemapService.proposeSitemap({ projectId: project.id, orgId: session.orgId, actor, images: body.images ?? false });
  await recordAudit({ orgId: session.orgId, actor, action: "sitemap.propose", targetType: "fix_proposal", targetId: result.proposal.id, metadata: { urls: result.sitemap.urls, files: result.sitemap.files.length } });
  const { sitemap, ...rest } = result;
  return NextResponse.json({ ...rest, sitemap: { ...sitemap, files: sitemap.files.map((f) => ({ path: f.path, urls: f.urls, bytes: Buffer.byteLength(f.body) })) } }, { status: 201 });
});
