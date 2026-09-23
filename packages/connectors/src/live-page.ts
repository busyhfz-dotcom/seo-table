/**
 * Reading a field off the live page, the way a crawler sees it.
 *
 * Used where the value a fix replaces is only observable in the rendered HTML:
 * the site's own value behind a Cloudflare edge rule, and SEO plugin fields
 * whose stored form is a template (Rank Math, SEOPress, AIOSEO). Reading the
 * rendered page keeps drift detection honest — it compares like with like,
 * because the scan also saw the rendered page.
 *
 * Every read adds a random cache-busting parameter and `Cache-Control:
 * no-cache`: page caches (WP Rocket, LiteSpeed, a CDN) would otherwise answer
 * with the copy from before a write, and a stale read would make a rollback
 * think it had nothing to undo.
 */
import { randomBytes } from "node:crypto";
import * as cheerio from "cheerio";
import { BlockedAddressError, env, extract, guardedFetch } from "@seo/core";
import { CACHE_BUSTER, imageKey } from "./edge/keys.js";
import { ConnectorError } from "./types.js";

export type LivePage = { html: string; headers: Headers; url: string };

/** Fields a live page can answer for. */
export const LIVE_FIELDS = ["title", "meta_description", "canonical", "meta_robots", "img.alt"] as const;

export async function fetchLivePage(url: string, extraHeaders: Record<string, string> = {}): Promise<LivePage> {
  const busted = new URL(url);
  busted.searchParams.set(CACHE_BUSTER, randomBytes(6).toString("hex"));
  let res;
  try {
    res = await guardedFetch(busted.toString(), {
      headers: {
        "user-agent": env().CRAWLER_USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "cache-control": "no-cache",
        pragma: "no-cache",
        ...extraHeaders,
      },
      timeoutMs: 20_000,
    });
  } catch (err) {
    if (err instanceof BlockedAddressError) throw new ConnectorError("blocked_address", err.message);
    throw new ConnectorError("page_unreachable", `Could not load ${url}: ${(err as Error).message}`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ConnectorError("page_redirects", `${url} now redirects (HTTP ${res.status}); its value cannot be read.`, {
      status: res.status,
    });
  }
  if (res.status !== 200) {
    throw new ConnectorError("page_unavailable", `${url} answered HTTP ${res.status}; its value cannot be read.`, {
      status: res.status,
    });
  }
  if (res.truncated) throw new ConnectorError("response_too_large", `${url} is too large to read.`);
  return { html: res.body.toString("utf8"), headers: res.headers, url };
}

/**
 * The value of one field on a fetched page, in the form the crawler stores it
 * (collapsed whitespace, a normalised canonical, robots and googlebot joined).
 * null when the page genuinely has no value; throws when it cannot say.
 */
export function liveField(page: LivePage, field: string, selector?: string): string | null {
  if (field === "img.alt") {
    if (!selector) throw new ConnectorError("missing_selector", "An alt-text change must name the image.");
    return imageAlt(page, selector);
  }
  const x = extract(page.html, page.url);
  switch (field) {
    case "title":
      return x.title;
    case "meta_description":
      return x.metaDescription;
    case "canonical":
      return x.canonical;
    case "meta_robots":
      return x.robotsMeta ?? (page.headers.get("x-robots-tag")?.trim() || null);
    default:
      throw new ConnectorError("unsupported_field", `"${field}" cannot be read from the page.`);
  }
}

/**
 * The alt of the image whose address is `src` on this page. The same image
 * shown twice with different alts is ambiguous, and an image that is not on
 * the page cannot be judged at all — both refuse rather than guess.
 */
function imageAlt(page: LivePage, src: string): string | null {
  const $ = cheerio.load(page.html);
  const wanted = imageKey(src, page.url);
  const alts: Array<string | null> = [];
  $("img").each((_, el) => {
    const $el = $(el);
    const own = $el.attr("src") ?? $el.attr("data-src") ?? $el.attr("data-lazy-src");
    if (!own) return;
    try {
      if (imageKey(own, page.url) !== wanted) return;
    } catch {
      return;
    }
    alts.push($el.attr("alt") ?? null);
  });
  if (alts.length === 0) throw new ConnectorError("image_not_found", `The image ${src} is not on ${page.url} any more.`);
  if (new Set(alts).size > 1) {
    throw new ConnectorError("image_ambiguous", `The image ${src} appears on ${page.url} with different alt texts.`);
  }
  return alts[0] ?? null;
}
