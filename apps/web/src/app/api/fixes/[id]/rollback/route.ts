import { and, db, desc, eq, fixExecutions } from "@seo/db";
import { Conflict, NotFound } from "@seo/core";
import { rollback } from "@seo/pipeline";
import { handler } from "../../../../../lib/route";
import { getFixForOrg } from "../../../../../lib/queries";

/**
 * Undo the most recent live execution of a fix.
 *
 * Rollback needs no fresh approval: restoring the values recorded before a write
 * is always allowed, and refusing it would be the more dangerous default.
 */
export const POST = handler({ permission: "fix:rollback" }, async ({ session, params, actor }) => {
  const found = await getFixForOrg(session.orgId, params.id!);
  if (!found) throw new NotFound("Fix not found");

  const [execution] = await db
    .select()
    .from(fixExecutions)
    .where(and(eq(fixExecutions.fixProposalId, found.proposal.id), eq(fixExecutions.dryRun, false)))
    .orderBy(desc(fixExecutions.startedAt))
    .limit(1);

  if (!execution) throw new Conflict("This fix has never been applied, so there is nothing to undo");
  if (execution.rolledBackAt) throw new Conflict("This execution was already rolled back");

  const outcome = await rollback({
    executionId: execution.id,
    actor,
  });
  return outcome;
});
