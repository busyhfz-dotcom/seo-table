import { NextResponse, type NextRequest } from "next/server";
import { redirectTo } from "../../../../lib/redirect";
import { logout } from "../../../../lib/auth";
import { isCrossSite } from "../../../../lib/request";

/**
 * Logout is a POST so it cannot be triggered by a link or an image, and it
 * redirects rather than returning JSON so the plain HTML form works without
 * client-side JavaScript. Another site's form cannot sign the user out.
 */
export async function POST(req: NextRequest) {
  if (isCrossSite(req.headers)) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Cross-site requests are not allowed" } },
      { status: 403 },
    );
  }
  await logout();
  return redirectTo("/login", 303);
}
