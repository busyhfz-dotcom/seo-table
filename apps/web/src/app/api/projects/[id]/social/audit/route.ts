import { Conflict, recordAudit } from "@seo/core";
import { socialAccounts, socialAudit } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../lib/social";

/**
 * GET → the latest social audit: {run, score, findings[]}. Each finding has
 * title/why/detail in {fa, en}, severity, status, `manual` (the platform's API
 * cannot apply it: copy `suggestion.value` into the app), and `proposal` when a
 * change waits in the approval queue (Telegram title/description).
 * POST → run the audit now on the data already synced (no platform calls) and
 * return the same shape.
 */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await socialProjectFor(session, params.id);
  return { rules: socialAudit.SOCIAL_RULES.filter((r) => r.platform === project.kind), ...(await socialAudit.auditResults(project.id)) };
});

export const POST = handler({ permission: "social:write" }, async ({ session, params, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const account = await socialAccounts.getAccount(project.id);
  if (!account || account.status === "NOT_CONNECTED") throw new Conflict("The account is not connected", { reason: "not_connected" });
  const outcome = await socialAudit.runAudit({ project, actor, trigger: actor.type === "API_KEY" ? "API" : "MANUAL" });
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.audit",
    targetType: "audit_run",
    targetId: outcome.runId,
    metadata: { score: outcome.score, findings: outcome.findings.length, proposals: outcome.proposals.length },
  });
  return { rules: socialAudit.SOCIAL_RULES.filter((r) => r.platform === project.kind), ...(await socialAudit.auditResults(project.id)) };
});
