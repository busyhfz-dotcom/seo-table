import { z } from "zod";
import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({ keyword: z.string().trim().min(1).max(150), locale: z.enum(["fa", "en"]).optional() });

/**
 * POST {keyword, locale?} → content brief: Search Console queries and questions
 * containing the keyword, our ranking pages, competitor pages and their H2
 * outline, target length. 30 an hour per project.
 */
export const POST = handler({ permission: "content:write", schema }, async ({ session, params, body }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`content-brief:${project.id}`, 30, 3_600_000);
  return { brief: await contentService.contentBrief(project.id, { keyword: body.keyword, locale: body.locale ?? project.locale }) };
});
