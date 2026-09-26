import { recordAudit } from "@seo/core";
import { integrations } from "@seo/seo-data";
import { handler } from "../../../../../lib/route";
import { costLimit } from "../../../../../lib/seo-data";

/**
 * POST → re-check the stored credential (DataForSEO: login and balance; PageSpeed:
 * a real run; Telegram: sends a test message to the chat). Same shape as PUT.
 */
export const POST = handler({ permission: "integration:manage" }, async ({ session, params, actor }) => {
  const kind = integrations.integrationKind(params.kind);
  await costLimit(`integration-test:${session.orgId}:${kind}`, 10, 3_600_000);
  const result = await integrations.testIntegration(session.orgId, kind);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "integration.test",
    targetType: "integration",
    targetId: `${session.orgId}:${kind}`,
    metadata: { kind, ok: result.ok, reason: result.reason },
  });
  return result;
});
