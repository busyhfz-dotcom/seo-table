import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../../../lib/seo-data";

/** POST → {document}: re-run the analysis with fresh Search Console, crawl and competitor data. */
export const POST = handler({ permission: "content:write" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`content-analyze:${session.userId}`, 60, 60_000);
  return { document: await contentService.reanalyze(project.id, params.docId!) };
});
