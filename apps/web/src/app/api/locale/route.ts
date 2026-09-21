import { NextResponse, type NextRequest } from "next/server";
import { isLocale } from "../../../lib/i18n";

/**
 * Language switch. A GET so the switcher can be a plain link that works without
 * JavaScript; it only ever writes a preference cookie.
 */
export function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("set");
  const back = req.nextUrl.searchParams.get("next") ?? "/";
  const target = back.startsWith("/") ? back : "/";
  const res = NextResponse.redirect(new URL(target, req.nextUrl.origin));
  if (isLocale(requested)) {
    res.cookies.set("locale", requested, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
