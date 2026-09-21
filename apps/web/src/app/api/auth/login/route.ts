import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "../../../../lib/route";
import { login } from "../../../../lib/auth";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export const POST = handler({ public: true, schema }, async ({ body }) => {
  const result = await login(body.email, body.password);
  if (!result.ok) {
    // One message for a wrong password and an unknown account: which of the two
    // it was is not the caller's business.
    return NextResponse.json(
      { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } },
      { status: 401 },
    );
  }
  return NextResponse.json({
    user: { email: result.session.email, name: result.session.name },
    org: { id: result.session.orgId, name: result.session.orgName },
    role: result.session.role,
  });
});
