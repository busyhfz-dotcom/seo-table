import { fingerprint } from "../crypto.js";
import { ONPAGE_RULES } from "./onpage.js";
import { STRUCTURE_RULES } from "./structure.js";
import { TECHNICAL_RULES } from "./technical.js";
import {
  DEFAULT_THRESHOLDS,
  type AnalyzedPage,
  type Finding,
  type Rule,
  type RuleContext,
  type Thresholds,
} from "./types.js";

export * from "./types.js";
export { ONPAGE_RULES } from "./onpage.js";
export { TECHNICAL_RULES } from "./technical.js";
export { STRUCTURE_RULES, slugify } from "./structure.js";

/** The ten Optimize Existing groups, in reporting order. */
export const ALL_RULES: Rule[] = [...ONPAGE_RULES, ...TECHNICAL_RULES, ...STRUCTURE_RULES];

export const RULE_CATEGORIES = [
  "title",
  "meta",
  "structure",
  "canonical",
  "robots",
  "sitemap",
  "accessibility",
  "internal_links",
  "duplicate",
  "indexability",
  "content",
  "url",
] as const;

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id);
}

/** Findings that share (ruleId, groupKey) become one issue with many occurrences. */
export type IssueGroup = {
  ruleId: string;
  fingerprint: string;
  category: string;
  severity: Finding["severity"];
  title: string;
  findings: Finding[];
  urls: string[];
};

export function groupFindings(findings: Finding[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const f of findings) {
    const fp = fingerprint([f.ruleId, f.groupKey ?? ""]);
    const existing = groups.get(fp);
    if (existing) {
      existing.findings.push(f);
      if (!existing.urls.includes(f.url)) existing.urls.push(f.url);
      if (severityRank(f.severity) > severityRank(existing.severity)) existing.severity = f.severity;
    } else {
      groups.set(fp, {
        ruleId: f.ruleId,
        fingerprint: fp,
        category: f.category,
        severity: f.severity,
        title: f.title,
        findings: [f],
        urls: [f.url],
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || b.urls.length - a.urls.length,
  );
}

export function severityRank(s: Finding["severity"]): number {
  return { CRITICAL: 4, SERIOUS: 3, WARNING: 2, INFO: 1 }[s];
}

export type RunRulesInput = {
  project: RuleContext["project"];
  pages: AnalyzedPage[];
  sitemapUrls: Set<string>;
  robots: RuleContext["robots"];
  thresholds?: Partial<Thresholds>;
};

export type RunRulesOutput = {
  findings: Finding[];
  groups: IssueGroup[];
  perRule: Array<{ ruleId: string; category: string; count: number; pages: number }>;
};

export function runRules(input: RunRulesInput): RunRulesOutput {
  const ctx: RuleContext = {
    project: input.project,
    pages: input.pages,
    byUrl: new Map(input.pages.map((p) => [p.normalizedUrl, p])),
    sitemapUrls: input.sitemapUrls,
    robots: input.robots,
    thresholds: { ...DEFAULT_THRESHOLDS, ...input.thresholds },
  };

  const findings: Finding[] = [];
  const perRule: RunRulesOutput["perRule"] = [];

  for (const rule of ALL_RULES) {
    let produced: Finding[] = [];
    try {
      produced = rule.run(ctx);
    } catch (err) {
      // One broken rule must not abort the whole analysis; it is reported as a
      // finding of its own so the failure is visible rather than silent.
      produced = [
        {
          ruleId: "rule.engine.error",
          category: "engine",
          severity: "INFO",
          title: `Rule ${rule.id} failed to run`,
          groupKey: rule.id,
          url: input.project.baseUrl,
          evidence: { rule: rule.id, error: (err as Error).message },
        },
      ];
    }
    findings.push(...produced);
    perRule.push({
      ruleId: rule.id,
      category: rule.category,
      count: produced.length,
      pages: new Set(produced.map((f) => f.url)).size,
    });
  }

  return { findings, groups: groupFindings(findings), perRule };
}
