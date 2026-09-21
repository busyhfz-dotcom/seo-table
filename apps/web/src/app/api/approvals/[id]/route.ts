import { z } from "zod";
import { NotFound, proposalService } from "@seo/core";
import { handler } from "../../../../lib/route";
import { getFixForOrg } from "../../../../lib/queries";

const schema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(500).optional(),
});

/**
 * Approve or reject a proposal.
 *
 * `fix:approve_sensitive` is an ADMIN/OWNER permission, and the service refuses
 * any actor that is not a person — an agent can ask, never decide.
 */
export const POST = handler({ permission: "fix:approve_sensitive", schema }, async ({ session, params, body, ip }) => {
  const found = await getFixForOrg(session.orgId, params.id!);
  if (!found) throw new NotFound("Proposal not found");

  const updated = await proposalService.decide({
    proposalId: found.proposal.id,
    orgId: session.orgId,
    actor: { type: "USER", id: session.userId, ip },
    approve: body.decision === "approve",
    ...(body.reason ? { reason: body.reason } : {}),
  });
  return { proposal: updated };
});
