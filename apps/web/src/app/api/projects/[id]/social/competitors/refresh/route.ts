import { z } from "zod";
import { recordAudit } from "@seo/core";
import { socialCompetitors } from "@seo/social";
import { handler } from "../../../../../../../lib/route";
import { costLimit } from "../../../../../../../lib/seo-data";
import { socialProjectFor } from "../../../../../../../lib/social";

const schema = z.object({ competitorId: z.string().max(40).optional() });

/**
 * POST {competitorId?} → refresh one competitor or all of them now and return
 * {competitors[]}. Telegram reads the public preview (cached 10 minutes);
 * Instagram tries Business Discovery and marks `unsupported` when the token
 * cannot use it. 30 refreshes an hour per project.
 */
export const POST = handler({ permission: "social:write", schema }, async ({ session, params, body, actor }) => {
  const project = await socialProjectFor(session, params.id);
  await costLimit(`social-competitors:${project.id}`, 30, 60 * 60_000);
  await socialCompetitors.refreshCompetitors(project.id, body.competitorId);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.competitor_refresh",
    targetType: "project",
    targetId: project.id,
    metadata: { competitorId: body.competitorId ?? null },
  });
  const rows = await socialCompetitors.listCompetitors(project.id);
  return { competitors: rows.map(socialCompetitors.competitorView) };
});
