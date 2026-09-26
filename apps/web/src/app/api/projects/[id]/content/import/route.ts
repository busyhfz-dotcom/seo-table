import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../../lib/seo-data";

/**
 * POST {url, targetKeyword?} → 201 {document}: a live page of the project's own
 * site, its main content extracted and sanitised. 30 an hour per project.
 */
export const POST = handler({ permission: "content:write", schema: contentService.importInput }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`content-import:${project.id}`, 30, 3_600_000);
  const document = await contentService.importFromUrl(project.id, body, actor.type === "USER" ? (actor.id ?? null) : null);
  await recordAudit({ orgId: session.orgId, actor, action: "content.import", targetType: "content_document", targetId: document.id, metadata: { url: document.url } });
  return NextResponse.json({ document }, { status: 201 });
});
