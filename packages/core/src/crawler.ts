/**
 * Breadth-first crawler.
 *
 * Deliberate limits, because a crawler is something you point at someone else's
 * server: robots.txt is honoured, concurrency and per-host request rate are
 * capped, redirects are recorded rather than chased blindly, every fetch has a
 * timeout, and the page cap is enforced before enqueueing rather than after
 * fetching.
 */
import { env } from "./env.js";
import { extract, indexability, type Extracted } from "./extract.js";
import { crawlDelayFor, isAllowed, parseRobots, parseSitemap, type Robots } from "./robots.js";
import { isProbablyAsset, normalizeUrl, pathDepth, registrableHost } from "./url.js";
import { childLogger, metric } from "./logger.js";

export type CrawledPage = {
  url: string;
  normalizedUrl: string;
  depth: number;
  statusCode: number;
  responseMs: number;
  bodyBytes: number;
  xRobotsTag: string | null;
  /** For a 3xx: the URL the Location header points at, normalised. */
  redirectTarget: string | null;
  extracted: Extracted | null;
  indexable: boolean;
  noindexReason: string | null;
  inSitemap: boolean;
  error?: string;
};

export type CrawlResult = {
  pages: CrawledPage[];
  /** Inbound internal link counts, resolved after the whole crawl. */
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
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

type FetchOutcome = {
  status: number;
  headers: Headers;
  body: string;
  /** Normalised Location target when status is 3xx, else null. */
  redirectTarget: string | null;
  ms: number;
  bytes: number;
};

/**
 * Fetch one URL. Redirects are NOT followed here.
 *
 * Each URL gets its own row, and a 3xx is recorded as a 3xx with its target,
 * which is then queued like any other URL. That keeps one snapshot per requested
 * URL — the alternative, collapsing a chain into its destination, loses the
 * hop that is exactly what the redirect rules need to report, and makes several
 * requested URLs collide on one normalised URL.
 */
async function fetchOnce(
  url: string,
  opts: Required<Pick<CrawlOptions, "userAgent" | "timeoutMs">> & {
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<FetchOutcome> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await opts.fetchImpl(url, {
      redirect: "manual",
      headers: {
        "user-agent": opts.userAgent,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "fa,en;q=0.8",
      },
      signal: controller.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      return {
        status: res.status,
        headers: res.headers,
        body: "",
        redirectTarget: loc ? normalizeUrl(loc, url) : null,
        ms: Date.now() - t0,
        bytes: 0,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("html") || contentType === "";
    const body = isHtml ? await res.text() : "";
    return {
      status: res.status,
      headers: res.headers,
      body,
      redirectTarget: null,
      ms: Date.now() - t0,
      bytes: Buffer.byteLength(body),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const cfg = env();
  const userAgent = options.userAgent ?? cfg.CRAWLER_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? cfg.CRAWLER_TIMEOUT_MS;
  const concurrency = Math.min(options.concurrency ?? cfg.CRAWLER_MAX_CONCURRENCY, 16);
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = childLogger({ component: "crawler", baseUrl: options.baseUrl });
  const started = Date.now();

  const base = normalizeUrl(options.baseUrl);
  if (!base) throw new Error(`Invalid baseUrl: ${options.baseUrl}`);
  const host = registrableHost(new URL(base).hostname);

  // ---- robots.txt --------------------------------------------------------
  let robots: Robots;
  try {
    const res = await fetchImpl(new URL("/robots.txt", base).toString(), {
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    robots = res.ok ? parseRobots(await res.text()) : parseRobots("", true);
  } catch {
    robots = parseRobots("", true);
  }
  const politeDelay = crawlDelayFor(robots, userAgent);
  const effectiveRps = politeDelay && politeDelay > 0
    ? Math.min(options.requestsPerSecond, Math.max(1, Math.floor(1 / politeDelay)))
    : options.requestsPerSecond;

  // ---- sitemaps ----------------------------------------------------------
  const sitemapUrls = new Set<string>();
  const sitemapQueue = robots.sitemaps.length
    ? [...robots.sitemaps]
    : [new URL("/sitemap.xml", base).toString()];
  const seenSitemaps = new Set<string>();
  while (sitemapQueue.length && sitemapUrls.size < options.pageCap * 2) {
    const sm = sitemapQueue.shift()!;
    if (seenSitemaps.has(sm)) continue;
    seenSitemaps.add(sm);
    try {
      const res = await fetchImpl(sm, {
        headers: { "user-agent": userAgent },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const parsed = parseSitemap(await res.text());
      for (const u of parsed.urls) {
        const nu = normalizeUrl(u);
        if (nu) sitemapUrls.add(nu);
      }
      for (const s of parsed.sitemaps) if (!seenSitemaps.has(s)) sitemapQueue.push(s);
    } catch {
      /* a missing sitemap is a finding, not a crawl failure */
    }
  }

  // ---- frontier ----------------------------------------------------------
  const skipped = { robotsDisallowed: 0, assets: 0, offSite: 0, capped: 0 };
  const queued = new Set<string>([base]);
  const frontier: Array<{ url: string; depth: number }> = [{ url: base, depth: 0 }];
  for (const u of sitemapUrls) {
    if (queued.size >= options.pageCap) {
      skipped.capped++;
      continue;
    }
    if (queued.has(u)) continue;
    if (registrableHost(new URL(u).hostname) !== host) {
      skipped.offSite++;
      continue;
    }
    queued.add(u);
    frontier.push({ url: u, depth: pathDepth(u) });
  }

  const pages: CrawledPage[] = [];
  const inboundLinks = new Map<string, number>();
  let failed = 0;
  const maxDepth = options.maxDepth ?? 10;
  let lastTick = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (options.signal?.aborted) return;
      const item = frontier.shift();
      if (!item) return;

      if (!isAllowed(robots, item.url, userAgent)) {
        skipped.robotsDisallowed++;
        continue;
      }

      // Politeness: spread requests instead of bursting.
      const gap = Math.ceil(1000 / Math.max(1, effectiveRps)) * concurrency;
      const since = Date.now() - lastTick;
      if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
      lastTick = Date.now();

      let page: CrawledPage;
      try {
        const out = await fetchOnce(item.url, {
          userAgent,
          timeoutMs,
          fetchImpl,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const normalized = normalizeUrl(item.url) ?? item.url;
        const xRobots = out.headers.get("x-robots-tag");
        const extracted = out.body ? extract(out.body, normalized) : null;
        const idx = indexability({
          statusCode: out.status,
          robotsMeta: extracted?.robotsMeta ?? null,
          xRobotsTag: xRobots,
          allowedByRobotsTxt: isAllowed(robots, normalized, userAgent),
          canonical: extracted?.canonical ?? null,
          normalizedUrl: normalized,
        });

        page = {
          url: item.url,
          normalizedUrl: normalized,
          depth: item.depth,
          statusCode: out.status,
          responseMs: out.ms,
          bodyBytes: out.bytes,
          xRobotsTag: xRobots,
          redirectTarget: out.redirectTarget,
          extracted,
          indexable: idx.indexable,
          noindexReason: idx.reason,
          inSitemap: sitemapUrls.has(normalized),
        };

        // A redirect target is crawled like any other discovered URL.
        if (out.redirectTarget) {
          const target = out.redirectTarget;
          const onSite = (() => {
            try {
              return registrableHost(new URL(target).hostname) === host;
            } catch {
              return false;
            }
          })();
          if (onSite && !queued.has(target) && !isProbablyAsset(target)) {
            if (queued.size >= options.pageCap) skipped.capped++;
            else {
              queued.add(target);
              frontier.push({ url: target, depth: item.depth });
            }
          }
        }

        if (extracted) {
          for (const link of extracted.links) {
            if (!link.internal) continue;
            inboundLinks.set(link.url, (inboundLinks.get(link.url) ?? 0) + 1);
            if (link.nofollow) continue;
            if (queued.size >= options.pageCap) {
              skipped.capped++;
              continue;
            }
            if (queued.has(link.url) || isProbablyAsset(link.url)) continue;
            if (item.depth + 1 > maxDepth) continue;
            queued.add(link.url);
            frontier.push({ url: link.url, depth: item.depth + 1 });
          }
        }
      } catch (err) {
        failed++;
        page = {
          url: item.url,
          normalizedUrl: normalizeUrl(item.url) ?? item.url,
          depth: item.depth,
          statusCode: 0,
          responseMs: 0,
          bodyBytes: 0,
          xRobotsTag: null,
          redirectTarget: null,
          extracted: null,
          indexable: false,
          noindexReason: "fetch_failed",
          inSitemap: false,
          error: (err as Error).message,
        };
      }

      pages.push(page);
      metric("crawler.page", 1, { status: String(page.statusCode) });
      await options.onProgress?.(pages.length, frontier.length);
    }
  });

  await Promise.all(workers);

  const durationMs = Date.now() - started;
  log.info(
    { pages: pages.length, failed, skipped, durationMs, robotsMissing: robots.missing },
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
