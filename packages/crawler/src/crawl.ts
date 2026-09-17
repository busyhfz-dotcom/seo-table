import { parseHtmlSnapshot } from './html';
import type { CrawlOptions, PageSnapshot } from './types';

const DEFAULT_USER_AGENT = 'SEOTableBot/0.3 (+https://github.com/busyhfz-dotcom/seo-table)';

function privateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}

export function assertPublicHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs can be crawled.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateIpv4(hostname) || hostname === '::1') {
    throw new Error('Local and private network targets are not allowed.');
  }
  return url;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
}

export async function fetchPage(url: string, options: CrawlOptions = {}): Promise<PageSnapshot> {
  const target = assertPublicHttpUrl(url);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': options.userAgent ?? DEFAULT_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    });
    const finalUrl = assertPublicHttpUrl(response.url || target.toString()).toString();
    const contentType = response.headers.get('content-type') ?? undefined;
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maxResponseBytes) throw new Error(`Response exceeds ${maxResponseBytes} bytes.`);

    if (!contentType?.toLowerCase().includes('text/html')) {
      return parseHtmlSnapshot({ html: '', url: finalUrl, statusCode: response.status, contentType });
    }

    const html = (await response.text()).slice(0, maxResponseBytes);
    return parseHtmlSnapshot({ html, url: finalUrl, statusCode: response.status, contentType });
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
