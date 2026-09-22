/**
 * Fix execution.
 *
 * The order is always: dry run → policy check → claim → read → drift check →
 * snapshot → write. A live run without a recorded dry run is refused. Every
 * write is preceded by a persisted record of the value it replaces, read from
 * the site itself, which is what makes rollback possible rather than aspirational.
 *
 * Concurrency: a live apply first moves the proposal to APPLYING with a
 * conditional UPDATE, so of two simultaneous applies exactly one writes; a
 * rollback claims the execution the same way.
 */
import {
  and,
  approvals,
  db,
  eq,
  fixExecutions,
  fixProposals,
  inArray,
  isNull,
  ne,
  projects,
  sql,
  type FixProposal,
  type FixStatus,
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
import { forProject, type Connector, type WriteRequest, type WriteResult } from "@seo/connectors";

type Change = { url: string; field: string; before: string | null; after: string; selector?: string };

/**
 * One entry per write attempted, persisted before the write goes out.
 * `pending` means the process stopped between persisting and hearing back, so
 * the write may or may not have landed; rollback reads the site to find out.
 */
export type SnapshotEntry = {
  url: string;
  field: string;
  selector?: string;
  /** What the site held before, read from the site. null = empty. */
  previous: string | null;
  /** What was (or was about to be) written. */
  applied: string | null;
  state: "pending" | "written" | "failed";
};

export type ExecuteInput = {
  proposalId: string;
  dryRun: boolean;
  actor: Actor;
};

export type ExecuteOutcome = {
  executionId: string;
  dryRun: boolean;
  /** Final status of the execution row (DRAFT for a dry run). */
  status: FixStatus;
  applied: number;
  failed: number;
  skipped: number;
  results: WriteResult[];
};

/**
 * Proposal states a live apply may start from. FAILED is included so a partial
 * failure stays retryable: changes that already landed are recognised by their
 * current value and not written twice.
 */
const APPLICABLE: FixStatus[] = ["DRAFT", "APPROVED", "FAILED"];
/** Execution states that still have writes on the site to undo. */
const ROLLBACKABLE: FixStatus[] = ["APPLIED", "FAILED"];

const isEmpty = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";
const same = (a: string | null | undefined, b: string | null | undefined) =>
  (isEmpty(a) && isEmpty(b)) || (a ?? "").trim() === (b ?? "").trim();

/**
 * Has the field moved since the scan? A change scanned as empty requires it to
 * still be empty. One scanned with a value accepts that value or an empty store:
 * the scan sees the rendered page, and an SEO plugin renders a template default
 * (the post title, say) when its own field is empty.
 */
function drifted(change: Change, current: string | null): boolean {
  if (change.before === null) return !isEmpty(current);
  return !isEmpty(current) && !same(current, change.before);
}

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

  // Before the claim, so a missing connector cannot leave the proposal APPLYING.
  const connector = await forProject(proposal.projectId, "WORDPRESS");
  const capabilities = await connector.capabilities();

  if (!input.dryRun) {
    const claimed = await db
      .update(fixProposals)
      .set({ status: "APPLYING", updatedAt: new Date() })
      .where(and(eq(fixProposals.id, proposal.id), inArray(fixProposals.status, APPLICABLE)))
      .returning({ id: fixProposals.id });
    if (claimed.length === 0) {
      const current = await currentStatus(proposal.id);
      throw new Conflict(
        current === "APPLYING"
          ? "This fix is being applied right now"
          : `This fix cannot be applied from status ${current ?? "unknown"}`,
        { status: current },
      );
    }
  }

  let execution;
  try {
    execution = (
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
  } catch (err) {
    // Nothing was written yet: hand the claim back rather than strand it in APPLYING.
    if (!input.dryRun) {
      await db
        .update(fixProposals)
        .set({ status: proposal.status, updatedAt: new Date() })
        .where(and(eq(fixProposals.id, proposal.id), eq(fixProposals.status, "APPLYING")));
    }
    throw err;
  }

  const results: WriteResult[] = [];
  const snapshot: SnapshotEntry[] = [];
  let crash: unknown = null;

  try {
    for (const change of batch) {
      const base = { url: change.url, field: change.field };
      const req: WriteRequest = {
        ...base,
        before: change.before,
        after: change.after,
        ...(change.selector ? { selector: change.selector } : {}),
      };

      if (!capabilities.supportedActions.includes(proposal.action)) {
        results.push({
          ...base,
          ok: false,
          code: "unsupported_action",
          error: `The connected site cannot perform ${proposal.action}. ${capabilities.notes.join(" ")}`,
        });
        continue;
      }

      // The current value is the rollback snapshot, so it must come from the
      // site: a value we cannot read is a value we could not restore.
      const current = await readCurrent(connector, req);
      if (!current.ok) {
        results.push({
          ...base,
          ok: false,
          code: "unreadable",
          error: `The current value could not be read, so nothing was written: ${current.error}`,
        });
        continue;
      }
      const previous = current.value;

      if (same(previous, change.after)) {
        // Landed already (a retry after a partial failure, or edited by hand).
        results.push({ ...base, ok: true, code: "already_applied", previous, applied: previous });
        continue;
      }
      if (drifted(change, previous)) {
        results.push({
          ...base,
          ok: false,
          code: "changed_since_scan",
          error: "The page was edited after the scan, so this change was skipped.",
          previous,
        });
        continue;
      }

      if (input.dryRun) {
        results.push({ ...base, ok: true, previous, applied: change.after });
        continue;
      }

      const entry: SnapshotEntry = {
        ...base,
        ...(change.selector ? { selector: change.selector } : {}),
        previous,
        applied: change.after,
        state: "pending",
      };
      snapshot.push(entry);
      await db.update(fixExecutions).set({ snapshot }).where(eq(fixExecutions.id, execution.id));

      const result: WriteResult = connector.write
        ? await connector.write(req)
        : { ...base, ok: false, code: "not_writable", error: "Connector cannot write" };
      entry.state = result.ok ? "written" : "failed";
      if (result.ok && result.applied !== undefined) entry.applied = result.applied;
      results.push({ ...result, previous });
    }
  } catch (err) {
    crash = err;
  }

  const applied = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  // A partial failure is FAILED, not APPLIED: the rest stays retryable.
  const liveStatus: FixStatus = crash || failed > 0 ? "FAILED" : "APPLIED";
  const executionStatus: FixStatus = input.dryRun ? "DRAFT" : liveStatus;
  const crashMessage = crash ? (crash instanceof Error ? crash.message : String(crash)) : null;

  await db
    .update(fixExecutions)
    .set({
      status: executionStatus,
      appliedCount: applied,
      failedCount: failed,
      snapshot,
      results,
      finishedAt: new Date(),
      error: crashMessage
        ? `Stopped after ${results.length} of ${batch.length} changes: ${crashMessage}`.slice(0, 2000)
        : failed > 0
          ? `${failed} of ${batch.length} changes failed`
          : null,
    })
    .where(eq(fixExecutions.id, execution.id));

  await db
    .update(fixProposals)
    .set({
      updatedAt: new Date(),
      ...(input.dryRun
        ? { dryRun: { at: new Date().toISOString(), applied, failed, skipped, results } }
        : { status: liveStatus }),
    })
    .where(
      input.dryRun
        ? eq(fixProposals.id, proposal.id)
        : and(eq(fixProposals.id, proposal.id), eq(fixProposals.status, "APPLYING")),
    );

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
      ...(crashMessage ? { error: crashMessage.slice(0, 300) } : {}),
    },
  });
  metric(input.dryRun ? "fix.dry_run" : "fix.applied", applied, { action: proposal.action });

  if (crash) throw crash;
  log.info({ applied, failed, skipped }, input.dryRun ? "dry run complete" : "fix applied");
  return { executionId: execution.id, dryRun: input.dryRun, status: executionStatus, applied, failed, skipped, results };
}

/**
 * Restore the values recorded in an execution's snapshot. Rollback is itself an
 * audited write, and it never needs a fresh approval — undoing is always allowed.
 *
 * Each field is read first. A field still holding what the fix wrote is
 * restored (a value that was empty before is deleted); one already back at its
 * old value is left alone; one a person has changed since is reported and left
 * alone. The execution is ROLLED_BACK only when every entry is restored;
 * otherwise it stays rollback-able so the rest can be retried.
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

  const connector = await forProject(proposal.projectId, "WORDPRESS");

  // Claim the execution, then the proposal, so neither a second rollback nor a
  // concurrent re-apply can interleave with this one.
  const claimed = (
    await db
      .update(fixExecutions)
      .set({ status: "APPLYING" })
      .where(
        and(
          eq(fixExecutions.id, execution.id),
          eq(fixExecutions.dryRun, false),
          isNull(fixExecutions.rolledBackAt),
          inArray(fixExecutions.status, ROLLBACKABLE),
        ),
      )
      .returning()
  )[0];
  if (!claimed) throw new Conflict("This execution is already being rolled back, or has nothing to roll back");
  const executionWas = execution.status;

  const proposalClaim = await db
    .update(fixProposals)
    .set({ status: "APPLYING", updatedAt: new Date() })
    .where(and(eq(fixProposals.id, proposal.id), inArray(fixProposals.status, ROLLBACKABLE)))
    .returning({ status: fixProposals.status });
  if (proposalClaim.length === 0) {
    await db.update(fixExecutions).set({ status: executionWas }).where(eq(fixExecutions.id, execution.id));
    throw new Conflict("This fix is being applied or rolled back right now");
  }
  const proposalWas = proposal.status;

  const snapshot = legacySafeSnapshot(execution.snapshot, execution.results);
  const results: WriteResult[] = [];
  let crash: unknown = null;

  try {
    // Newest first, in case two entries touch the same field.
    for (const entry of [...snapshot].reverse()) {
      const base = { url: entry.url, field: entry.field };
      if (entry.state === "failed") {
        results.push({ ...base, ok: true, code: "nothing_to_restore" });
        continue;
      }
      const req = { ...base, ...(entry.selector ? { selector: entry.selector } : {}) };
      const current = await readCurrent(connector, req);
      if (!current.ok) {
        results.push({ ...base, ok: false, code: "unreadable", error: `Could not read the current value: ${current.error}` });
        continue;
      }
      if (same(current.value, entry.previous)) {
        results.push({ ...base, ok: true, code: "already_restored", applied: current.value });
        continue;
      }
      if (entry.applied !== undefined && !same(current.value, entry.applied)) {
        results.push({
          ...base,
          ok: false,
          code: "changed_since_apply",
          error: "Edited after the fix was applied, so it was left as it is.",
          previous: current.value,
        });
        continue;
      }
      const res: WriteResult = connector.write
        ? await connector.write({ ...req, before: current.value, after: entry.previous })
        : { ...base, ok: false, code: "not_writable", error: "Connector cannot write" };
      results.push(res);
    }
  } catch (err) {
    crash = err;
  }

  const restored = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  const complete = !crash && failures.length === 0;

  await db
    .update(fixExecutions)
    .set(
      complete
        ? { status: "ROLLED_BACK", rolledBackAt: new Date() }
        : {
            status: executionWas,
            error: `Rollback incomplete: ${failures.length} of ${snapshot.length} not restored${
              crash ? ` (${crash instanceof Error ? crash.message : String(crash)})` : ""
            }`.slice(0, 2000),
          },
    )
    .where(eq(fixExecutions.id, execution.id));

  // The proposal is ROLLED_BACK only when nothing it wrote is still live.
  const stillLive = complete
    ? await db
        .select({ id: fixExecutions.id })
        .from(fixExecutions)
        .where(
          and(
            eq(fixExecutions.fixProposalId, proposal.id),
            ne(fixExecutions.id, execution.id),
            eq(fixExecutions.dryRun, false),
            isNull(fixExecutions.rolledBackAt),
            sql`${fixExecutions.appliedCount} > 0`,
          ),
        )
        .limit(1)
    : [];
  const proposalStatus: FixProposal["status"] = complete && stillLive.length === 0 ? "ROLLED_BACK" : proposalWas;
  await db
    .update(fixProposals)
    .set({ status: proposalStatus, updatedAt: new Date() })
    .where(and(eq(fixProposals.id, proposal.id), eq(fixProposals.status, "APPLYING")));

  await recordAudit({
    orgId: project.orgId,
    actor: input.actor,
    action: "fix.rollback",
    targetType: "fix_execution",
    targetId: execution.id,
    metadata: {
      proposalId: proposal.id,
      restored,
      of: snapshot.length,
      complete,
      failures: failures.slice(0, 20).map((f) => ({ url: f.url, field: f.field, code: f.code })),
    },
  });
  metric("fix.rolled_back", restored);

  if (crash) throw crash;
  return {
    executionId: execution.id,
    dryRun: false,
    status: complete ? "ROLLED_BACK" : executionWas,
    applied: restored,
    failed: failures.length,
    skipped: 0,
    results,
  };
}

async function currentStatus(proposalId: string): Promise<FixStatus | null> {
  const row = (
    await db.select({ status: fixProposals.status }).from(fixProposals).where(eq(fixProposals.id, proposalId)).limit(1)
  )[0];
  return row?.status ?? null;
}

async function readCurrent(
  connector: Connector,
  req: Pick<WriteRequest, "url" | "field" | "selector">,
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
  if (!connector.read) return { ok: false, error: "this connector cannot read values back" };
  try {
    return { ok: true, value: await connector.read(req) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Snapshots written before `applied`/`state` existed recorded an entry for every
 * change, written or not. Their write results say which ones actually landed.
 */
function legacySafeSnapshot(snapshot: unknown, results: unknown): Array<Omit<SnapshotEntry, "applied"> & { applied?: string | null }> {
  const entries = (Array.isArray(snapshot) ? snapshot : []) as Array<Partial<SnapshotEntry> & { url: string; field: string }>;
  const written = (Array.isArray(results) ? results : []) as WriteResult[];
  return entries.map((e) => {
    if (e.state) return e as SnapshotEntry;
    const result = written.find((r) => r.url === e.url && r.field === e.field);
    return {
      url: e.url,
      field: e.field,
      ...(e.selector ? { selector: e.selector } : {}),
      previous: e.previous ?? null,
      ...(result?.ok && result.applied !== undefined ? { applied: result.applied } : {}),
      state: result?.ok ? "written" : "failed",
    };
  });
}
