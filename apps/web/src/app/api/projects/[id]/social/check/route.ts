import { recordAudit } from "@seo/core";
import { socialAccounts } from "@seo/social";
import { handler } from "../../../../../../lib/route";
import { refusal, socialProjectFor } from "../../../../../../lib/social";

/** POST → re-check the connection now: {ok:true, account} or {ok:false, reason, reasonText, account}. */
export const POST = handler({ permission: "connector:read" }, async ({ session, params, actor }) => {
  const project = await socialProjectFor(session, params.id);
  const result = await socialAccounts.recheck(project.id);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.check",
    targetType: "project",
    targetId: project.id,
    metadata: { ok: result.ok, reason: result.reason },
  });
  const account = socialAccounts.accountView(result.account);
  return result.ok ? { ok: true as const, account } : refusal(result.reason, { account });
});
