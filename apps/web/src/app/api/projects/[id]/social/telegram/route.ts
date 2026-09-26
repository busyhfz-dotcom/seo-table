import { enqueueSocialSync, recordAudit } from "@seo/core";
import { socialAccounts } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { requestedBy } from "../../../../../../lib/seo-data";
import { refusal, socialProjectFor } from "../../../../../../lib/social";

/**
 * POST {botToken, channel} → connect a Telegram channel through a bot the owner
 * made an administrator. The token is verified against the channel first and
 * stored sealed only when the bot can manage it:
 *   {ok:true, account, syncJobId}
 *   {ok:false, reason: invalid_token | chat_not_found | not_a_channel | not_admin | missing_right:<name>, reasonText, missing?}
 */
export const POST = handler(
  { permission: "connector:write", schema: socialAccounts.telegramConnectInput, sessionOnly: true },
  async ({ session, params, body, actor, correlationId }) => {
    const project = await socialProjectFor(session, params.id, "TELEGRAM");
    const result = await socialAccounts.connectTelegram(project, body, session.userId);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: result.ok ? "social.connect" : "social.connect_failed",
      targetType: "project",
      targetId: project.id,
      // The channel is public information; the token never enters the log.
      metadata: { platform: "TELEGRAM", channel: body.channel, ok: result.ok, reason: result.reason ?? null },
    });
    if (!result.ok) return refusal(result.reason, { missing: result.missing ?? [] });
    let syncJobId: string | null = null;
    try {
      syncJobId = (await enqueueSocialSync({ projectId: project.id, trigger: "MANUAL", requestedBy: requestedBy(actor), correlationId })).jobId;
    } catch {
      // Connected either way; the daily sync (or "sync now") fills the data.
    }
    return { ok: true as const, account: socialAccounts.accountView(result.account), syncJobId };
  },
);
