import { z } from "zod";
import { BadRequest, recordAudit } from "@seo/core";
import { integrations } from "@seo/seo-data";
import { handler } from "../../../../lib/route";
import { costLimit } from "../../../../lib/seo-data";

/** GET → one integration's public view. :kind is dataforseo | pagespeed | telegram_alerts (any case, "-" or "_"). */
export const GET = handler({ permission: "integration:manage" }, async ({ session, params }) =>
  integrations.getIntegration(session.orgId, integrations.integrationKind(params.kind)),
);

/**
 * PUT — verify live, then store sealed. Bodies:
 *   DATAFORSEO       {login, password, rankTracking?=true, maxDailySerpChecks?=200}
 *   PAGESPEED        {apiKey}
 *   TELEGRAM_ALERTS  {botToken, chatId}
 * → {ok, reason, message, messageText:{fa,en}, …view}. A failed check stores
 * status ERROR and the reason but no credential. 10 per hour per organization.
 */
export const PUT = handler({ permission: "integration:manage", schema: z.record(z.unknown()) }, async ({ session, params, body, actor }) => {
  const kind = integrations.integrationKind(params.kind);
  const parsed = integrations.integrationInput[kind].safeParse(body);
  if (!parsed.success) {
    throw new BadRequest("The request body is not valid", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  await costLimit(`integration:${session.orgId}:${kind}`, 10, 3_600_000);
  const result = await integrations.saveIntegration(session.orgId, kind, parsed.data);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "integration.connect",
    targetType: "integration",
    targetId: `${session.orgId}:${kind}`,
    // Whether it worked and why not — never what was typed.
    metadata: { kind, ok: result.ok, reason: result.reason },
  });
  return result;
});

/** PATCH (DATAFORSEO only) {rankTracking?, maxDailySerpChecks?} — settings without re-entering the password. */
export const PATCH = handler(
  {
    permission: "integration:manage",
    schema: z.object({ rankTracking: z.boolean().optional(), maxDailySerpChecks: z.number().int().min(0).max(5000).optional() }),
  },
  async ({ session, params, body, actor }) => {
    const kind = integrations.integrationKind(params.kind);
    if (kind !== "DATAFORSEO") {
      throw new BadRequest("Only DataForSEO has settings");
    }
    const view = await integrations.updateDataForSeoSettings(session.orgId, body);
    await recordAudit({ orgId: session.orgId, actor, action: "integration.connect", targetType: "integration", targetId: `${session.orgId}:${kind}`, metadata: { kind, settings: body } });
    return view;
  },
);

export const DELETE = handler({ permission: "integration:manage" }, async ({ session, params, actor }) => {
  const kind = integrations.integrationKind(params.kind);
  await integrations.deleteIntegration(session.orgId, kind);
  await recordAudit({ orgId: session.orgId, actor, action: "integration.disconnect", targetType: "integration", targetId: `${session.orgId}:${kind}`, metadata: { kind } });
  return { kind, status: "NOT_CONNECTED" };
});
