/**
 * SEO Table edge worker (Cloudflare Workers, ES module syntax).
 *
 * Applies approved SEO fixes at Cloudflare's edge, so nothing is installed on
 * the site itself. The panel writes rules into the KV namespace bound as
 * RULES; this script reads them and rewrites responses on the way out:
 *
 *   r:<host><path?query>   redirect rule  {to, status, external?}
 *   p:<host><path?query>   page rule      {title, description, canonical, robots,
 *                                          alts: {<image key>: alt}, jsonld: [..], hreflang: [{lang, href}]}
 *   m                      manifest       {v: 1, keys: [every r:/p: key that exists]}
 *   cfg:bypass             shared secret; a request carrying it in
 *                          x-seo-table-bypass gets the origin response untouched,
 *                          which is how the panel reads the site's own values.
 *
 * The manifest exists so a page without rules costs no KV read: the worker
 * reads one small document per isolate every RULE_TTL_MS instead of one lookup
 * per page view (KV reads are billed and the free plan allows 100k a day).
 *
 * Safety, in order of precedence:
 *   - Anything but GET/HEAD passes through untouched (forms, carts, APIs).
 *   - WordPress admin, login, REST and cron paths, and Cloudflare's own
 *     /cdn-cgi, pass through untouched.
 *   - Logged-in WordPress sessions (a wordpress_logged_in_ / wp-postpass_
 *     cookie on the request, or one being set by the response) pass through
 *     untouched: editors must see what their CMS really renders, and a
 *     response that establishes a session is never rewritten. Other cookies
 *     (analytics, carts) do not stop the rewrite, and Set-Cookie headers on a
 *     rewritten response are forwarded as they are.
 *   - Fail open: any error returns the origin response as it came, and
 *     passThroughOnException() covers anything thrown outside our try blocks.
 *
 * The rule keys come from keys.js, uploaded beside this module and imported
 * by the connector under Node. This module exports nothing but its handler:
 * workerd treats every named export of the main module as an entrypoint.
 */

import {
  BYPASS_HEADER,
  BYPASS_KEY,
  EDGE_HEADER,
  MANIFEST_KEY,
  hostKey,
  imageKey,
  imageStem,
  pageKey,
  pathKey,
  redirectKey,
} from "./keys.js";

/** How long an isolate trusts a rule it has read, in ms. */
const RULE_TTL_MS = 30_000;
/** How long each Cloudflare location caches a KV read, in seconds. */
const KV_CACHE_TTL = 60;

const EXCLUDED_PATHS = ["/wp-admin", "/wp-login.php", "/wp-json", "/wp-cron.php", "/xmlrpc.php", "/cdn-cgi"];
const SESSION_COOKIE = /(?:^|;\s*)(?:wordpress_logged_in_|wordpress_sec_|wp-postpass_)/i;
const SESSION_SET_COOKIE = /(?:^|[\s,])(?:wordpress_logged_in_|wordpress_sec_|wp-postpass_)/i;
const REDIRECT_STATUSES = [301, 302, 307, 308];

// ---------------------------------------------------------------- rules

const cache = new Map();

async function cached(env, key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < RULE_TTL_MS) return hit.value;
  const value = await env.RULES.get(key, { type: key === BYPASS_KEY ? "text" : "json", cacheTtl: KV_CACHE_TTL });
  cache.set(key, { value, at: Date.now() });
  return value;
}

let manifestDoc = null;
let manifestKeys = new Set();

async function manifest(env) {
  const doc = await cached(env, MANIFEST_KEY);
  // The Set is rebuilt only when a fresh document was read, not per request.
  if (doc !== manifestDoc) {
    manifestDoc = doc;
    manifestKeys = new Set(doc && Array.isArray(doc.keys) ? doc.keys : []);
  }
  return manifestKeys;
}

// ---------------------------------------------------------------- request handling

function excludedPath(url) {
  const path = url.pathname.toLowerCase();
  if (url.searchParams.has("rest_route")) return true;
  return EXCLUDED_PATHS.some((p) => path === p || path.startsWith(`${p}/`) || (p.endsWith(".php") && path.startsWith(p)));
}

function withoutBypassHeader(request) {
  if (!request.headers.has(BYPASS_HEADER)) return request;
  const copy = new Request(request);
  copy.headers.delete(BYPASS_HEADER);
  return copy;
}

function tagged(response, value) {
  const out = new Response(response.body, response);
  out.headers.set(EDGE_HEADER, value);
  return out;
}

function redirectResponse(rule, request) {
  if (!rule || typeof rule.to !== "string") return null;
  let target;
  try {
    target = new URL(rule.to, request.url);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return null;
  const here = new URL(request.url);
  // Off-site only when the rule was written as such; a rule never sends a visitor
  // to itself (a stale rule after the page moved would otherwise loop).
  if (!rule.external && hostKey(target.hostname) !== hostKey(here.hostname)) return null;
  if (hostKey(target.hostname) === hostKey(here.hostname) && pathKey(target.href) === pathKey(here.href)) return null;
  // Campaign parameters survive the hop unless the rule names its own query.
  if (!target.search && here.search) target.search = here.search;
  const status = REDIRECT_STATUSES.includes(rule.status) ? rule.status : 301;
  return new Response(null, {
    status,
    headers: {
      location: target.href,
      // Bounded, so undoing a redirect in the panel reaches browsers that saw it.
      "cache-control": "public, max-age=3600",
      [EDGE_HEADER]: "1",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    ctx.passThroughOnException();
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return fetch(request);

    const url = new URL(request.url);
    if (excludedPath(url)) return fetch(withoutBypassHeader(request));
    if (SESSION_COOKIE.test(request.headers.get("cookie") ?? "")) return fetch(withoutBypassHeader(request));

    const forward = withoutBypassHeader(request);
    let origin = null;
    try {
      const presented = request.headers.get(BYPASS_HEADER);
      if (presented) {
        const secret = await cached(env, BYPASS_KEY);
        if (secret && presented === secret) return tagged(await fetch(forward), "bypass");
      }

      const keys = await manifest(env);
      const rKey = await redirectKey(url.href);
      if (keys.has(rKey)) {
        const redirect = redirectResponse(await cached(env, rKey), request);
        if (redirect) return redirect;
      }

      const pKey = await pageKey(url.href);
      const rule = keys.has(pKey) ? await cached(env, pKey) : null;

      origin = await fetch(forward);
      const type = origin.headers.get("content-type") ?? "";
      if (!rule || origin.status !== 200 || !/^text\/html\b/i.test(type)) return tagged(origin, "1");
      if (SESSION_SET_COOKIE.test(origin.headers.get("set-cookie") ?? "")) return origin;

      const out = new Response(origin.body, origin);
      out.headers.set(EDGE_HEADER, "1");
      // The body changes, so the origin's validators no longer describe it.
      out.headers.delete("etag");
      out.headers.delete("content-md5");
      if (typeof rule.robots === "string") out.headers.set("x-robots-tag", rule.robots);
      if (method === "HEAD") return out;
      return rewriter(rule, url.href).transform(out);
    } catch (err) {
      console.error("seo-table-edge: passing through after error", err && err.message);
      return origin ?? fetch(forward);
    }
  },
};

// ---------------------------------------------------------------- HTML rewriting

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON-LD inside <script>: `</script` or `<!--` in a string must not end the element. */
function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function parsedJsonLd(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    try {
      out.push(typeof item === "string" ? JSON.parse(item) : item);
    } catch {
      /* an unparsable block is skipped, never injected half-formed */
    }
  }
  return out;
}

/**
 * An element handler that never throws into the stream: a failure inside it
 * leaves that one element as the origin sent it.
 */
function safe(fn) {
  return {
    element(el) {
      try {
        fn(el);
      } catch (err) {
        console.error("seo-table-edge: element left untouched", err && err.message);
      }
    },
  };
}

function rewriter(rule, pageUrl) {
  const seen = { title: false, description: false, canonical: false, robots: false };
  const alts = rule.alts && typeof rule.alts === "object" ? rule.alts : null;
  let stems = null;
  const altFor = (src) => {
    if (!alts || !src) return undefined;
    let key;
    try {
      key = imageKey(src, pageUrl);
    } catch {
      return undefined;
    }
    if (typeof alts[key] === "string") return alts[key];
    if (!stems) {
      // A stem shared by two rules with different alts is ambiguous and matches nothing.
      stems = new Map();
      for (const [k, v] of Object.entries(alts)) {
        const stem = imageStem(k);
        stems.set(stem, stems.has(stem) && stems.get(stem) !== v ? null : v);
      }
    }
    const hit = stems.get(imageStem(key));
    return typeof hit === "string" ? hit : undefined;
  };
  const hreflang = Array.isArray(rule.hreflang)
    ? rule.hreflang.filter((h) => h && typeof h.lang === "string" && typeof h.href === "string")
    : null;
  const jsonld = parsedJsonLd(rule.jsonld);

  let rw = new HTMLRewriter();

  if (typeof rule.title === "string") {
    rw = rw.on(
      "head > title",
      safe((el) => {
        if (seen.title) return el.remove();
        seen.title = true;
        el.setInnerContent(rule.title);
      }),
    );
  }
  if (typeof rule.description === "string") {
    rw = rw.on(
      'meta[name="description" i]',
      safe((el) => {
        seen.description = true;
        el.setAttribute("content", rule.description);
      }),
    );
  }
  if (typeof rule.canonical === "string") {
    rw = rw.on(
      'link[rel~="canonical" i]',
      safe((el) => {
        if (seen.canonical) return el.remove();
        seen.canonical = true;
        el.setAttribute("href", rule.canonical);
      }),
    );
  }
  if (typeof rule.robots === "string") {
    rw = rw
      .on(
        'meta[name="robots" i]',
        safe((el) => {
          if (seen.robots) return el.remove();
          seen.robots = true;
          el.setAttribute("content", rule.robots);
        }),
      )
      // Googlebot obeys its own meta as well as the generic one, so a leftover
      // googlebot noindex would silently defeat the fix.
      .on('meta[name="googlebot" i]', safe((el) => el.remove()));
  }
  if (alts) {
    rw = rw.on(
      "img",
      safe((el) => {
        const alt = altFor(el.getAttribute("src") ?? el.getAttribute("data-src") ?? el.getAttribute("data-lazy-src"));
        if (alt !== undefined) el.setAttribute("alt", alt);
      }),
    );
  }
  if (hreflang) {
    rw = rw.on(
      'link[rel~="alternate" i][hreflang]',
      safe((el) => el.remove()),
    );
  }

  // Whatever the page lacks is added just before </head>.
  rw = rw.on("head", {
    element(el) {
      el.onEndTag((end) => {
        try {
          const add = [];
          if (typeof rule.title === "string" && !seen.title) add.push(`<title>${escapeHtml(rule.title)}</title>`);
          if (typeof rule.description === "string" && !seen.description) {
            add.push(`<meta name="description" content="${escapeHtml(rule.description)}">`);
          }
          if (typeof rule.canonical === "string" && !seen.canonical) {
            add.push(`<link rel="canonical" href="${escapeHtml(rule.canonical)}">`);
          }
          if (typeof rule.robots === "string" && !seen.robots) add.push(`<meta name="robots" content="${escapeHtml(rule.robots)}">`);
          for (const h of hreflang ?? []) {
            add.push(`<link rel="alternate" hreflang="${escapeHtml(h.lang)}" href="${escapeHtml(h.href)}">`);
          }
          for (const block of jsonld) add.push(`<script type="application/ld+json">${scriptSafeJson(block)}</script>`);
          if (add.length) end.before(add.join(""), { html: true });
        } catch (err) {
          console.error("seo-table-edge: nothing added to head", err && err.message);
        }
      });
    },
  });
  return rw;
}
