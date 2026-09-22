import { NotFound, evaluatePolicy, ApprovalRequired, enqueueFix, PolicyViolation } from "@seo/core";
import { handler } from "../../../../../lib/route";
import { getFixForOrg } from "../../../../../lib/queries";

/**
 * Apply a fix for real.
 *
 * The policy is evaluated here so the caller gets a clear 403 with the reason,
 * and again inside the executor, and a third time by a database trigger. A
 * redirect, URL change or page merge without an approved approval row fails at
 * every one of those layers.
 */
export const POST = handler({ permission: "fix:apply_low_risk" }, async ({ session, params, actor, correlationId }) => {
  const found = await getFixForOrg(session.orgId, params.id!);
  if (!found) throw new NotFound("Fix not found");

  const proposal = found.proposal;
  const approved = found.approval?.decision === "APPROVED";
  const changes = (proposal.changes as unknown[]) ?? [];

  const decision = evaluatePolicy({
    action: proposal.action,
    risk: proposal.risk,
    changeCount: changes.length,
    dryRun: false,
    approved,
    hasDryRunResult: Boolean(proposal.dryRun),
    actor: actor.type,
  });

  if (!decision.allowed) {
    if (decision.reasons.includes("restricted_action") || decision.reasons.includes("approval_required")) {
      throw new ApprovalRequired(proposal.action);
    }
    throw new PolicyViolation(`Refused by the safety policy: ${decision.reasons.join(", ")}`, decision);
  }

  const jobId = await enqueueFix({
    proposalId: proposal.id,
    projectId: found.project.id,
    dryRun: false,
    requestedBy: session.userId,
    correlationId,
  });
  return { queued: true, jobId, proposalId: proposal.id, risk: decision.risk };
});
