/**
 * Fix execution.
 *
 * The order is always: dry run → policy check → snapshot → write → verify.
 * A live run without a recorded dry run is refused. Every write records the
 * value it replaced, which is what makes rollback possible rather than aspirational.
 */
import {
  db,
  eq,
  fixExecutions,
  fixProposals,
  approvals,
  projects,
  type FixProposal,
} from "@seo/db";
import {
  assertExecutionAllowed,
  childLogger,
  metric,
  policyLimits,
  recordAudit,
  NotFound,
  Conflict,
  type Actor,
} from "@seo/core";
import { forProject, type WriteRequest, type WriteResult } from "@seo/connectors";

type Change = { url: string; field: string; before: string | null; after: string; selector?: string };

export type ExecuteInput = {
  proposalId: string;
  dryRun: boolean;
  actor: Actor;
};

export type ExecuteOutcome = {
  executionId: string;
  dryRun: boolean;
  applied: number;
  failed: number;
  skipped: number;
  results: WriteResult[];
};

export async function execute(input: ExecuteInput): Promise<ExecuteOutcome> {
  const log = childLogger({ component: "execute", proposalId: input.proposalId, dryRun: input.dryRun });

  const proposal = (
    await db.select().from(fixProposals).where(eq(fixProposals.id, input.proposalId)).limit(1)
  )[0];
  if (!proposal) throw new NotFound("Proposal not found");

  const project = (
    await db.select().from(projects).where(eq(projects.id, proposal.projectId)).limit(1)
  )[0];
  if (!project) throw new NotFound("Project not found");

  const approval = (
    await db.select().from(approvals).where(eq(approvals.fixProposalId, proposal.id)).limit(1)
  )[0];
  const approved = approval?.decision === "APPROVED";

  const changes = (proposal.changes as Change[]) ?? [];

  // The policy decides; it throws ApprovalRequired or PolicyViolation with a code
  // the API surfaces verbatim.
  assertExecutionAllowed({
    action: proposal.action,
    risk: proposal.risk,
    changeCount: changes.length,
    dryRun: input.dryRun,
    approved,
    hasDryRunResult: Boolean(proposal.dryRun),
    actor: input.actor.type,
  });

  if (!input.dryRun && proposal.status === "APPLIED") {
    throw new Conflict("This fix has already been applied");
  }

  const cap = policyLimits().maxChangesPerExecution;
  const batch = changes.slice(0, cap);
  const skipped = changes.length - batch.length;

  const execution = (
    await db
      .insert(fixExecutions)
      .values({
        fixProposalId: proposal.id,
        dryRun: input.dryRun,
        status: "APPLYING",
        appliedCount: 0,
        failedCount: 0,
      })
      .returning()
  )[0]!;

  if (!input.dryRun) {
    await db
      .update(fixProposals)
      .set({ status: "APPLYING", updatedAt: new Date() })
      .where(eq(fixProposals.id, proposal.id));
  }

  const connector = await forProject(proposal.projectId, "WORDPRESS");
  const capabilities = await connector.capabilities();
  const results: WriteResult[] = [];
  const snapshot: Array<{ url: string; field: string; selector?: string; previous: string | null }> = [];

  for (const change of batch) {
    const req: WriteRequest = {
      url: change.url,
      field: change.field,
      before: change.before,
      after: change.after,
      ...(change.selector ? { selector: change.selector } : {}),
    };

    if (!capabilities.supportedActions.includes(proposal.action)) {
      results.push({
        url: change.url,
        field: change.field,
        ok: false,
        code: "unsupported_action",
        error: `The connected site cannot perform ${proposal.action}. ${capabilities.notes.join(" ")}`,
      });
      continue;
    }

    // Read the current value first: this is the rollback snapshot, and it also
    // catches the case where someone edited the page since the scan.
    let previous: string | null = change.before;
    try {
      previous = (await connector.read?.(req)) ?? change.before;
    } catch {
      /* a failed read is not fatal; the write result also reports `previous` */
    }
    snapshot.push({
      url: change.url,
      field: change.field,
      ...(change.selector ? { selector: change.selector } : {}),
      previous,
    });

    if (input.dryRun) {
      results.push({
        url: change.url,
        field: change.field,
        ok: true,
        previous,
        applied: change.after,
      });
      continue;
    }

    // Drifted since the scan: refuse rather than overwrite someone's edit.
    if (change.before !== null && previous !== null && previous !== change.before) {
      results.push({
        url: change.url,
        field: change.field,
        ok: false,
        code: "changed_since_scan",
        error: "The page was edited after the scan, so this change was skipped.",
        previous,
      });
      continue;
    }

    const result = connector.write
      ? await connector.write(req)
      : { url: change.url, field: change.field, ok: false, code: "not_writable", error: "Connector cannot write" };
    results.push({ ...result, previous: result.previous ?? previous });
  }

  const applied = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const finalStatus: FixProposal["status"] = input.dryRun
    ? proposal.status === "DRAFT"
      ? "DRAFT"
      : proposal.status
    : failed === batch.length && batch.length > 0
      ? "FAILED"
      : "APPLIED";

  await db
    .update(fixExecutions)
    .set({
      status: input.dryRun ? "DRAFT" : finalStatus,
      appliedCount: applied,
      failedCount: failed,
      snapshot,
      results,
      finishedAt: new Date(),
      error: failed > 0 ? `${failed} of ${batch.length} changes failed` : null,
    })
    .where(eq(fixExecutions.id, execution.id));

  await db
    .update(fixProposals)
    .set({
      status: finalStatus,
      updatedAt: new Date(),
      ...(input.dryRun
        ? { dryRun: { at: new Date().toISOString(), applied, failed, skipped, results } }
        : {}),
    })
    .where(eq(fixProposals.id, proposal.id));

  await recordAudit({
    orgId: project.orgId,
    actor: input.actor,
    action: input.dryRun ? "fix.dry_run" : "fix.apply",
    targetType: "fix_proposal",
    targetId: proposal.id,
    metadata: {
      action: proposal.action,
      risk: proposal.risk,
      applied,
      failed,
      skipped,
      approved,
    },
  });
  metric(input.dryRun ? "fix.dry_run" : "fix.applied", applied, { action: proposal.action });

  log.info({ applied, failed, skipped }, input.dryRun ? "dry run complete" : "fix applied");
  return { executionId: execution.id, dryRun: input.dryRun, applied, failed, skipped, results };
}

/**
 * Restore the values recorded in an execution's snapshot. Rollback is itself an
 * audited write, and it never needs a fresh approval — undoing is always allowed.
 */
export async function rollback(input: { executionId: string; actor: Actor }): Promise<ExecuteOutcome> {
  const execution = (
    await db.select().from(fixExecutions).where(eq(fixExecutions.id, input.executionId)).limit(1)
  )[0];
  if (!execution) throw new NotFound("Execution not found");
  if (execution.dryRun) throw new Conflict("A dry run has nothing to roll back");
  if (execution.rolledBackAt) throw new Conflict("This execution was already rolled back");

  const proposal = (
    await db.select().from(fixProposals).where(eq(fixProposals.id, execution.fixProposalId)).limit(1)
  )[0];
  if (!proposal) throw new NotFound("Proposal not found");
  const project = (
    await db.select().from(projects).where(eq(projects.id, proposal.projectId)).limit(1)
  )[0];
  if (!project) throw new NotFound("Project not found");

  const snapshot = (execution.snapshot as Array<{ url: string; field: string; selector?: string; previous: string | null }>) ?? [];
  const connector = await forProject(proposal.projectId, "WORDPRESS");
  const results: WriteResult[] = [];

  for (const entry of snapshot) {
    if (entry.previous === null) {
      // There was nothing there before. Restoring "nothing" is a no-op we record
      // rather than guessing at an empty-string write.
      results.push({
        url: entry.url,
        field: entry.field,
        ok: true,
        code: "no_previous_value",
        applied: null,
      });
      continue;
    }
    const res = connector.write
      ? await connector.write({
          url: entry.url,
          field: entry.field,
          before: null,
          after: entry.previous,
          ...(entry.selector ? { selector: entry.selector } : {}),
        })
      : { url: entry.url, field: entry.field, ok: false, error: "Connector cannot write" };
    results.push(res);
  }

  const applied = results.filter((r) => r.ok).length;
  await db
    .update(fixExecutions)
    .set({ rolledBackAt: new Date(), status: "ROLLED_BACK" })
    .where(eq(fixExecutions.id, execution.id));
  await db
    .update(fixProposals)
    .set({ status: "ROLLED_BACK", updatedAt: new Date() })
    .where(eq(fixProposals.id, proposal.id));

  await recordAudit({
    orgId: project.orgId,
    actor: input.actor,
    action: "fix.rollback",
    targetType: "fix_execution",
    targetId: execution.id,
    metadata: { proposalId: proposal.id, restored: applied, of: snapshot.length },
  });
  metric("fix.rolled_back", applied);

  return {
    executionId: execution.id,
    dryRun: false,
    applied,
    failed: results.length - applied,
    skipped: 0,
    results,
  };
}
