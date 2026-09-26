import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { keywordService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { dataSources, projectFor } from "../../../../../lib/seo-data";

/**
 * GET: tracked keywords with their latest numbers per source.
 *   ?tag=  ?q= (substring)  ?archived=1 (the archive instead of active keywords)
 */
export const GET = handler({ permission: "project:read" }, async ({ req, session, params }) => {
  const project = await projectFor(session, params.id);
  const p = req.nextUrl.searchParams;
  const [list, sources] = await Promise.all([
    keywordService.listKeywords(project.id, {
      tag: p.get("tag") ?? undefined,
      q: p.get("q") ?? undefined,
      archived: p.get("archived") === "1",
    }),
    dataSources(project),
  ]);
  return { ...list, sources };
});

/** POST: add up to 500 keywords (a list, or one phrase per line). Duplicates are skipped, not errors. */
export const POST = handler(
  { permission: "tracking:write", schema: keywordService.addKeywordsInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const result = await keywordService.addKeywords(project.id, keywordService.addKeywordsInput.parse(body));
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "keyword.add",
      targetType: "project",
      targetId: project.id,
      metadata: { added: result.added.length, skipped: result.skipped },
    });
    return NextResponse.json(result, { status: 201 });
  },
);
