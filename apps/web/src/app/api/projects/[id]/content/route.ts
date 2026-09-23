import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { projectFor } from "../../../../../lib/seo-data";

/** GET → {documents: [{id, title, targetKeyword, locale, score, url, createdAt, updatedAt, publishStatus}]} */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return { documents: await contentService.listDocuments(project.id) };
});

/**
 * POST {title, targetKeyword?, locale?, body? (HTML, sanitised on save), url?, metaTitle?, metaDescription?}
 * → 201 {document} with its score and analysis.
 */
export const POST = handler(
  { permission: "content:write", schema: contentService.createDocumentInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const document = await contentService.createDocument(project.id, body, actor.type === "USER" ? (actor.id ?? null) : null);
    await recordAudit({ orgId: session.orgId, actor, action: "content.create", targetType: "content_document", targetId: document.id, metadata: { projectId: project.id } });
    return NextResponse.json({ document }, { status: 201 });
  },
);
