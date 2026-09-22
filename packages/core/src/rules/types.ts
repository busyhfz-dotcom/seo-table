import type { Severity, RiskLevel, FixAction } from "@seo/db";
import type { Robots } from "../robots.js";

export type AnalyzedImage = { src: string; context: string };

export type AnalyzedLink = { url: string; internal: boolean; nofollow: boolean; anchor: string };

/** A crawled page, flattened to exactly what the rules read. */
export type AnalyzedPage = {
  url: string;
  normalizedUrl: string;
  /** Clicks from the home page; null when the page is not reachable by links (sitemap-only). */
  depth: number | null;
  statusCode: number;
  responseMs: number;
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  h1s: string[];
  canonical: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  indexable: boolean;
  noindexReason: string | null;
  lang: string | null;
  wordCount: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  imagesWithoutAlt: AnalyzedImage[];
  links: AnalyzedLink[];
  internalLinksOut: number;
  externalLinksOut: number;
  internalLinksIn: number;
  inSitemap: boolean;
  /** Location target when this URL answered with a 3xx. */
  redirectTarget: string | null;
  /** Full hop list from this URL to its final destination, computed after the crawl. */
  redirectChain: string[];
  /** True when following redirectTarget from here returns to a URL already visited. */
  redirectLoop: boolean;
  textHash: string | null;
};

export type RuleContext = {
  project: { id: string; baseUrl: string; locale: string; brand?: string };
  pages: AnalyzedPage[];
  byUrl: Map<string, AnalyzedPage>;
  sitemapUrls: Set<string>;
  robots: Robots;
  /** The crawler's User-Agent, so robots.txt is evaluated for the agent that crawled. */
  userAgent: string;
  thresholds: Thresholds;
};

export type Thresholds = {
  titleMin: number;
  titleMax: number;
  metaMin: number;
  metaMax: number;
  thinContentWords: number;
  maxDepth: number;
  maxRedirectHops: number;
  maxImagesPerFix: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  titleMin: 30,
  titleMax: 60,
  metaMin: 70,
  metaMax: 160,
  thinContentWords: 150,
  maxDepth: 4,
  maxRedirectHops: 2,
  maxImagesPerFix: 200,
};

/** A single change a fix would make. Never applied without a dry run first. */
export type ProposedChange = {
  url: string;
  field: string;
  before: string | null;
  after: string;
  /** For ALT_TEXT: which image on the page. */
  selector?: string;
};

export type ProposedFix = {
  action: FixAction;
  risk: RiskLevel;
  title: string;
  rationale: string;
  change: ProposedChange;
};

export type Finding = {
  ruleId: string;
  category: string;
  severity: Severity;
  /** Human-readable issue title, shared by every occurrence in the group. */
  title: string;
  /**
   * Findings that share (ruleId, groupKey) roll up into one SeoIssue. Leave
   * empty for "one issue per rule"; set it for value-scoped issues such as a
   * specific duplicated title.
   */
  groupKey?: string;
  url: string;
  evidence: Record<string, unknown>;
  fix?: ProposedFix;
};

export type Rule = {
  id: string;
  category: string;
  /** Short description used in the Rules tab of a run. */
  description: string;
  run: (ctx: RuleContext) => Finding[];
};

/** Trim text to `max` characters on a word boundary, without cutting mid-word. */
export function trimToLength(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) return text.trim();
  const sliced = chars.slice(0, max).join("");
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[،,;:\-–—\s]+$/u, "")}`;
}

/**
 * A 200 that is an HTML document. A PDF or image answering 200 is marked
 * `non_html` by the crawler and no HTML rule applies to it.
 */
export function isHtmlPage(page: AnalyzedPage): boolean {
  return page.statusCode === 200 && page.noindexReason !== "non_html";
}

export function brandOf(ctx: RuleContext): string {
  if (ctx.project.brand) return ctx.project.brand;
  try {
    const host = new URL(ctx.project.baseUrl).hostname.replace(/^www\./, "");
    const label = host.split(".")[0] ?? host;
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return "";
  }
}
