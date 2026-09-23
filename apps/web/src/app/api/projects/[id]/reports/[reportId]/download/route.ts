import { NextResponse } from "next/server";
import { reportService } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { projectFor } from "../../../../../../../lib/seo-data";

/** GET → the PDF (attachment; ?inline=1 to open it in the browser). */
export const GET = handler({ permission: "report:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const file = await reportService.reportFile(project.id, params.reportId!);
  const disposition = req.nextUrl.searchParams.get("inline") === "1" ? "inline" : "attachment";
  const ascii = file.fileKey.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.content.length),
      "content-disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileKey)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
