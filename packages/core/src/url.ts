/**
 * URL normalisation. Two URLs normalise to the same string only when they are
 * the same request as far as any server is concerned, because the crawler dedupes
 * on this key and the rules compare pages by it. Anything a server may treat as
 * a different resource — a trailing slash, /index.html, a bare `?flag` — is
 * kept exactly as written; collapsing those made `/blog` → `/blog/` look like a
 * redirect to itself.
 */
const TRACKING_PARAMS = new Set(["gclid", "fbclid", "msclkid", "mc_eid", "mc_cid", "_hsenc", "_hsmi", "yclid"]);

function isTrackingParam(rawKey: string): boolean {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch {
    /* an undecodable key is not one of ours */
  }
  key = key.toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * RFC 3986 §6.2.2: escapes compare case-insensitively and an escaped unreserved
 * character is the character itself, so `%7e`, `%7E` and `~` are one URL.
 */
function normalizeEscapes(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // WHATWG URL already lowercases the host and drops a default port.
  u.hash = "";
  u.hostname = u.hostname.replace(/\.$/, "");
  u.pathname = normalizeEscapes(u.pathname || "/");

  // Pairs are split by hand rather than through searchParams, which would turn
  // `?flag` into `?flag=` and re-encode values the server sees differently.
  const pairs = u.search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "" && !isTrackingParam(pair.split("=")[0] ?? ""))
    .map(normalizeEscapes);
  pairs.sort((a, b) => {
    const ka = a.split("=")[0]!;
    const kb = b.split("=")[0]!;
    return ka === kb ? 0 : ka < kb ? -1 : 1;
  });
  u.search = pairs.length ? `?${pairs.join("&")}` : "";

  return u.toString();
}

/** The URL to request for a discovered href: absolute, without the fragment. */
export function absoluteUrl(input: string, base?: string): string | null {
  try {
    const u = new URL(input, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function sameSite(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return registrableHost(ua.hostname) === registrableHost(ub.hostname);
  } catch {
    return false;
  }
}

/** Treats www and the bare host as the same site; good enough for crawl scope. */
export function registrableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function pathDepth(url: string): number {
  try {
    const p = new URL(url).pathname;
    if (p === "/" || p === "") return 0;
    return p.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function isProbablyAsset(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|gz|mp4|webm|mp3|woff2?|ttf|eot)(\?|$)/i.test(
    url,
  );
}

export function joinPath(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
