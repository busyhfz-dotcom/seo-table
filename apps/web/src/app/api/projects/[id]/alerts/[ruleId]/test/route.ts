import { recordAudit } from "@seo/core";
import { alertService, reasonText } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { costLimit, projectFor } from "../../../../../../../lib/seo-data";

/**
 * POST → sends a test event through the rule's webhook/Telegram now.
 * {webhook: {ok, reason, text} | null, telegram: {…} | null} (null = channel not on this rule).
 */
export const POST = handler({ permission: "project:write" }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`alert-test:${project.id}`, 10, 3_600_000);
  const result = await alertService.testRule(project.id, params.ruleId!);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "alert.test",
    targetType: "alert_rule",
    targetId: params.ruleId!,
    metadata: { webhook: result.webhook?.ok ?? null, telegram: result.telegram?.ok ?? null },
  });
  const withText = (r: { ok: boolean; reason: string | null } | null) => (r ? { ...r, text: reasonText(r.reason) } : null);
  return { webhook: withText(result.webhook), telegram: withText(result.telegram) };
});
