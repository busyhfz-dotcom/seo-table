import { NextResponse } from "next/server";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { projectFor } from "../../../../../../../lib/seo-data";

/** GET → the document as a standalone HTML file (attachment). */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  const doc = await contentService.getDocument(project.id, params.docId!);
  const name = `${doc.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document"}.html`;
  return new NextResponse(contentService.exportHtml(doc), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="document.html"; filename*=UTF-8''${encodeURIComponent(name)}`,
      // The file is data to save, never a page to render in the panel's origin.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
});
