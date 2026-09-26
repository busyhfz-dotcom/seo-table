import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@seo/core";
import { schemaMarkup } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({ url: z.string().trim().url().max(2000), jsonld: z.record(z.unknown()) });

/**
 * POST {url, jsonld} → 201 {proposal, target, issues, conflicts}: a
 * SCHEMA_MARKUP fix proposal (SENSITIVE, so it waits for approval) that sets the
 * page's JSON-LD on the write target. 400 with {issues} when the markup has
 * errors; 409 {reason: "unsupported_action" | "not_connected", manual: true}
 * when the write target cannot inject JSON-LD — use the fix pack instead.
 */
export const POST = handler({ permission: "fix:propose", schema }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  const result = await schemaMarkup.proposeSchema({ projectId: project.id, orgId: session.orgId, actor, url: body.url, jsonld: body.jsonld });
  await recordAudit({ orgId: session.orgId, actor, action: "schema.propose", targetType: "fix_proposal", targetId: result.proposal.id, metadata: { url: body.url, type: body.jsonld["@type"] ?? null, target: result.target.target } });
  return NextResponse.json(result, { status: 201 });
});
