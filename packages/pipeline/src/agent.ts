/**
 * Agent mode.
 *
 * After a successful run the agent looks at the proposals the analysis produced
 * and does exactly two things:
 *
 *   1. LOW-risk proposals: dry-run, then apply — but only when the connected site
 *      actually supports the action, and only within the change cap.
 *   2. Everything else: leave it in the approval queue, untouched.
 *
 * It cannot approve anything. `decide()` refuses a non-USER actor, the policy
 * refuses an agent actor for non-LOW risk, and the database refuses to move a
 * restricted proposal to APPLYING without an approval row. Three independent
 * layers, because this is the part of the product that can damage a live site.
 */
import { and, db, eq, fixProposals, inArray, projects } from "@seo/db";
import {
  agentMayAutoApply,
  AGENT,
  childLogger,
  metric,
  recordAudit,
  ALWAYS_APPROVAL,
} from "@seo/core";
import { forProjectOrNull } from "@seo/connectors";
import { execute } from "./execute.js";

export type AgentReport = {
  projectId: string;
  considered: number;
  autoApplied: number;
  queuedForApproval: number;
  skipped: Array<{ proposalId: string; reason: string }>;
};

export async function runAgent(projectId: string): Promise<AgentReport> {
  const log = childLogger({ component: "agent", projectId });
  const report: AgentReport = {
    projectId,
    considered: 0,
    autoApplied: 0,
    queuedForApproval: 0,
    skipped: [],
  };

  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) return report;

  const candidates = await db
    .select()
    .from(fixProposals)
    .where(
      and(
        eq(fixProposals.projectId, projectId),
        inArray(fixProposals.status, ["DRAFT", "AWAITING_APPROVAL"]),
      ),
    );
  report.considered = candidates.length;

  const connector = await forProjectOrNull(projectId, "WORDPRESS");
  const capabilities = connector ? await connector.capabilities() : null;

  for (const proposal of candidates) {
    // A restricted action is never even attempted — not as a dry run with a
    // hopeful apply afterwards, not at all.
    if (ALWAYS_APPROVAL.includes(proposal.action) || !agentMayAutoApply(proposal.action, proposal.risk)) {
      report.queuedForApproval++;
      continue;
    }

    if (!connector || !capabilities) {
      report.skipped.push({ proposalId: proposal.id, reason: "no_connector" });
      continue;
    }
    if (!capabilities.supportedActions.includes(proposal.action)) {
      report.skipped.push({ proposalId: proposal.id, reason: "action_unsupported_by_site" });
      continue;
    }

    try {
      // Dry run first, always. The policy refuses a live apply without one.
      const dry = await execute({ proposalId: proposal.id, dryRun: true, actor: AGENT });
      if (dry.applied === 0) {
        report.skipped.push({ proposalId: proposal.id, reason: "dry_run_produced_no_changes" });
        continue;
      }
      const live = await execute({ proposalId: proposal.id, dryRun: false, actor: AGENT });
      if (live.applied > 0) report.autoApplied++;
      else report.skipped.push({ proposalId: proposal.id, reason: "all_writes_failed" });
    } catch (err) {
      const message = (err as Error).message;
      report.skipped.push({ proposalId: proposal.id, reason: message.slice(0, 120) });
      await recordAudit({
        orgId: project.orgId,
        actor: AGENT,
        action: "fix.apply_blocked",
        targetType: "fix_proposal",
        targetId: proposal.id,
        metadata: { action: proposal.action, risk: proposal.risk, reason: message.slice(0, 300) },
      });
    }
  }

  metric("agent.auto_applied", report.autoApplied);
  metric("agent.queued_for_approval", report.queuedForApproval);
  log.info(report, "agent pass complete");
  return report;
}
