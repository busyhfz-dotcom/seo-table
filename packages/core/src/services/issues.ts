/**
 * Persisting analysis results.
 *
 * The write pattern is the whole point of v0.4: SeoIssue is a mutable roll-up,
 * IssueOccurrence is an immutable ledger. Every run appends one occurrence per
 * (issue, url) with a kind that says what happened — DETECTED the first time,
 * PERSISTED while it lasts, REGRESSED when it comes back, RESOLVED once it is
 * gone. Nothing already written is ever changed.
 */
import {
  and,
  db,
  eq,
  inArray,
  issueOccurrences,
  seoIssues,
  type OccurrenceKind,
  type SeoIssue,
} from "@seo/db";
import type { Finding, IssueGroup } from "../rules/index.js";
import { childLogger, metric } from "../logger.js";

export type PersistInput = {
  projectId: string;
  runId: string;
  groups: IssueGroup[];
  /** Maps a finding's url to the snapshot row it came from, where one exists. */
  snapshotIdByUrl: Map<string, string>;
};

export type PersistResult = {
  issuesOpened: number;
  issuesPersisted: number;
  issuesRegressed: number;
  issuesResolved: number;
  occurrencesWritten: number;
};

export async function persistFindings(input: PersistInput): Promise<PersistResult> {
  const log = childLogger({ component: "issues", runId: input.runId });
  const result: PersistResult = {
    issuesOpened: 0,
    issuesPersisted: 0,
    issuesRegressed: 0,
    issuesResolved: 0,
    occurrencesWritten: 0,
  };

  const existing = await db
    .select()
    .from(seoIssues)
    .where(eq(seoIssues.projectId, input.projectId));
  const byFingerprint = new Map<string, SeoIssue>(existing.map((i) => [i.fingerprint, i]));
  const seenFingerprints = new Set<string>();

  for (const group of input.groups) {
    seenFingerprints.add(group.fingerprint);
    const prior = byFingerprint.get(group.fingerprint);

    let kind: OccurrenceKind;
    let issue: SeoIssue;

    if (!prior) {
      kind = "DETECTED";
      issue = (
        await db
          .insert(seoIssues)
          .values({
            projectId: input.projectId,
            ruleId: group.ruleId,
            fingerprint: group.fingerprint,
            severity: group.severity,
            status: "OPEN",
            title: group.title,
            category: group.category,
            pageCount: group.urls.length,
            occurrenceCount: group.findings.length,
            firstSeenRunId: input.runId,
            lastSeenRunId: input.runId,
            data: { evidence: group.findings.slice(0, 5).map((f) => f.evidence) },
          })
          .returning()
      )[0]!;
      result.issuesOpened++;
    } else {
      // A previously FIXED issue coming back is a regression, and that
      // distinction is what makes the history worth keeping.
      kind = prior.status === "FIXED" ? "REGRESSED" : "PERSISTED";
      if (kind === "REGRESSED") result.issuesRegressed++;
      else result.issuesPersisted++;

      issue = (
        await db
          .update(seoIssues)
          .set({
            status: "OPEN",
            severity: group.severity,
            title: group.title,
            pageCount: group.urls.length,
            occurrenceCount: prior.occurrenceCount + group.findings.length,
            lastSeenAt: new Date(),
            lastSeenRunId: input.runId,
            data: { evidence: group.findings.slice(0, 5).map((f) => f.evidence) },
          })
          .where(eq(seoIssues.id, prior.id))
          .returning()
      )[0]!;
    }

    // One occurrence row per affected url. `onConflictDoNothing` makes a worker
    // retry idempotent without ever updating an existing ledger row.
    const rows = dedupeByUrl(group.findings).map((f) => ({
      issueId: issue.id,
      auditRunId: input.runId,
      pageSnapshotId: input.snapshotIdByUrl.get(f.url) ?? null,
      url: f.url,
      kind,
      severity: f.severity,
      evidence: f.evidence as Record<string, unknown>,
    }));
    if (rows.length > 0) {
      const written = await db
        .insert(issueOccurrences)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: issueOccurrences.id });
      result.occurrencesWritten += written.length;
    }
  }

  // Anything previously open and absent from this run is resolved — recorded as
  // a new RESOLVED occurrence, not by deleting the history.
  const goneIssues = existing.filter(
    (i) => i.status === "OPEN" && !seenFingerprints.has(i.fingerprint),
  );
  if (goneIssues.length > 0) {
    await db
      .update(seoIssues)
      .set({ status: "FIXED", lastSeenRunId: input.runId, lastSeenAt: new Date() })
      .where(
        and(
          eq(seoIssues.projectId, input.projectId),
          inArray(
            seoIssues.id,
            goneIssues.map((i) => i.id),
          ),
        ),
      );

    const resolvedRows = goneIssues.map((i) => ({
      issueId: i.id,
      auditRunId: input.runId,
      pageSnapshotId: null,
      url: `project:${input.projectId}`,
      kind: "RESOLVED" as const,
      severity: i.severity,
      evidence: { resolvedInRun: input.runId, previousPageCount: i.pageCount },
    }));
    const written = await db
      .insert(issueOccurrences)
      .values(resolvedRows)
      .onConflictDoNothing()
      .returning({ id: issueOccurrences.id });
    result.issuesResolved = goneIssues.length;
    result.occurrencesWritten += written.length;
  }

  metric("issues.opened", result.issuesOpened);
  metric("issues.resolved", result.issuesResolved);
  metric("issues.occurrences", result.occurrencesWritten);
  log.info(result, "findings persisted");
  return result;
}

function dedupeByUrl(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    out.push(f);
  }
  return out;
}

export type IssueTimelineEntry = {
  kind: OccurrenceKind;
  severity: string;
  url: string;
  observedAt: Date;
  auditRunId: string;
  evidence: unknown;
};

/** The append-only history of one issue, newest first. */
export async function issueTimeline(issueId: string, limit = 50): Promise<IssueTimelineEntry[]> {
  const rows = await db
    .select({
      kind: issueOccurrences.kind,
      severity: issueOccurrences.severity,
      url: issueOccurrences.url,
      observedAt: issueOccurrences.observedAt,
      auditRunId: issueOccurrences.auditRunId,
      evidence: issueOccurrences.evidence,
    })
    .from(issueOccurrences)
    .where(eq(issueOccurrences.issueId, issueId))
    .limit(limit);
  return rows.sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
}
