import { recordAudit } from "@seo/core";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET → {document} (with body, score, analysis and publish state). */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return { document: await contentService.getDocumentView(project.id, params.docId!) };
});

/** PATCH any of {title, targetKeyword, locale, body, url, metaTitle, metaDescription} → {document}, re-analysed. */
export const PATCH = handler(
  { permission: "content:write", schema: contentService.updateDocumentInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const document = await contentService.updateDocument(project.id, params.docId!, body);
    await recordAudit({ orgId: session.orgId, actor, action: "content.update", targetType: "content_document", targetId: document.id, metadata: { fields: Object.keys(body) } });
    return { document };
  },
);

export const DELETE = handler({ permission: "content:write" }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  await contentService.deleteDocument(project.id, params.docId!);
  await recordAudit({ orgId: session.orgId, actor, action: "content.delete", targetType: "content_document", targetId: params.docId! });
  return { ok: true };
});
