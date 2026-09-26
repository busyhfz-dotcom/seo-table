import { NextResponse } from "next/server";
import { recordAudit } from "@seo/core";
import { startInstagramOAuth } from "@seo/social";
import { handler } from "../../../../../lib/route";
import { redirectTo } from "../../../../../lib/redirect";
import { socialProjectFor } from "../../../../../lib/social";

/**
 * GET ?project=<id> → 302 to Instagram's consent screen, with a signed state
 * bound to this person, organization and project. Without an Instagram app on
 * the server: 302 back to /social?project=<id>&instagram=error&reason=not_configured.
 */
export const GET = handler({ permission: "connector:write", sessionOnly: true }, async ({ req, session, actor }) => {
  const project = await socialProjectFor(session, req.nextUrl.searchParams.get("project") ?? undefined, "INSTAGRAM");
  const started = startInstagramOAuth(project, session.userId);
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "social.oauth_start",
    targetType: "project",
    targetId: project.id,
    metadata: { ok: started.ok, reason: started.ok ? null : started.reason },
  });
  if (!started.ok) return redirectTo(`/social?project=${project.id}&instagram=error&reason=${started.reason}`, 302);
  // Absolute and external by design: safePath would (rightly) refuse it.
  return new NextResponse(null, { status: 302, headers: { Location: started.url } });
});
