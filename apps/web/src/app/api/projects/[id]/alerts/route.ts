import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { alertService } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { projectFor } from "../../../../../lib/seo-data";

/** GET → {rules: AlertRuleView[], defaults: {kind: threshold}} — every project starts with one in-app rule per kind. */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await projectFor(session, params.id);
  return { rules: await alertService.listRules(project.id), defaults: alertService.DEFAULT_THRESHOLDS };
});

/**
 * POST {kind, threshold?, channels: ("in_app"|"webhook"|"telegram")[], webhookUrl?, enabled?}
 * → 201 {rule, webhookSecret}. webhookSecret is shown only here (and on rotation).
 */
export const POST = handler(
  { permission: "project:write", schema: alertService.createAlertInput },
  async ({ session, params, body, actor }) => {
    const project = await projectFor(session, params.id);
    const result = await alertService.createRule(project.id, alertService.createAlertInput.parse(body));
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "alert.create",
      targetType: "alert_rule",
      targetId: result.rule.id,
      metadata: { kind: body.kind, channels: result.rule.channels, webhook: Boolean(result.rule.webhookUrl) },
    });
    return NextResponse.json(result, { status: 201 });
  },
);
