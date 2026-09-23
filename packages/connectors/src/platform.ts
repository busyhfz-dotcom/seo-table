/**
 * What a site runs on: CMS (and its version), SEO plugin, CDN and server —
 * read from the home page's headers and HTML, plus WordPress's public REST
 * index when the site is WordPress. It decides which connection methods the
 * panel recommends, so every signal here is one a site actually emits; when
 * none matches, the answer is "custom", never a guess.
 *
 * Everything goes through the SSRF-guarded fetch, one hop at a time.
 */
import { BlockedAddressError, NotFound, env, guardedFetch } from "@seo/core";
import { db, eq, projects, type PlatformInfo } from "@seo/db";
import { SEO_PLUGIN_NAMESPACES } from "./wp-seo-plugins.js";
import { ConnectorError } from "./types.js";

export type Platform = PlatformInfo;

const MAX_HOPS = 5;
/** REST namespaces worth remembering: they decide what a WordPress connection can write. */
const INTERESTING_NAMESPACES = ["wp/v2", "seo-table/v1", "redirection/v1", ...Object.values(SEO_PLUGIN_NAMESPACES)];
/** How long a stored detection is trusted before a scan refreshes it. */
export const PLATFORM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Page = { url: string; status: number; headers: Headers; html: string };

async function get(url: string, accept = "text/html,application/xhtml+xml"): Promise<Page> {
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res;
    try {
      res = await guardedFetch(current, {
        headers: { "user-agent": env().CRAWLER_USER_AGENT, accept },
        timeoutMs: 15_000,
        maxBytes: 2 * 1024 * 1024,
      });
    } catch (err) {
      if (err instanceof BlockedAddressError) throw new ConnectorError("blocked_address", err.message);
      throw new ConnectorError("site_unreachable", `Could not load ${current}: ${(err as Error).message}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return { url: current, status: res.status, headers: res.headers, html: res.body.toString("utf8") };
  }
  throw new ConnectorError("too_many_redirects", `${url} redirects more than ${MAX_HOPS} times`);
}

function generator(html: string): string | null {
  const m = /<meta[^>]+name=["']generator["'][^>]*>/i.exec(html);
  return m ? (/content=["']([^"']+)["']/i.exec(m[0])?.[1] ?? null) : null;
}

export function detectCdn(h: Headers): string | null {
  const server = (h.get("server") ?? "").toLowerCase();
  const via = (h.get("via") ?? "").toLowerCase();
  if (h.has("cf-ray") || server === "cloudflare") return "cloudflare";
  if (server.includes("arvancloud") || h.has("ar-poweredby") || h.has("ar-request-id")) return "arvancloud";
  if (h.has("x-fastly-request-id") || (via.includes("varnish") && h.has("x-served-by"))) return "fastly";
  if (h.has("x-amz-cf-id") || via.includes("cloudfront")) return "cloudfront";
  if (server.includes("akamaighost") || h.has("x-akamai-transformed")) return "akamai";
  if (h.has("x-vercel-id") || server === "vercel") return "vercel";
  if (h.has("x-nf-request-id") || server === "netlify") return "netlify";
  if (server.includes("bunnycdn") || h.has("cdn-pullzone")) return "bunnycdn";
  if (h.has("x-sucuri-id")) return "sucuri";
  return null;
}

type Cms = PlatformInfo["cms"];

export function detectCms(html: string, h: Headers): { cms: Cms; version: string | null } {
  const gen = generator(html) ?? "";
  const poweredBy = (h.get("x-powered-by") ?? "").toLowerCase();
  const link = h.get("link") ?? "";
  const version = (re: RegExp) => re.exec(gen)?.[1] ?? null;

  if (/wordpress/i.test(gen) || link.includes("https://api.w.org/") || /\/wp-(?:content|includes)\//.test(html)) {
    return { cms: "wordpress", version: version(/WordPress\s+([\d.]+)/i) };
  }
  if (h.has("x-shopid") || h.has("x-shopify-stage") || /cdn\.shopify\.com|Shopify\.theme/.test(html)) return { cms: "shopify", version: null };
  if (h.has("x-wix-request-id") || /static\.wixstatic\.com|Wix\.com Website Builder/i.test(html + gen)) return { cms: "wix", version: null };
  if (/squarespace/i.test(gen) || /static1\.squarespace\.com|<!-- This is Squarespace\. -->/.test(html)) return { cms: "squarespace", version: null };
  if (/webflow/i.test(gen) || /data-wf-(?:site|page)=/.test(html)) return { cms: "webflow", version: null };
  if (/joomla/i.test(gen) || /\/media\/(?:jui|system)\/js\//.test(html)) return { cms: "joomla", version: version(/Joomla!?\s*([\d.]+)/i) };
  if (/drupal/i.test(gen) || /drupal/i.test(h.get("x-generator") ?? "") || h.has("x-drupal-cache") || /\/sites\/default\/files\//.test(html)) {
    return { cms: "drupal", version: version(/Drupal\s+([\d.]+)/i) ?? (/Drupal\s+([\d.]+)/i.exec(h.get("x-generator") ?? "")?.[1] ?? null) };
  }
  if (h.has("x-magento-cache-debug") || h.has("x-magento-tags") || /Magento_|text\/x-magento-init|mage\/cookies/.test(html)) return { cms: "magento", version: null };
  if (poweredBy.includes("next.js") || /__NEXT_DATA__|\/_next\/static\//.test(html)) return { cms: "nextjs", version: null };
  if (/__NUXT__|\/_nuxt\//.test(html)) return { cms: "nuxt", version: null };
  return { cms: "custom", version: null };
}

export function detectSeoPlugin(html: string, namespaces: string[]): PlatformInfo["seoPlugin"] {
  // The plugins' own HTML comments are the most direct evidence; REST namespaces
  // catch sites that strip comments.
  if (/Search Engine Optimization by Rank Math|rank-math/i.test(html) || namespaces.includes("rankmath/v1")) return "rankmath";
  if (/This site is optimized with the Yoast SEO/i.test(html) || namespaces.includes("yoast/v1")) return "yoast";
  if (/All in One SEO/i.test(html) || namespaces.includes("aioseo/v1")) return "aioseo";
  if (/SEOPress/i.test(html) || namespaces.includes("seopress/v1")) return "seopress";
  return null;
}

export async function detectPlatform(url: string): Promise<Platform> {
  const home = await get(url);
  const { cms, version: declared } = detectCms(home.html, home.headers);
  let version = declared;

  let wpNamespaces: string[] | undefined;
  if (cms === "wordpress") {
    const root = await get(new URL("/wp-json/", home.url).toString(), "application/json").catch(() => null);
    if (root && root.status === 200) {
      try {
        const data = JSON.parse(root.html) as { namespaces?: unknown };
        if (Array.isArray(data.namespaces)) {
          wpNamespaces = data.namespaces.filter((n): n is string => typeof n === "string" && INTERESTING_NAMESPACES.includes(n));
        }
      } catch {
        /* a REST index that is not JSON tells us nothing */
      }
    }
    if (!version) {
      // The feed carries the version when the generator meta was removed.
      const feed = await get(new URL("/feed/", home.url).toString(), "application/rss+xml").catch(() => null);
      version = (feed && /<generator>https?:\/\/wordpress\.org\/\?v=([\d.]+)<\/generator>/.exec(feed.html)?.[1]) ?? null;
    }
  }

  return {
    cms,
    cmsVersion: version,
    seoPlugin: detectSeoPlugin(home.html, wpNamespaces ?? []),
    cdn: detectCdn(home.headers),
    server: home.headers.get("server"),
    ...(wpNamespaces ? { wpNamespaces } : {}),
    detectedAt: new Date().toISOString(),
  };
}

/** Detect and store. Returns the stored result. */
export async function refreshPlatform(projectId: string): Promise<Platform> {
  const project = (await db.select({ baseUrl: projects.baseUrl }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) throw new NotFound("Project not found");
  const platform = await detectPlatform(project.baseUrl);
  await db.update(projects).set({ platform }).where(eq(projects.id, projectId));
  return platform;
}
