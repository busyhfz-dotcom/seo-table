import { NextResponse } from "next/server";
import { enqueueSocialSync, recordAudit } from "@seo/core";
import { completeInstagramOAuth, verifyState } from "@seo/social";
import { handler } from "../../../../../lib/route";
import { redirectTo } from "../../../../../lib/redirect";
import { getProject } from "../../../../../lib/queries";

/**
 * GET ?code=&state= (or ?error=…) — where Instagram sends the owner back.
 * The state must be ours, unexpired, and issued to the person now signed in,
 * for a project of their organization; otherwise nothing is stored. Always
 * ends with a 302 to /social?project=<id>&instagram=connected|error&reason=…
 * (reasons: access_denied, state_invalid, not_configured, personal_account,
 * token_exchange_failed, invalid_token, permission_denied, network_error).
 */
export const GET = handler({ sessionOnly: true }, async ({ req, session, actor, correlationId }) => {
  const q = req.nextUrl.searchParams;
  const state = verifyState(q.get("state"));
  const back = (projectId: string | null, outcome: string) =>
    redirectTo(projectId ? `/social?project=${projectId}&instagram=${outcome}` : `/social?instagram=${outcome}`, 302);
  if (!state || state.u !== session.userId || state.o !== session.orgId) return back(null, "error&reason=state_invalid");
  const project = await getProject(session.orgId, state.p);
  if (!project || project.kind !== "INSTAGRAM") return back(null, "error&reason=state_invalid");
  const fail = async (reason: string) => {
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "social.connect_failed",
      targetType: "project",
      targetId: project.id,
      metadata: { platform: "INSTAGRAM", reason },
    });
    return back(project.id, `error&reason=${encodeURIComponent(reason)}`);
  };
  if (q.get("error")) return fail("access_denied");
  const code = q.get("code");
  if (!code || code.length > 2000) return fail("state_invalid");

  const result = await completeInstagramOAuth(project, code, session.userId);
  if (!result.ok) return fail(result.reason);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.connect",
    targetType: "project",
    targetId: project.id,
    metadata: { platform: "INSTAGRAM", username: result.account.username, scopes: result.account.scopes },
  });
  await enqueueSocialSync({ projectId: project.id, trigger: "MANUAL", requestedBy: session.userId, correlationId }).catch(() => undefined);
  return back(project.id, "connected") as NextResponse;
});
