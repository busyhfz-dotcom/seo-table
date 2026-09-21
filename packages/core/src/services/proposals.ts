/**
 * Fix proposals and approvals.
 *
 * A proposal never executes itself. It is created, dry-run, and then either
 * auto-applied (LOW risk only) or parked in the approval queue. Redirects, URL
 * changes and merges take the second path every time — enforced here, and again
 * by a database trigger.
 */
import {
  and,
  approvals,
  db,
  desc,
  eq,
  fixProposals,
  inArray,
  seoIssues,
  type FixAction,
  type FixProposal,
  type RiskLevel,
} from "@seo/db";
import type { Finding, IssueGroup } from "../rules/index.js";
import { ALWAYS_APPROVAL, effectiveRisk, limits as policyLimits, requiresApproval } from "../policy.js";
import { Conflict, NotFound } from "../errors.js";
import { record as recordAudit, type Actor } from "../auditlog.js";
import { childLogger, metric } from "../logger.js";

export type ProposalDraft = {
  projectId: string;
  issueId: string | null;
  ruleId: string;
  action: FixAction;
  risk: RiskLevel;
  title: string;
  rationale: string;
  changes: Array<{ url: string; field: string; before: string | null; after: string; selector?: string }>;
};

/**
 * Collapse the fixes attached to a group of findings into one proposal per
 * (rule, action) — a user approves "trim 77 meta descriptions" once, not 77 times.
 */
export function draftsFromGroups(projectId: string, groups: IssueGroup[], issueIdByFingerprint: Map<string, string>): ProposalDraft[] {
  const drafts = new Map<string, ProposalDraft>();

  for (const group of groups) {
    for (const finding of group.findings) {
      const fix = finding.fix;
      if (!fix) continue;
      const key = `${finding.ruleId}:${fix.action}`;
      const existing = drafts.get(key);
      if (existing) {
        if (!existing.changes.some((c) => c.url === fix.change.url && c.selector === fix.change.selector)) {
          existing.changes.push(fix.change);
        }
        continue;
      }
      drafts.set(key, {
        projectId,
        issueId: issueIdByFingerprint.get(group.fingerprint) ?? null,
        ruleId: finding.ruleId,
        action: fix.action,
        risk: effectiveRisk(fix.action, fix.risk),
        title: fix.title,
        rationale: fix.rationale,
        changes: [fix.change],
      });
    }
  }

  // Respect the change cap by splitting, not by silently truncating.
  const cap = policyLimits().maxChangesPerExecution;
  const out: ProposalDraft[] = [];
  for (const draft of drafts.values()) {
    if (draft.changes.length <= cap) {
      out.push(draft);
      continue;
    }
    for (let i = 0; i < draft.changes.length; i += cap) {
      const slice = draft.changes.slice(i, i + cap);
      out.push({
        ...draft,
        title: `${draft.title} (${i / cap + 1}/${Math.ceil(draft.changes.length / cap)})`,
        changes: slice,
      });
    }
  }
  return out;
}

export type CreatedProposal = FixProposal & { needsApproval: boolean };

export async function createProposals(input: {
  orgId: string;
  actor: Actor;
  drafts: ProposalDraft[];
}): Promise<CreatedProposal[]> {
  const log = childLogger({ component: "proposals" });
  const created: CreatedProposal[] = [];

  for (const draft of input.drafts) {
    if (draft.changes.length === 0) continue;
    const needsApproval = requiresApproval(draft.action, draft.risk);

    const row = (
      await db
        .insert(fixProposals)
        .values({
          projectId: draft.projectId,
          issueId: draft.issueId,
          ruleId: draft.ruleId,
          action: draft.action,
          risk: draft.risk,
          // DRAFT until a dry run has been recorded; the executor enforces that.
          status: "DRAFT",
          title: draft.title,
          rationale: draft.rationale,
          targetCount: draft.changes.length,
          changes: draft.changes,
        })
        .returning()
    )[0]!;

    if (needsApproval) {
      await db.insert(approvals).values({
        fixProposalId: row.id,
        decision: "PENDING",
        requestedBy: input.actor.id ?? input.actor.type,
      });
      await db
        .update(fixProposals)
        .set({ status: "AWAITING_APPROVAL", updatedAt: new Date() })
        .where(eq(fixProposals.id, row.id));
      await recordAudit({
        orgId: input.orgId,
        actor: input.actor,
        action: "approval.request",
        targetType: "fix_proposal",
        targetId: row.id,
        metadata: {
          action: draft.action,
          risk: draft.risk,
          targetCount: draft.changes.length,
          neverAutomatic: ALWAYS_APPROVAL.includes(draft.action),
        },
      });
    }

    await recordAudit({
      orgId: input.orgId,
      actor: input.actor,
      action: "fix.propose",
      targetType: "fix_proposal",
      targetId: row.id,
      metadata: { action: draft.action, risk: draft.risk, targetCount: draft.changes.length },
    });

    created.push({ ...row, needsApproval });
    metric("fix.proposed", 1, { action: draft.action, risk: draft.risk });
  }

  log.info({ count: created.length }, "proposals created");
  return created;
}

export async function getProposal(id: string): Promise<FixProposal | null> {
  const rows = await db.select().from(fixProposals).where(eq(fixProposals.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function pendingApprovals(projectId: string) {
  return db
    .select({
      proposal: fixProposals,
      approval: approvals,
      issue: seoIssues,
    })
    .from(fixProposals)
    .leftJoin(approvals, eq(approvals.fixProposalId, fixProposals.id))
    .leftJoin(seoIssues, eq(seoIssues.id, fixProposals.issueId))
    .where(
      and(
        eq(fixProposals.projectId, projectId),
        eq(fixProposals.status, "AWAITING_APPROVAL"),
      ),
    )
    .orderBy(desc(fixProposals.createdAt));
}

export async function decide(input: {
  proposalId: string;
  orgId: string;
  actor: Actor;
  approve: boolean;
  reason?: string;
}): Promise<FixProposal> {
  const proposal = await getProposal(input.proposalId);
  if (!proposal) throw new NotFound("Proposal not found");
  if (proposal.status !== "AWAITING_APPROVAL") {
    throw new Conflict(`Proposal is ${proposal.status}; only AWAITING_APPROVAL can be decided`);
  }
  // An agent can request approval but can never grant it.
  if (input.actor.type !== "USER") {
    throw new Conflict("Only a person can approve or reject a fix");
  }

  await db
    .update(approvals)
    .set({
      decision: input.approve ? "APPROVED" : "REJECTED",
      decidedById: input.actor.id ?? null,
      decidedAt: new Date(),
      reason: input.reason ?? null,
    })
    .where(eq(approvals.fixProposalId, proposal.id));

  const updated = (
    await db
      .update(fixProposals)
      .set({ status: input.approve ? "APPROVED" : "REJECTED", updatedAt: new Date() })
      .where(eq(fixProposals.id, proposal.id))
      .returning()
  )[0]!;

  await recordAudit({
    orgId: input.orgId,
    actor: input.actor,
    action: input.approve ? "approval.approve" : "approval.reject",
    targetType: "fix_proposal",
    targetId: proposal.id,
    metadata: { action: proposal.action, risk: proposal.risk, reason: input.reason ?? null },
  });
  metric(input.approve ? "approval.approved" : "approval.rejected", 1, { action: proposal.action });

  return updated;
}

export async function proposalsForProject(
  projectId: string,
  statuses?: FixProposal["status"][],
): Promise<FixProposal[]> {
  const where = statuses?.length
    ? and(eq(fixProposals.projectId, projectId), inArray(fixProposals.status, statuses))
    : eq(fixProposals.projectId, projectId);
  return db.select().from(fixProposals).where(where).orderBy(desc(fixProposals.createdAt));
}

/** Findings carrying a fix, for the Auto Fixes screen's "what could be fixed" count. */
export function fixableCount(findings: Finding[]): { low: number; sensitive: number; restricted: number } {
  const out = { low: 0, sensitive: 0, restricted: 0 };
  for (const f of findings) {
    if (!f.fix) continue;
    const risk = effectiveRisk(f.fix.action, f.fix.risk);
    if (risk === "LOW") out.low++;
    else if (risk === "SENSITIVE") out.sensitive++;
    else out.restricted++;
  }
  return out;
}
