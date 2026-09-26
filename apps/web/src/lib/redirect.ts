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

/**
 * Only same-site paths: "/x" is fine; "//evil.example", "/\\evil" and anything
 * with a control character are not. Browsers silently drop tabs and newlines from
 * a Location value (so "/\t/evil.example" becomes "//evil.example"), and a raw
 * newline in a header throws, so those are refused before parsing. The result is
 * the URL parser's own serialization, re-checked, because normalization can turn
 * an innocent-looking "/.//evil.example" into "//evil.example".
 */
export function safePath(p: string | null | undefined, fallback = "/"): string {
  if (!p || !p.startsWith("/") || p.includes("\\") || hasControlChar(p)) return fallback;
  let url: URL;
  try {
    url = new URL(p, "http://x");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://x") return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.startsWith("//") ? fallback : path;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
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
