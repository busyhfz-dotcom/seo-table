/**
 * A small, polite sample of a site's pages: the homepage plus pages listed in
 * its sitemap, up to a cap. Used for competitors, whose sites we do not own and
 * must not crawl like our own.
 *
 * Same rules as the crawler, from the same helpers: robots.txt honoured (an
 * unreachable robots.txt means "fetch nothing", RFC 9309), Crawl-delay
 * respected, one request per second per host across all workers, every hop
 * through the SSRF guard, byte caps and timeouts, no following off the site.
 */
import * as cheerio from "cheerio";
import {
  absoluteUrl,
  assertPublicUrl,
  crawlDelayFor,
  decodeSitemapBody,
  env,
  extract,
  guardedFetch,
  hostGate,
  isAllowed,
  isProbablyAsset,
  normalizeUrl,
  parseRobots,
  parseSitemap,
  registrableHost,
  type GuardedResponse,
  type Robots,
} from "@seo/core";
import type { HeadingSummary } from "@seo/db";

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_SITEMAP_BYTES = 20 * 1024 * 1024;
const MAX_SITEMAP_FILES = 5;
const MAX_REDIRECTS = 5;

export type SampledPage = {
  url: string;
  statusCode: number;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  headings: HeadingSummary | null;
  wordCount: number;
  schemaTypes: string[];
  internalLinks: number;
  externalLinks: number;
};

export type SampleResult = { pages: SampledPage[]; robots: "ok" | "missing" | "unreachable"; sitemapUrls: number };

function headingSummary(html: string): HeadingSummary {
  const $ = cheerio.load(html);
  const count = (tag: string) => $(tag).length;
  const h2: string[] = [];
  $("h2").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && h2.length < 20) h2.push(text.slice(0, 200));
  });
  return {
    counts: { h1: count("h1"), h2: count("h2"), h3: count("h3"), h4: count("h4"), h5: count("h5"), h6: count("h6") },
    h2,
  };
}

export async function samplePages(
  baseUrl: string,
  opts: { cap?: number; requestsPerSecond?: number; signal?: AbortSignal } = {},
): Promise<SampleResult> {
  const cap = Math.min(Math.max(opts.cap ?? 30, 1), 30);
  const userAgent = env().CRAWLER_USER_AGENT;
  const start = new URL(baseUrl);
  await assertPublicUrl(start.toString());
  const host = start.hostname;
  const site = registrableHost(host);
  const headers = { "user-agent": userAgent, "accept-language": "fa,en;q=0.8" };
  let delayMs = 0;

  const polite = async () => {
    opts.signal?.throwIfAborted();
    await hostGate(host, opts.requestsPerSecond ?? 1, opts.signal);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  };

  /** Follow redirects hop by hop, each through the guard, never leaving the site. */
  const fetchFollowing = async (url: string, maxBytes: number, accept: string): Promise<GuardedResponse & { finalUrl: string }> => {
    let current = url;
    for (let hop = 0; ; hop++) {
      await polite();
      const res = await guardedFetch(current, { headers: { ...headers, accept }, maxBytes, timeoutMs: env().CRAWLER_TIMEOUT_MS, signal: opts.signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
        const next = absoluteUrl(location, current);
        if (!next || registrableHost(new URL(next).hostname) !== site) return { ...res, finalUrl: current };
        current = next;
        continue;
      }
      return { ...res, finalUrl: current };
    }
  };

  // ---- robots.txt
  let robots: Robots;
  let robotsState: SampleResult["robots"] = "ok";
  try {
    const res = await fetchFollowing(new URL("/robots.txt", start).toString(), 512 * 1024, "text/plain");
    if (res.status >= 200 && res.status < 300) robots = parseRobots(res.body.toString("utf8"));
    else if (res.status < 500 && res.status !== 429) {
      robots = parseRobots("", "missing");
      robotsState = "missing";
    } else {
      robots = parseRobots("", "unreachable");
      robotsState = "unreachable";
    }
  } catch {
    robots = parseRobots("", "unreachable");
    robotsState = "unreachable";
  }
  if (robotsState === "unreachable") return { pages: [], robots: robotsState, sitemapUrls: 0 };
  const crawlDelay = crawlDelayFor(robots, userAgent);
  if (crawlDelay) delayMs = Math.min(crawlDelay, 10) * 1000;

  // ---- sitemap(s)
  const found: string[] = [];
  const queue = (robots.sitemaps.length ? robots.sitemaps : ["/sitemap.xml"])
    .map((s) => absoluteUrl(s, start.toString()))
    .filter((s): s is string => s !== null);
  let files = 0;
  while (queue.length && files < MAX_SITEMAP_FILES && found.length < cap * 3) {
    const sm = queue.shift()!;
    files++;
    try {
      const res = await fetchFollowing(sm, MAX_SITEMAP_BYTES, "application/xml,text/xml");
      if (res.status < 200 || res.status >= 300) continue;
      const parsed = parseSitemap(decodeSitemapBody(res.body, MAX_SITEMAP_BYTES));
      for (const u of parsed.urls) found.push(u);
      for (const child of parsed.sitemaps) {
        const abs = absoluteUrl(child, sm);
        if (abs) queue.push(abs);
      }
    } catch {
      /* no sitemap: the homepage alone is still a sample */
    }
  }

  // ---- the sample: homepage first, then sitemap pages on this site that robots allows
  const urls: string[] = [start.toString()];
  const seen = new Set([normalizeUrl(start.toString()) ?? start.toString()]);
  for (const u of found) {
    if (urls.length >= cap) break;
    const key = normalizeUrl(u);
    if (!key || seen.has(key) || isProbablyAsset(key)) continue;
    try {
      if (registrableHost(new URL(key).hostname) !== site) continue;
    } catch {
      continue;
    }
    if (!isAllowed(robots, key, userAgent)) continue;
    seen.add(key);
    urls.push(u);
  }

  const pages: SampledPage[] = [];
  for (const url of urls) {
    if (!isAllowed(robots, url, userAgent)) continue;
    try {
      const res = await fetchFollowing(url, MAX_HTML_BYTES, "text/html,application/xhtml+xml");
      const isHtml = /html/i.test(res.headers.get("content-type") ?? "text/html");
      if (res.status !== 200 || !isHtml) {
        pages.push(emptyPage(url, res.status));
        continue;
      }
      const html = res.body.toString("utf8");
      const x = extract(html, res.finalUrl);
      pages.push({
        url,
        statusCode: res.status,
        title: x.title,
        metaDescription: x.metaDescription,
        h1: x.h1s,
        headings: headingSummary(html),
        wordCount: x.wordCount,
        schemaTypes: x.structuredDataTypes,
        internalLinks: x.internalLinksOut,
        externalLinks: x.externalLinksOut,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      pages.push(emptyPage(url, 0));
    }
  }
  return { pages, robots: robotsState, sitemapUrls: found.length };
}

function emptyPage(url: string, statusCode: number): SampledPage {
  return {
    url,
    statusCode,
    title: null,
    metaDescription: null,
    h1: [],
    headings: null,
    wordCount: 0,
    schemaTypes: [],
    internalLinks: 0,
    externalLinks: 0,
  };
}
