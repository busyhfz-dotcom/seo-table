import { contentService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../../lib/seo-data";

/**
 * POST {title, targetKeyword?, locale?, body?, url?, metaTitle?, metaDescription?} → {analysis}
 * Scores an unsaved draft (live feedback while typing). 60 a minute per person.
 */
export const POST = handler(
  { permission: "content:write", schema: contentService.analyzeDraftInput },
  async ({ session, params, body }) => {
    const project = await projectFor(session, params.id);
    await costLimit(`content-analyze:${session.userId}`, 60, 60_000);
    const analysis = await contentService.analyzeFor(project.id, {
      title: body.title,
      targetKeyword: body.targetKeyword ?? null,
      locale: body.locale ?? project.locale,
      body: contentService.sanitizeHtml(body.body ?? ""),
      url: body.url ?? null,
      metaTitle: body.metaTitle ?? null,
      metaDescription: body.metaDescription ?? null,
    });
    return { analysis };
  },
);
