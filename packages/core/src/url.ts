/**
 * URL normalisation. Two URLs that fetch the same document must normalise to the
 * same string, otherwise duplicate detection and the per-run unique index both
 * misbehave.
 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "yclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "_ga",
]);

export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }

  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);

  // Collapse duplicate slashes, drop a trailing slash except on the root, and
  // drop an index document so /a/ and /a/index.html are one page.
  let pathname = u.pathname.replace(/\/{2,}/g, "/");
  pathname = pathname.replace(/\/index\.(html?|php)$/i, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  u.pathname = pathname === "" ? "/" : pathname;

  return u.toString();
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
