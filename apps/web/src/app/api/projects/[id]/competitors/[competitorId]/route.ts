import { z } from "zod";
import { recordAudit } from "@seo/core";
import { competitorService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET → the competitor and its latest sampled pages (title, meta, headings, words, schema types, links, homepage CWV). */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return competitorService.competitorPages(project.id, params.competitorId!);
});

/** PATCH {name} */
export const PATCH = handler(
  { permission: "tracking:write", schema: z.object({ name: z.string().trim().min(1).max(120).nullable() }) },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const competitor = await competitorService.updateCompetitor(project.id, params.competitorId!, body);
    await recordAudit({ orgId: session.orgId, actor, action: "competitor.update", targetType: "competitor", targetId: competitor.id });
    return { competitor };
  },
);

export const DELETE = handler({ permission: "tracking:write" }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  await competitorService.deleteCompetitor(project.id, params.competitorId!);
  await recordAudit({ orgId: session.orgId, actor, action: "competitor.delete", targetType: "competitor", targetId: params.competitorId! });
  return { ok: true };
});
