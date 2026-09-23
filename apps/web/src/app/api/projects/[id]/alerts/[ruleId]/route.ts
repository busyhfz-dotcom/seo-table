import { recordAudit } from "@seo/core";
import { alertService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** PATCH {threshold?, channels?, webhookUrl?, enabled?, rotateSecret?} → {rule, webhookSecret (only when a new one was issued)} */
export const PATCH = handler(
  { permission: "project:write", schema: alertService.updateAlertInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const result = await alertService.updateRule(project.id, params.ruleId!, body);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "alert.update",
      targetType: "alert_rule",
      targetId: result.rule.id,
      metadata: { fields: Object.keys(body), secretRotated: Boolean(result.webhookSecret) },
    });
    return result;
  },
);

export const DELETE = handler({ permission: "project:write" }, async ({ session, params, actor }) => {
  const project = await projectFor(session, params.id);
  await alertService.deleteRule(project.id, params.ruleId!);
  await recordAudit({ orgId: session.orgId, actor, action: "alert.delete", targetType: "alert_rule", targetId: params.ruleId! });
  return { ok: true };
});
