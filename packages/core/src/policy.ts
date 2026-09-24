/**
 * Execution safety policy.
 *
 * This module is the only place that answers "may this change run, and by
 * whose authority". The database enforces the same rule independently
 * (migration 0001), so a bug here fails closed rather than silently applying a
 * redirect.
 *
 * The three tiers:
 *   LOW        the agent may apply automatically. Restricted to changes that add
 *              a missing attribute or trim existing prose — nothing that changes
 *              where a URL resolves or what a visitor reads.
 *   SENSITIVE  a human must approve. Rewrites of text visitors see.
 *   RESTRICTED a human must approve, and there is no automatic path at all.
 *              Redirects, URL changes, page merges.
 */
import type { FixAction, RiskLevel } from "@seo/db";
import { env } from "./env.js";
import { ApprovalRequired, PolicyViolation } from "./errors.js";

/** Actions that can never execute without an approval row, whatever their risk field says. */
export const ALWAYS_APPROVAL: readonly FixAction[] = ["REDIRECT", "URL_CHANGE", "PAGE_MERGE"];

export const ACTION_RISK: Record<FixAction, RiskLevel> = {
  ALT_TEXT: "LOW",
  SITEMAP_ADD: "LOW",
  META_REWRITE: "LOW",
  TITLE_REWRITE: "SENSITIVE",
  H1_FIX: "SENSITIVE",
  CANONICAL_FIX: "SENSITIVE",
  ROBOTS_FIX: "SENSITIVE",
  INTERNAL_LINK: "SENSITIVE",
  REDIRECT: "RESTRICTED",
  URL_CHANGE: "RESTRICTED",
  PAGE_MERGE: "RESTRICTED",
  // Whole documents that change what search engines read about the site:
  // structured data can earn (or lose) rich results and invite a manual action,
  // robots.txt can hide the whole site, and a replaced sitemap drops every URL
  // it no longer lists. A person decides each one.
  SCHEMA_MARKUP: "SENSITIVE",
  ROBOTS_TXT: "SENSITIVE",
  SITEMAP_XML: "SENSITIVE",
  // What a page or channel says about itself, and posts in its owner's name,
  // are public statements by that owner: a person decides each one.
  SOCIAL_PROFILE_NAME: "SENSITIVE",
  SOCIAL_BIO: "SENSITIVE",
  SOCIAL_TITLE: "SENSITIVE",
  SOCIAL_DESCRIPTION: "SENSITIVE",
  SOCIAL_POST: "SENSITIVE",
};

/**
 * The effective risk of an action. Takes the stricter of the declared risk and
 * the action's floor, so a caller cannot downgrade a redirect by passing
 * `risk: "LOW"`.
 */
export function effectiveRisk(action: FixAction, declared?: RiskLevel): RiskLevel {
  const floor = ACTION_RISK[action];
  const order: RiskLevel[] = ["LOW", "SENSITIVE", "RESTRICTED"];
  const a = order.indexOf(floor);
  const b = declared ? order.indexOf(declared) : -1;
  return order[Math.max(a, b)]!;
}

export function requiresApproval(action: FixAction, declared?: RiskLevel): boolean {
  if (ALWAYS_APPROVAL.includes(action)) return true;
  return effectiveRisk(action, declared) !== "LOW";
}

export function agentMayAutoApply(action: FixAction, declared?: RiskLevel): boolean {
  return !requiresApproval(action, declared);
}

export type PolicyLimits = {
  maxChangesPerExecution: number;
  requireDryRunFirst: boolean;
  requireSnapshot: boolean;
  allowRollback: boolean;
};

export function limits(overrides: Partial<PolicyLimits> = {}): PolicyLimits {
  const ceiling = env().MAX_CHANGES_PER_EXECUTION;
  const requested = overrides.maxChangesPerExecution ?? ceiling;
  return {
    // A project setting may tighten the cap but never raise it above the env ceiling.
    maxChangesPerExecution: Math.min(requested, ceiling),
    requireDryRunFirst: overrides.requireDryRunFirst ?? true,
    requireSnapshot: overrides.requireSnapshot ?? true,
    allowRollback: overrides.allowRollback ?? true,
  };
}

export type ExecutionRequest = {
  action: FixAction;
  risk?: RiskLevel;
  changeCount: number;
  dryRun: boolean;
  approved: boolean;
  hasDryRunResult: boolean;
  actor: "USER" | "AGENT" | "API_KEY" | "SYSTEM";
};

export type PolicyDecision = {
  allowed: boolean;
  risk: RiskLevel;
  reasons: string[];
};

/**
 * Evaluate a request without throwing — used by the UI to explain why a button
 * is disabled. `assertExecutionAllowed` is the enforcing version.
 */
export function evaluate(req: ExecutionRequest): PolicyDecision {
  const risk = effectiveRisk(req.action, req.risk);
  const reasons: string[] = [];
  const l = limits();

  if (req.changeCount > l.maxChangesPerExecution) {
    reasons.push(
      `change_cap_exceeded:${req.changeCount}>${l.maxChangesPerExecution}`,
    );
  }
  if (req.changeCount === 0) reasons.push("no_changes");

  // A dry run is always permitted: it writes nothing anywhere.
  if (req.dryRun) {
    return { allowed: reasons.length === 0, risk, reasons };
  }

  if (requiresApproval(req.action, req.risk) && !req.approved) {
    reasons.push(ALWAYS_APPROVAL.includes(req.action) ? "restricted_action" : "approval_required");
  }
  if (req.actor === "AGENT" && !agentMayAutoApply(req.action, req.risk) && !req.approved) {
    reasons.push("agent_not_permitted");
  }
  if (l.requireDryRunFirst && !req.hasDryRunResult) {
    reasons.push("dry_run_required");
  }

  return { allowed: reasons.length === 0, risk, reasons };
}

export function assertExecutionAllowed(req: ExecutionRequest): PolicyDecision {
  const decision = evaluate(req);
  if (decision.allowed) return decision;

  if (decision.reasons.includes("restricted_action")) {
    throw new ApprovalRequired(req.action);
  }
  if (decision.reasons.includes("approval_required") || decision.reasons.includes("agent_not_permitted")) {
    throw new ApprovalRequired(req.action);
  }
  throw new PolicyViolation(
    `Execution refused by the safety policy: ${decision.reasons.join(", ")}`,
    { reasons: decision.reasons, risk: decision.risk, action: req.action },
  );
}

/** Human-readable policy, rendered on the Settings → Execution policy screen. */
export function describePolicy(): {
  tiers: Array<{ risk: RiskLevel; actions: FixAction[]; autoApply: boolean }>;
  limits: PolicyLimits;
  neverWithoutApproval: FixAction[];
} {
  const tiers: RiskLevel[] = ["LOW", "SENSITIVE", "RESTRICTED"];
  return {
    tiers: tiers.map((risk) => ({
      risk,
      actions: (Object.keys(ACTION_RISK) as FixAction[]).filter((a) => ACTION_RISK[a] === risk),
      autoApply: risk === "LOW",
    })),
    limits: limits(),
    neverWithoutApproval: [...ALWAYS_APPROVAL],
  };
}
