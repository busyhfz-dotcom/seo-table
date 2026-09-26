import { NextResponse } from "next/server";
import { z } from "zod";
import { NotFound, recordAudit } from "@seo/core";
import { handler } from "../../../../lib/route";
import { switchOrg } from "../../../../lib/auth";
import { redirectTo, safePath } from "../../../../lib/redirect";

const schema = z.object({
  orgId: z.string().min(1).max(40),
  /** Where a plain HTML form lands afterwards; ignored for JSON callers. */
  next: z.string().max(2000).optional(),
});

/**
 * Switch the organization this browser session acts in. Only organizations the
 * user is a member of can be chosen; anything else is a 404, so the endpoint
 * cannot be used to probe which organization ids exist. Accepts JSON (answers
 * JSON) or a plain HTML form (answers with a redirect to `next`).
 */
export const POST = handler({ sessionOnly: true, acceptForm: true, schema }, async ({ session, body, actor, isForm }) => {
  if (body.orgId !== session.orgId) {
    if (!(await switchOrg(body.orgId))) throw new NotFound("Organization not found");
    await recordAudit({
      orgId: body.orgId,
      actor,
      action: "auth.org_switch",
      targetType: "organization",
      targetId: body.orgId,
      metadata: { from: session.orgId },
    });
  }
  if (isForm) return redirectTo(safePath(body.next), 303);
  return NextResponse.json({ orgId: body.orgId });
});
