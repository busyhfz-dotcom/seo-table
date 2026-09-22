import { NotFound, enqueueFix } from "@seo/core";
import { handler } from "../../../../../lib/route";
import { getFixForOrg } from "../../../../../lib/queries";

/**
 * Queue a dry run. It writes nothing to the connected site: it reads the current
 * value of each target and returns the diff that a live apply would produce.
 * A live apply is refused until a dry run has been recorded.
 */
export const POST = handler({ permission: "fix:propose" }, async ({ session, params, correlationId }) => {
  const found = await getFixForOrg(session.orgId, params.id!);
  if (!found) throw new NotFound("Fix not found");

  const jobId = await enqueueFix({
    proposalId: found.proposal.id,
    projectId: found.project.id,
    dryRun: true,
    requestedBy: session.userId,
    correlationId,
  });
  return { queued: true, jobId, proposalId: found.proposal.id };
});
