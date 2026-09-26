import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { socialCompetitors } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../lib/social";

/**
 * GET → {competitors[], max}. Each: username, status (pending | ok |
 * unsupported | not_found | no_public_preview | error) with statusText {fa,en},
 * and the latest snapshot (followers, posts per week, average views or
 * interactions, recent posts) labelled with its source.
 * POST {username} → 201 {competitor} (an @name or profile URL; at most 10).
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await socialProjectFor(session, params.id);
  const rows = await socialCompetitors.listCompetitors(project.id);
  return { competitors: rows.map(socialCompetitors.competitorView), max: socialCompetitors.MAX_SOCIAL_COMPETITORS };
});

export const POST = handler({ permission: "social:write", schema: socialCompetitors.competitorInput }, async ({ session, params, body, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const row = await socialCompetitors.addCompetitor(project.id, body);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.competitor_add",
    targetType: "social_competitor",
    targetId: row.id,
    metadata: { username: row.username, platform: row.platform },
  });
  return NextResponse.json({ competitor: socialCompetitors.competitorView(row) }, { status: 201 });
});
