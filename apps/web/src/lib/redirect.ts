import { NextResponse, type NextRequest } from "next/server";

/**
 * Redirects with a *relative* Location header.
 *
 * Behind a proxy (Railway, a CDN) the server only sees its own bind address, so
 * `req.nextUrl.origin` can be `http://0.0.0.0:3000` and an absolute redirect built
 * from it sends the browser nowhere. A relative Location (RFC 9110 §10.2.2) is
 * resolved by the browser against the address it actually used.
 */
export function redirectTo(path: string, status: 302 | 303 | 307 = 307): NextResponse {
  return new NextResponse(null, { status, headers: { Location: safePath(path) } });
}

/** Only same-site paths: "/x" is fine, "//evil.example" and "/\\evil" are not. */
export function safePath(p: string | null | undefined, fallback = "/"): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return fallback;
  return p;
}

/**
 * The origin the browser used, for the few places that need an absolute URL
 * (middleware responses must be absolute). Prefers the proxy's forwarded
 * headers, then Host, and only then the server's own view of itself.
 */
export function publicOrigin(req: NextRequest): string {
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  const host = first(req.headers.get("x-forwarded-host")) ?? first(req.headers.get("host")) ?? req.nextUrl.host;
  const proto = first(req.headers.get("x-forwarded-proto")) ?? req.nextUrl.protocol.replace(/:$/, "");
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
