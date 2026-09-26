/**
 * Breadth-first crawler.
 *
 * Deliberate limits, because a crawler is something you point at someone else's
 * server: every request goes through guardedFetch (public addresses only, byte
 * caps, timeouts), robots.txt is honoured, one shared scheduler spaces requests
 * so the per-host rate holds whatever the concurrency, redirects are recorded
 * rather than chased blindly, and the page cap is enforced before enqueueing
 * rather than after fetching.
 */
import { env } from "./env.js";
import { extract, indexability, type Extracted } from "./extract.js";
import { assertPublicUrl, guardedFetch, type GuardedResponse } from "./net.js";
import {
  crawlDelayFor,
  decodeSitemapBody,
  isAllowed,
  parseRobots,
  parseSitemap,
  type Robots,
} from "./robots.js";
import { absoluteUrl, isProbablyAsset, normalizeUrl, registrableHost } from "./url.js";
import { childLogger, metric } from "./logger.js";

export type CrawledPage = {
  /** The URL that was requested, as discovered. */
  url: string;
  normalizedUrl: string;
  /**
   * Clicks from the start page along followable links (a redirect hop is not a
   * click). Null when the page was reached only through the sitemap or a
   * canonical, so its click depth is unknown.
   */
  depth: number | null;
  statusCode: number;
  responseMs: number;
  bodyBytes: number;
  /** The Content-Type header as sent, or null when absent. */
  contentType: string | null;
  /** The body hit the byte cap and was cut; the page was parsed from what arrived. */
  bodyTruncated: boolean;
  xRobotsTag: string | null;
  /** For a 3xx: the URL the Location header points at, normalised. */
  redirectTarget: string | null;
  /** The Last-Modified header as an ISO timestamp, when present and parseable (sitemap lastmod). */
  lastModified?: string | null;
  extracted: Extracted | null;
  indexable: boolean;
  noindexReason: string | null;
  inSitemap: boolean;
  error?: string;
};

export type CrawlResult = {
  pages: CrawledPage[];
  /**
   * Distinct internal pages linking to each URL, resolved after the whole crawl.
   * Self-links do not count, and links to a URL that redirects also count for
   * the page the redirect ends on.
   */
  inboundLinks: Map<string, number>;
  robots: Robots;
  sitemapUrls: Set<string>;
  skipped: { robotsDisallowed: number; assets: number; offSite: number; capped: number };
  stats: { fetched: number; failed: number; durationMs: number };
};

export type CrawlOptions = {
  baseUrl: string;
  pageCap: number;
  requestsPerSecond: number;
  maxDepth?: number;
  userAgent?: string;
  timeoutMs?: number;
  concurrency?: number;
  /** Called as pages complete, so the run row can show live progress. */
  onProgress?: (done: number, queued: number) => void | Promise<void>;
  signal?: AbortSignal;
};

const MiB = 1024 * 1024;
const MAX_HTML_BYTES = 5 * MiB;
/** RFC 9309 §2.5: at least 500 KiB must be parsed. */
const MAX_ROBOTS_BYTES = 500 * 1024;
/** The sitemap protocol's own limit for one (uncompressed) file. */
const MAX_SITEMAP_BYTES = 50 * MiB;
const MAX_SITEMAP_FETCHES = 50;
const MAX_SITEMAP_NESTING = 3;
/** Hops followed for robots.txt and sitemaps (RFC 9309 §2.3.1.2 asks for at least five). */
const MAX_FETCH_REDIRECTS = 5;
/** Canonical targets outside the crawl that are fetched so a canonical is judged on evidence. */
const MAX_CANONICAL_CHECKS = 200;

const isRedirect = (status: number) => status >= 300 && status < 400;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * One request slot at a time for the whole crawl. Slots are reserved
 * synchronously, so concurrent workers queue behind each other instead of all
 * seeing the same "last request" time and firing together.
 */
function createPacer(requestsPerSecond: number, signal?: AbortSignal) {
  let intervalMs = 1000 / Math.max(requestsPerSecond, 0.01);
  let nextSlot = 0;
  return {
    /** effective rate = min(requested rate, 1 / Crawl-delay). */
    applyCrawlDelay(seconds: number | null) {
      if (seconds && seconds > 0) intervalMs = Math.max(intervalMs, seconds * 1000);
    },
    async wait() {
      const now = Date.now();
      const at = Math.max(now, nextSlot);
      nextSlot = at + intervalMs;
      if (at > now) await sleep(at - now, signal);
    },
  };
}

type Pacer = ReturnType<typeof createPacer>;

/**
 * Decode with the charset precedence browsers use: a byte-order mark, then the
 * Content-Type charset, then a <meta> declaration in the first 1024 bytes, then UTF-8.
 */
export function decodeHtml(body: Buffer, contentType: string | null): string {
  let label: string | null = null;
  let start = 0;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    label = "utf-8";
    start = 3;
  } else if (body[0] === 0xfe && body[1] === 0xff) {
    label = "utf-16be";
    start = 2;
  } else if (body[0] === 0xff && body[1] === 0xfe) {
    label = "utf-16le";
    start = 2;
  }
  label ??= /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(contentType ?? "")?.[1] ?? null;
  label ??= /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(body.subarray(0, 1024).toString("latin1"))?.[1] ?? null;
  // A <meta> claiming UTF-16 cannot be true of bytes that were readable as ASCII.
  if (!label || (/^utf-?16/i.test(label) && start === 0)) label = "utf-8";
  try {
    return new TextDecoder(label).decode(body.subarray(start));
  } catch {
    return new TextDecoder("utf-8").decode(body.subarray(start));
  }
}

function isHtmlType(contentType: string | null): boolean {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  // No Content-Type at all is common on small sites; browsers sniff it as HTML.
  return mime === "" || mime === "text/html" || mime === "application/xhtml+xml";
}

/** GET that follows redirects itself, so every hop passes the address check again. */
async function fetchFollowing(
  url: string,
  init: Parameters<typeof guardedFetch>[1],
  pacer: Pacer,
): Promise<GuardedResponse> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await pacer.wait();
    const res = await guardedFetch(current, init);
    const location = res.headers.get("location");
    if (!isRedirect(res.status) || !location || hop >= MAX_FETCH_REDIRECTS) return res;
    const next = absoluteUrl(location, current);
    if (!next) return res;
    current = next;
  }
}

async function fetchRobots(
  origin: string,
  headers: Record<string, string>,
  timeoutMs: number,
  pacer: Pacer,
  signal?: AbortSignal,
): Promise<Robots> {
  const url = new URL("/robots.txt", origin).toString();
  // One retry: a single 503 should not stop a whole audit.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFollowing(url, { headers, timeoutMs, maxBytes: MAX_ROBOTS_BYTES, signal }, pacer);
      if (res.status >= 200 && res.status < 300) return parseRobots(res.body.toString("utf8"));
      // 4xx — and redirects past the hop limit — mean "no robots.txt": crawl freely.
      // 429 asks us to back off; Google treats it like a 5xx, and so do we.
      if (res.status < 500 && res.status !== 429) return parseRobots("", "missing");
    } catch {
      /* unreachable: retried, then treated as a complete disallow */
    }
    if (signal?.aborted) break;
  }
  return parseRobots("", "unreachable");
}

type Item = { url: string; key: string; depth: number | null; extra: boolean };

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const cfg = env();
  const userAgent = options.userAgent ?? cfg.CRAWLER_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? cfg.CRAWLER_TIMEOUT_MS;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? cfg.CRAWLER_MAX_CONCURRENCY, 16));
  const maxDepth = options.maxDepth ?? 10;
  const signal = options.signal;
  const log = childLogger({ component: "crawler", baseUrl: options.baseUrl });
  const started = Date.now();

  const startUrl = absoluteUrl(options.baseUrl);
  const base = startUrl ? normalizeUrl(startUrl) : null;
  if (!startUrl || !base) throw new Error(`Invalid baseUrl: ${options.baseUrl}`);
  // A blocked start address is a configuration error for the whole run, not a finding.
  await assertPublicUrl(startUrl);
  const host = registrableHost(new URL(base).hostname);
  const onSite = (url: string) => {
    try {
      return registrableHost(new URL(url).hostname) === host;
    } catch {
      return false;
    }
  };

  const pacer = createPacer(options.requestsPerSecond, signal);
  const headers = { "user-agent": userAgent };

  // ---- robots.txt --------------------------------------------------------
  const robots = await fetchRobots(base, headers, timeoutMs, pacer, signal);
  pacer.applyCrawlDelay(crawlDelayFor(robots, userAgent));

  // ---- sitemaps ----------------------------------------------------------
  const sitemapUrls = new Set<string>();
  // With robots.txt unreachable nothing on the host may be fetched, sitemaps included.
  if (!robots.unreachable) {
    const sitemapQueue = (robots.sitemaps.length ? robots.sitemaps : ["/sitemap.xml"])
      .map((s) => absoluteUrl(s, base))
      .filter((s): s is string => s !== null)
      .map((url) => ({ url, nesting: 0 }));
    const seenSitemaps = new Set<string>();
    let sitemapFetches = 0;
    while (
      sitemapQueue.length &&
      sitemapFetches < MAX_SITEMAP_FETCHES &&
      sitemapUrls.size < options.pageCap * 2 &&
      !signal?.aborted
    ) {
      const sm = sitemapQueue.shift()!;
      const key = normalizeUrl(sm.url);
      if (!key || seenSitemaps.has(key)) continue;
      seenSitemaps.add(key);
      sitemapFetches++;
      try {
        const res = await fetchFollowing(
          sm.url,
          { headers, timeoutMs, maxBytes: MAX_SITEMAP_BYTES, signal },
          pacer,
        );
        if (res.status < 200 || res.status >= 300) continue;
        const parsed = parseSitemap(decodeSitemapBody(res.body, MAX_SITEMAP_BYTES));
        for (const u of parsed.urls) {
          const nu = normalizeUrl(u);
          if (nu) sitemapUrls.add(nu);
        }
        if (sm.nesting < MAX_SITEMAP_NESTING) {
          for (const child of parsed.sitemaps) {
            const abs = absoluteUrl(child, sm.url);
            if (abs) sitemapQueue.push({ url: abs, nesting: sm.nesting + 1 });
          }
        }
      } catch {
        /* a missing sitemap is a finding, not a crawl failure */
      }
    }
  }

  // ---- frontier ----------------------------------------------------------
  const skipped = { robotsDisallowed: 0, assets: 0, offSite: 0, capped: 0 };
  const cappedKeys = new Set<string>();
  const queued = new Set<string>();
  const frontier: Item[] = [];

  const enqueue = (url: string, key: string, depth: number | null, extra = false) => {
    if (queued.has(key)) return;
    if (!onSite(key)) {
      skipped.offSite++;
      return;
    }
    if (isProbablyAsset(key)) {
      skipped.assets++;
      return;
    }
    // Canonical checks are budgeted separately, so they may exceed the page cap.
    if (!extra && queued.size >= options.pageCap) {
      cappedKeys.add(key);
      return;
    }
    queued.add(key);
    cappedKeys.delete(key);
    frontier.push({ url, key, depth, extra });
  };

  enqueue(startUrl, base, 0);
  // Sitemap URLs are known to exist but not how far they are from home.
  for (const u of sitemapUrls) enqueue(u, u, null);

  const pages: CrawledPage[] = [];
  /** Followable links (and redirect hops) per page, for click depth after the crawl. */
  const edges = new Map<string, Array<{ to: string; weight: 0 | 1 }>>();
  let failed = 0;

  const fetchPage = async (item: Item): Promise<{ result: CrawledPage; redirectUrl: string | null }> => {
    let current = item.url;
    const visited = new Set([current]);
    let ms = 0;
    for (;;) {
      await pacer.wait();
      const t0 = Date.now();
      const res = await guardedFetch(current, {
        headers: {
          ...headers,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "fa,en;q=0.8",
        },
        timeoutMs,
        maxBytes: MAX_HTML_BYTES,
        signal,
      });
      ms += Date.now() - t0;
      const contentType = res.headers.get("content-type");
      const xRobots = res.headers.get("x-robots-tag");

      if (isRedirect(res.status)) {
        const location = res.headers.get("location");
        const targetUrl = location ? absoluteUrl(location, current) : null;
        const targetKey = targetUrl ? normalizeUrl(targetUrl) : null;
        // A redirect to a spelling this crawler already treats as the same URL
        // (escape case, a tracking parameter, parameter order) is followed here,
        // so it neither hides the page nor reads as a redirect to itself. A
        // redirect to the exact same URL is a real loop and is recorded as one.
        if (
          targetUrl &&
          targetKey === item.key &&
          !visited.has(targetUrl) &&
          visited.size <= MAX_FETCH_REDIRECTS
        ) {
          visited.add(targetUrl);
          current = targetUrl;
          continue;
        }
        const result = page(item, {
          statusCode: res.status,
          responseMs: ms,
          bodyBytes: res.body.length,
          contentType,
          bodyTruncated: res.truncated,
          xRobotsTag: xRobots,
          redirectTarget: targetKey,
          extracted: null,
        });
        return { result, redirectUrl: targetUrl };
      }

      const html = isHtmlType(contentType);
      const extracted = html && res.body.length ? extract(decodeHtml(res.body, contentType), current) : null;
      const lastModified = Date.parse(res.headers.get("last-modified") ?? "");
      const result = page(item, {
        statusCode: res.status,
        responseMs: ms,
        bodyBytes: res.body.length,
        contentType,
        bodyTruncated: res.truncated,
        xRobotsTag: xRobots,
        redirectTarget: null,
        extracted,
        isHtml: html,
        lastModified: Number.isFinite(lastModified) ? new Date(lastModified).toISOString() : null,
      });
      return { result, redirectUrl: null };
    }
  };

  const page = (
    item: Item,
    r: Omit<CrawledPage, "url" | "normalizedUrl" | "depth" | "indexable" | "noindexReason" | "inSitemap"> & {
      isHtml?: boolean;
    },
  ): CrawledPage => {
    const { isHtml, ...fields } = r;
    const idx = indexability({
      statusCode: r.statusCode,
      robotsMeta: r.extracted?.robotsMeta ?? null,
      xRobotsTag: r.xRobotsTag,
      allowedByRobotsTxt: isAllowed(robots, item.url, userAgent),
      canonical: r.extracted?.canonical ?? null,
      normalizedUrl: item.key,
      ...(isHtml === undefined ? {} : { isHtml }),
    });
    return {
      url: item.url,
      normalizedUrl: item.key,
      depth: item.depth,
      ...fields,
      indexable: idx.indexable,
      noindexReason: idx.reason,
      inSitemap: sitemapUrls.has(item.key),
    };
  };

  const processItem = async (item: Item) => {
    if (!isAllowed(robots, item.url, userAgent)) {
      skipped.robotsDisallowed++;
      return;
    }

    let result: CrawledPage;
    let redirectUrl: string | null = null;
    try {
      ({ result, redirectUrl } = await fetchPage(item));
    } catch (err) {
      failed++;
      result = {
        url: item.url,
        normalizedUrl: item.key,
        depth: item.depth,
        statusCode: 0,
        responseMs: 0,
        bodyBytes: 0,
        contentType: null,
        bodyTruncated: false,
        xRobotsTag: null,
        redirectTarget: null,
        extracted: null,
        indexable: false,
        noindexReason: "fetch_failed",
        inSitemap: sitemapUrls.has(item.key),
        error: (err as Error).message,
      };
    }
    pages.push(result);
    metric("crawler.page", 1, { status: String(result.statusCode) });

    const out: Array<{ to: string; weight: 0 | 1 }> = [];
    edges.set(item.key, out);

    // A redirect target is crawled like any other discovered URL, at the same depth.
    if (result.redirectTarget) {
      out.push({ to: result.redirectTarget, weight: 0 });
      if (!item.extra && redirectUrl) enqueue(redirectUrl, result.redirectTarget, item.depth);
    }

    const directives = `${result.extracted?.robotsMeta ?? ""},${result.xRobotsTag ?? ""}`;
    // Page-level nofollow (meta robots, googlebot or X-Robots-Tag) covers every link on it.
    if (result.extracted && !/\b(nofollow|none)\b/i.test(directives)) {
      const childDepth = item.depth === null ? null : item.depth + 1;
      for (const link of result.extracted.links) {
        if (!link.internal || link.nofollow || link.url === item.key) continue;
        out.push({ to: link.url, weight: 1 });
        if (item.extra) continue;
        if (childDepth !== null && childDepth > maxDepth) continue;
        enqueue(link.href, link.url, childDepth);
      }
    }

    await options.onProgress?.(pages.length, frontier.length);
  };

  const drain = async () => {
    let active = 0;
    const waiting: Array<() => void> = [];
    const wakeAll = () => {
      for (const w of waiting.splice(0)) w();
    };
    signal?.addEventListener("abort", wakeAll, { once: true });
    // A worker leaves only when nothing is queued AND nothing is in flight: an
    // in-flight page may still add links, so an empty frontier alone is not the end.
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) return;
        const item = frontier.shift();
        if (!item) {
          if (active === 0) return;
          await new Promise<void>((resolve) => waiting.push(resolve));
          continue;
        }
        active++;
        try {
          await processItem(item);
        } finally {
          active--;
          wakeAll();
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    signal?.removeEventListener("abort", wakeAll);
  };

  await drain();

  // ---- canonical targets outside the crawl ------------------------------
  // A canonical pointing at a page the crawl never reached (page cap, depth,
  // an unlinked URL) is checked directly instead of being assumed broken.
  const crawledKeys = new Set(pages.map((p) => p.normalizedUrl));
  let canonicalChecks = 0;
  for (const p of [...pages]) {
    const target = p.extracted?.canonical;
    if (!target || crawledKeys.has(target) || queued.has(target)) continue;
    if (!onSite(target) || isProbablyAsset(target)) continue;
    if (canonicalChecks++ >= MAX_CANONICAL_CHECKS) break;
    enqueue(target, target, null, true);
  }
  if (frontier.length && !signal?.aborted) await drain();

  // ---- link graph --------------------------------------------------------
  const clickDepth = shortestClickDepth(base, edges);
  for (const p of pages) p.depth = clickDepth.get(p.normalizedUrl) ?? null;
  skipped.capped = cappedKeys.size;

  const inboundLinks = countInbound(pages);

  const durationMs = Date.now() - started;
  log.info(
    {
      pages: pages.length,
      failed,
      skipped,
      durationMs,
      robotsMissing: robots.missing,
      robotsUnreachable: robots.unreachable,
    },
    "crawl finished",
  );

  return {
    pages,
    inboundLinks,
    robots,
    sitemapUrls,
    skipped,
    stats: { fetched: pages.length, failed, durationMs },
  };
}

/**
 * 0-1 BFS from the start page: a link is one click, a redirect hop is none.
 * Taking the minimum over the whole graph makes depth independent of the
 * order in which concurrent workers happened to discover pages.
 */
function shortestClickDepth(
  start: string,
  edges: Map<string, Array<{ to: string; weight: 0 | 1 }>>,
): Map<string, number> {
  const depth = new Map<string, number>([[start, 0]]);
  const deque: string[] = [start];
  while (deque.length) {
    const node = deque.shift()!;
    const d = depth.get(node)!;
    for (const { to, weight } of edges.get(node) ?? []) {
      const nd = d + weight;
      if ((depth.get(to) ?? Infinity) <= nd) continue;
      depth.set(to, nd);
      if (weight === 0) deque.unshift(to);
      else deque.push(to);
    }
  }
  return depth;
}

/** Distinct linking pages per URL; a redirect passes its linkers on to where it ends. */
function countInbound(pages: CrawledPage[]): Map<string, number> {
  const sources = new Map<string, Set<string>>();
  const add = (target: string, from: string) => {
    if (target === from) return;
    let set = sources.get(target);
    if (!set) sources.set(target, (set = new Set()));
    set.add(from);
  };
  for (const p of pages) {
    for (const link of p.extracted?.links ?? []) {
      if (link.internal) add(link.url, p.normalizedUrl);
    }
  }

  const redirectTo = new Map<string, string>();
  for (const p of pages) if (p.redirectTarget) redirectTo.set(p.normalizedUrl, p.redirectTarget);
  for (const [from, linkers] of [...sources]) {
    let target = redirectTo.get(from);
    const seen = new Set([from]);
    while (target && !seen.has(target)) {
      seen.add(target);
      for (const l of linkers) add(target, l);
      target = redirectTo.get(target);
    }
  }

  return new Map([...sources].map(([url, set]) => [url, set.size]));
}
