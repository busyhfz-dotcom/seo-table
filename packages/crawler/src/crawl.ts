import { parseHtmlSnapshot } from './html';
import type { CrawlOptions, PageSnapshot } from './types';

const DEFAULT_USER_AGENT = 'SEOTableBot/0.3 (+https://github.com/busyhfz-dotcom/seo-table)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function privateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}

function privateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes(':')) return false;
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  if (host.startsWith('::ffff:')) return privateIpv4(host.slice('::ffff:'.length));
  return false;
}

export function assertPublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs can be crawled.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateIpv4(hostname) || privateIpv6(hostname)) {
    throw new Error('Local and private network targets are not allowed.');
  }
  return url;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
}

export async function safeFetch(
  value: string | URL,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = assertPublicHttpUrl(value.toString());

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };

    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current };
    if (redirectCount === maxRedirects) throw new Error(`Too many redirects (>${maxRedirects}).`);

    current = assertPublicHttpUrl(new URL(location, current).toString());
  }

  throw new Error('Redirect handling failed.');
}

export async function fetchPage(url: string, options: CrawlOptions = {}): Promise<PageSnapshot> {
  const target = assertPublicHttpUrl(url);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { response, finalUrl } = await safeFetch(target, {
      signal: controller.signal,
      headers: { 'user-agent': options.userAgent ?? DEFAULT_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    });
    const contentType = response.headers.get('content-type') ?? undefined;
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maxResponseBytes) throw new Error(`Response exceeds ${maxResponseBytes} bytes.`);

    if (!contentType?.toLowerCase().includes('text/html')) {
      return parseHtmlSnapshot({ html: '', url: finalUrl.toString(), statusCode: response.status, contentType });
    }

    const html = (await response.text()).slice(0, maxResponseBytes);
    return parseHtmlSnapshot({ html, url: finalUrl.toString(), statusCode: response.status, contentType });
  } finally {
    clearTimeout(timeout);
  }
}

export async function crawlSite(rootUrl: string, options: CrawlOptions = {}): Promise<{ pages: PageSnapshot[]; discovered: number }> {
  const root = assertPublicHttpUrl(rootUrl);
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 50, 500));
  const queue = [normalizeUrl(root.toString())];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const pages: PageSnapshot[] = [];

  while (queue.length && pages.length < maxPages) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    let page: PageSnapshot;
    try {
      page = await fetchPage(current, options);
    } catch {
      continue;
    }
    pages.push(page);

    for (const link of page.internalLinks) {
      try {
        const next = assertPublicHttpUrl(link);
        if (next.hostname !== root.hostname) continue;
        const normalized = normalizeUrl(next.toString());
        if (!visited.has(normalized) && !queued.has(normalized)) {
          queued.add(normalized);
          queue.push(normalized);
        }
      } catch {
        // Invalid/private links are not crawl candidates.
      }
    }
  }

  return { pages, discovered: queued.size };
}
