/**
 * Rule keys shared by the edge worker and the panel.
 *
 * The worker imports this module at the edge; the Cloudflare connector imports
 * the same file under Node. One implementation means the panel and the edge
 * can never disagree on which rule belongs to which URL.
 */

/** Keys longer than this are hashed; KV refuses keys over 512 bytes. */
const MAX_KEY_BYTES = 480;

export const BYPASS_HEADER = "x-seo-table-bypass";
export const EDGE_HEADER = "x-seo-table-edge";
export const MANIFEST_KEY = "m";
export const BYPASS_KEY = "cfg:bypass";
/** Query parameter the panel adds to defeat page caches when it reads the site. */
export const CACHE_BUSTER = "_seotable";

// Mirrors normalizeUrl in @seo/core: these parameters never make a different page.
const TRACKING_PARAMS = new Set(["gclid", "fbclid", "msclkid", "mc_eid", "mc_cid", "_hsenc", "_hsmi", "yclid", CACHE_BUSTER]);
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** RFC 3986 §6.2.2: `%7e`, `%7E` and `~` are one URL. */
function normalizeEscapes(s) {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, hex) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

function isTrackingParam(rawKey) {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch {
    /* an undecodable key is not one of ours */
  }
  key = key.toLowerCase();
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/** www and apex are one site; the scheme never matters. */
export function hostKey(hostname) {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** Path plus the query without tracking parameters, sorted by name — the same identity the crawler uses. */
export function pathKey(url) {
  const u = new URL(url);
  const pairs = u.search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "" && !isTrackingParam(pair.split("=")[0] ?? ""))
    .map(normalizeEscapes);
  pairs.sort((a, b) => {
    const ka = a.split("=")[0];
    const kb = b.split("=")[0];
    return ka === kb ? 0 : ka < kb ? -1 : 1;
  });
  return normalizeEscapes(u.pathname || "/") + (pairs.length ? `?${pairs.join("&")}` : "");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function boundedKey(prefix, body) {
  const key = `${prefix}:${body}`;
  if (new TextEncoder().encode(key).length <= MAX_KEY_BYTES) return key;
  return `${prefix}#${await sha256Hex(body)}`;
}

export function pageKey(url) {
  return boundedKey("p", hostKey(new URL(url).hostname) + pathKey(url));
}

export function redirectKey(url) {
  return boundedKey("r", hostKey(new URL(url).hostname) + pathKey(url));
}

/**
 * Whole files the edge can serve in place of the origin's: robots.txt and
 * sitemap files at the site root (sitemap.xml, sitemap-2.xml, post-sitemap.xml…).
 * Nothing else, so an override can never shadow a page.
 */
export function isFilePath(pathname) {
  return pathname === "/robots.txt" || /^\/[A-Za-z0-9_-]*sitemap[A-Za-z0-9_-]*\.xml$/i.test(pathname);
}

/** A file override's key: host and path only, since crawlers request these files without a query. */
export function fileKey(url) {
  const u = new URL(url);
  return boundedKey("f", hostKey(u.hostname) + normalizeEscapes(u.pathname || "/"));
}

/** An image's identity: host and path (scheme-less), with its query. */
export function imageKey(src, pageUrl) {
  const u = new URL(src, pageUrl);
  return `//${u.hostname.toLowerCase()}${normalizeEscapes(u.pathname)}${u.search}`;
}

/** The same image at any WordPress size: no query, no -300x200 / -scaled before the extension. */
export function imageStem(key) {
  return key.replace(/\?.*$/, "").replace(/-(?:\d+x\d+|scaled)(\.[A-Za-z0-9]+)$/, "$1");
}
