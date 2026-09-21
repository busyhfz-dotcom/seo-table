import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin } from "./lib/redirect";

/**
 * Two jobs, both cheap enough for the edge:
 *  - publish the pathname as a header so server components can render the active
 *    nav item and the breadcrumb without a client hook;
 *  - bounce anonymous traffic to /login before it reaches a page that would
 *    query the database. This is a convenience gate, not the security boundary:
 *    the real check is `requireSession()` in the layout and every route handler,
 *    because a cookie's presence proves nothing.
 */
const PUBLIC = ["/login", "/api/auth/login", "/api/health", "/api/ready", "/api/locale"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);

  // API routes authenticate themselves (session cookie or API key) and answer
  // 401 as JSON; redirecting a machine client to an HTML login page is wrong.
  const isApi = pathname.startsWith("/api/");
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!isApi && !isPublic && !req.cookies.has("seo_session")) {
    const url = new URL("/login", publicOrigin(req));
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
