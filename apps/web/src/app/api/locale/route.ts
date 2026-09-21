import { type NextRequest } from "next/server";
import { redirectTo, safePath } from "../../../lib/redirect";
import { isLocale } from "../../../lib/i18n";

/**
 * Language switch. A GET so the switcher can be a plain link that works without
 * JavaScript; it only ever writes a preference cookie.
 */
export function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("set");
  const res = redirectTo(safePath(req.nextUrl.searchParams.get("next")));
  if (isLocale(requested)) {
    res.cookies.set("locale", requested, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
