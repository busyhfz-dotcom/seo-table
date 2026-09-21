/**
 * Score model.
 *
 * The score answers "how much of this site is in good shape", so it is computed
 * per page and averaged, not derived from a raw issue count — otherwise a large
 * site always scores worse than a small one with the same problems.
 *
 * Each page starts at 100 and loses points per issue affecting it, weighted by
 * severity and capped per category so a single bad category cannot zero a page.
 */
import { severityRank, type Finding } from "./rules/index.js";
import type { AnalyzedPage } from "./rules/types.js";

const SEVERITY_WEIGHT = { CRITICAL: 30, SERIOUS: 15, WARNING: 6, INFO: 2 } as const;
const CATEGORY_CAP = 40;

export type ScoreBreakdown = {
  score: number;
  pagesScored: number;
  byCategory: Array<{ category: string; penalty: number; issues: number }>;
  bySeverity: Array<{ severity: Finding["severity"]; count: number }>;
  worstPages: Array<{ url: string; score: number; issues: number }>;
};

export function computeScore(pages: AnalyzedPage[], findings: Finding[]): ScoreBreakdown {
  const scorable = pages.filter((p) => p.statusCode === 200);
  const byUrl = new Map<string, Finding[]>();
  for (const f of findings) {
    byUrl.set(f.url, [...(byUrl.get(f.url) ?? []), f]);
  }

  const categoryPenalty = new Map<string, number>();
  const categoryIssues = new Map<string, number>();
  const severityCount = new Map<Finding["severity"], number>();
  for (const f of findings) {
    severityCount.set(f.severity, (severityCount.get(f.severity) ?? 0) + 1);
    categoryIssues.set(f.category, (categoryIssues.get(f.category) ?? 0) + 1);
  }

  const pageScores: Array<{ url: string; score: number; issues: number }> = [];

  for (const page of scorable) {
    const own = byUrl.get(page.normalizedUrl) ?? [];
    const perCategory = new Map<string, number>();
    for (const f of own) {
      const weight = SEVERITY_WEIGHT[f.severity];
      perCategory.set(f.category, (perCategory.get(f.category) ?? 0) + weight);
    }
    let penalty = 0;
    for (const [cat, raw] of perCategory) {
      const capped = Math.min(raw, CATEGORY_CAP);
      penalty += capped;
      categoryPenalty.set(cat, (categoryPenalty.get(cat) ?? 0) + capped);
    }
    // A page that cannot be indexed at all is the floor, not a negative number.
    const base = page.indexable ? 100 : 55;
    pageScores.push({
      url: page.normalizedUrl,
      score: Math.max(0, Math.round(base - penalty)),
      issues: own.length,
    });
  }

  // Site-wide findings (no sitemap, no robots.txt) attach to no page, so they are
  // applied once against the whole site.
  const siteWide = findings.filter((f) => !scorable.some((p) => p.normalizedUrl === f.url));
  const siteWidePenalty = Math.min(
    15,
    siteWide.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity] / 3, 0),
  );

  const avg =
    pageScores.length === 0
      ? 0
      : pageScores.reduce((s, p) => s + p.score, 0) / pageScores.length;

  return {
    score: Math.max(0, Math.min(100, Math.round(avg - siteWidePenalty))),
    pagesScored: pageScores.length,
    byCategory: [...categoryPenalty.entries()]
      .map(([category, penalty]) => ({
        category,
        penalty: Math.round(penalty),
        issues: categoryIssues.get(category) ?? 0,
      }))
      .sort((a, b) => b.penalty - a.penalty),
    bySeverity: (["CRITICAL", "SERIOUS", "WARNING", "INFO"] as const)
      .map((severity) => ({ severity, count: severityCount.get(severity) ?? 0 }))
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    worstPages: pageScores.sort((a, b) => a.score - b.score).slice(0, 10),
  };
}
