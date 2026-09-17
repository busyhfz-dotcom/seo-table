import type { AuditFinding, IssueSeverity, PageAnalysis, PageSnapshot } from './types';

const severityPenalty: Record<IssueSeverity, number> = {
  INFO: 1,
  LOW: 3,
  MEDIUM: 7,
  HIGH: 14,
  CRITICAL: 25,
};

function finding(
  page: PageSnapshot,
  code: AuditFinding['code'],
  severity: IssueSeverity,
  title: string,
  details: string,
  suggestedActionType?: string,
  evidence?: Record<string, unknown>,
): AuditFinding {
  return { code, severity, url: page.url, title, details, suggestedActionType, evidence };
}

export function scoreFindings(findings: AuditFinding[]): number {
  const penalty = findings.reduce((total, item) => total + severityPenalty[item.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function analyzePage(input: Partial<PageSnapshot> & { url: string }): PageAnalysis {
  const page: PageSnapshot = {
    statusCode: 200,
    h1s: [],
    imageCount: 0,
    missingAltCount: 0,
    links: [],
    internalLinks: [],
    fetchedAt: new Date().toISOString(),
    ...input,
  };
  const findings: AuditFinding[] = [];

  if (page.statusCode >= 400) {
    findings.push(finding(page, 'HTTP_ERROR', page.statusCode >= 500 ? 'CRITICAL' : 'HIGH', 'Page returns an HTTP error', `HTTP ${page.statusCode} prevents reliable organic discovery.`, undefined, { statusCode: page.statusCode }));
  }

  if (!page.title) {
    findings.push(finding(page, 'MISSING_TITLE', 'HIGH', 'Missing page title', 'The page has no HTML title element.', 'META_TITLE'));
  } else if (page.title.length < 20) {
    findings.push(finding(page, 'TITLE_TOO_SHORT', 'LOW', 'Page title is unusually short', 'A short title may not communicate the page intent clearly.', 'META_TITLE', { length: page.title.length }));
  } else if (page.title.length > 65) {
    findings.push(finding(page, 'TITLE_TOO_LONG', 'LOW', 'Page title is unusually long', 'Long titles are often truncated and can dilute the main intent.', 'META_TITLE', { length: page.title.length }));
  }

  if (!page.metaDescription) {
    findings.push(finding(page, 'MISSING_META_DESCRIPTION', 'MEDIUM', 'Missing meta description', 'No meta description is present for this page.', 'META_DESCRIPTION'));
  } else if (page.metaDescription.length > 170) {
    findings.push(finding(page, 'META_DESCRIPTION_TOO_LONG', 'LOW', 'Meta description is unusually long', 'Search engines may truncate this description.', 'META_DESCRIPTION', { length: page.metaDescription.length }));
  }

  if (page.h1s.length === 0) {
    findings.push(finding(page, 'MISSING_H1', 'MEDIUM', 'Missing H1', 'The page does not expose a primary H1 heading.'));
  } else if (page.h1s.length > 1) {
    findings.push(finding(page, 'MULTIPLE_H1', 'LOW', 'Multiple H1 headings', 'Review the heading hierarchy and keep a clear primary topic.', undefined, { count: page.h1s.length }));
  }

  if (!page.canonicalUrl) {
    findings.push(finding(page, 'MISSING_CANONICAL', 'LOW', 'Missing canonical URL', 'No canonical link was found. Adding one must be reviewed because an incorrect canonical can remove a page from search.', 'CANONICAL'));
  }

  if ((page.robots ?? '').toLowerCase().split(',').some((token) => token.trim() === 'noindex')) {
    findings.push(finding(page, 'NOINDEX', 'HIGH', 'Page is marked noindex', 'Verify that excluding this page from search is intentional.', 'ROBOTS', { robots: page.robots }));
  }

  if (page.missingAltCount > 0) {
    findings.push(finding(page, 'MISSING_IMAGE_ALT', 'LOW', 'Images are missing alt attributes', `${page.missingAltCount} image(s) do not have an alt attribute.`, 'IMAGE_ALT', { missingAltCount: page.missingAltCount, imageCount: page.imageCount }));
  }

  return {
    url: page.url,
    issues: findings.map((item) => item.code),
    findings,
    score: scoreFindings(findings),
  };
}
