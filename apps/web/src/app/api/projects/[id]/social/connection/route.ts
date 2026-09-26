import { recordAudit } from "@seo/core";
import { socialAccounts } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { socialProjectFor } from "../../../../../../lib/social";

/**
 * DELETE → forget the token (Telegram: the webhook is removed too). The page or
 * channel is not touched, and synced history, audits and plans stay.
 */
export const DELETE = handler({ permission: "connector:write" }, async ({ session, params, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const row = await socialAccounts.disconnect(project.id);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.disconnect",
    targetType: "project",
    targetId: project.id,
    metadata: { platform: row.platform },
  });
  return { account: socialAccounts.accountView(row) };
});
