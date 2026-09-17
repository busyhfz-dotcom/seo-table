import { analyzePage, scoreFindings } from './analyzer';
import { assertPublicHttpUrl, crawlSite } from './crawl';
import type { AuditFinding, CrawlOptions, PageSnapshot, SiteAuditResult } from './types';

async function probe(url: URL, path: string, options: CrawlOptions): Promise<'OK' | 'MISSING' | 'ERROR'> {
  const target = new URL(path, url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': options.userAgent ?? 'SEOTableBot/0.3' },
    });
    if (response.status === 404) return 'MISSING';
    return response.ok ? 'OK' : 'ERROR';
  } catch {
    return 'ERROR';
  } finally {
    clearTimeout(timeout);
  }
}

function duplicateFindings(pages: PageSnapshot[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const byTitle = new Map<string, PageSnapshot[]>();
  const byDescription = new Map<string, PageSnapshot[]>();

  for (const page of pages) {
    const title = page.title?.trim().toLowerCase();
    const description = page.metaDescription?.trim().toLowerCase();
    if (title) byTitle.set(title, [...(byTitle.get(title) ?? []), page]);
    if (description) byDescription.set(description, [...(byDescription.get(description) ?? []), page]);
  }

  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    for (const page of group) findings.push({ code: 'DUPLICATE_TITLE', severity: 'MEDIUM', url: page.url, title: 'Duplicate page title', details: `The same title appears on ${group.length} crawled pages.`, suggestedActionType: 'META_TITLE', evidence: { duplicates: group.map((item) => item.url) } });
  }

  for (const group of byDescription.values()) {
    if (group.length < 2) continue;
    for (const page of group) findings.push({ code: 'DUPLICATE_META_DESCRIPTION', severity: 'LOW', url: page.url, title: 'Duplicate meta description', details: `The same meta description appears on ${group.length} crawled pages.`, suggestedActionType: 'META_DESCRIPTION', evidence: { duplicates: group.map((item) => item.url) } });
  }

  return findings;
}

export async function auditSite(rootUrl: string, options: CrawlOptions = {}): Promise<SiteAuditResult> {
  const startedAt = new Date().toISOString();
  const root = assertPublicHttpUrl(rootUrl);
  const [robotsStatus, sitemapStatus, crawl] = await Promise.all([
    probe(root, '/robots.txt', options),
    probe(root, '/sitemap.xml', options),
    crawlSite(root.toString(), options),
  ]);

  const findings = crawl.pages.flatMap((page) => analyzePage(page).findings);
  findings.push(...duplicateFindings(crawl.pages));
  if (robotsStatus !== 'OK') findings.push({ code: 'ROBOTS_UNAVAILABLE', severity: 'MEDIUM', title: 'robots.txt is unavailable', details: `robots.txt probe returned ${robotsStatus}.` });
  if (sitemapStatus !== 'OK') findings.push({ code: 'SITEMAP_UNAVAILABLE', severity: 'LOW', title: 'sitemap.xml is unavailable', details: `sitemap.xml probe returned ${sitemapStatus}.` });

  return {
    rootUrl: root.toString(),
    score: scoreFindings(findings),
    pagesDiscovered: crawl.discovered,
    pagesScanned: crawl.pages.length,
    robotsStatus,
    sitemapStatus,
    pages: crawl.pages,
    findings,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
