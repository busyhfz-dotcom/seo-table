export type IssueSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type IssueCode =
  | 'HTTP_ERROR'
  | 'MISSING_TITLE'
  | 'TITLE_TOO_SHORT'
  | 'TITLE_TOO_LONG'
  | 'MISSING_META_DESCRIPTION'
  | 'META_DESCRIPTION_TOO_LONG'
  | 'MISSING_H1'
  | 'MULTIPLE_H1'
  | 'MISSING_CANONICAL'
  | 'NOINDEX'
  | 'MISSING_IMAGE_ALT'
  | 'DUPLICATE_TITLE'
  | 'DUPLICATE_META_DESCRIPTION'
  | 'ROBOTS_UNAVAILABLE'
  | 'SITEMAP_UNAVAILABLE';

export interface PageSnapshot {
  url: string;
  statusCode: number;
  contentType?: string;
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  robots?: string;
  h1s: string[];
  imageCount: number;
  missingAltCount: number;
  links: string[];
  internalLinks: string[];
  fetchedAt: string;
}

export interface AuditFinding {
  code: IssueCode;
  severity: IssueSeverity;
  url?: string;
  title: string;
  details: string;
  evidence?: Record<string, unknown>;
  suggestedActionType?: string;
}

export interface PageAnalysis {
  url: string;
  issues: IssueCode[];
  findings: AuditFinding[];
  score: number;
}

export interface SiteAuditResult {
  rootUrl: string;
  score: number;
  pagesDiscovered: number;
  pagesScanned: number;
  robotsStatus: 'OK' | 'MISSING' | 'ERROR';
  sitemapStatus: 'OK' | 'MISSING' | 'ERROR';
  pages: PageSnapshot[];
  findings: AuditFinding[];
  startedAt: string;
  completedAt: string;
}

export interface CrawlOptions {
  maxPages?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  userAgent?: string;
}
