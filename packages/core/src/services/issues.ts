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
  desc,
  eq,
  inArray,
  issueOccurrences,
  ne,
  seoIssues,
  type OccurrenceKind,
  type SeoIssue,
} from "@seo/db";
import type { Finding, IssueGroup } from "../rules/index.js";
import { childLogger, metric } from "../logger.js";

/**
 * Rows per multi-row INSERT. An occurrence binds 8 parameters and Postgres caps a
 * statement at 65535, so one INSERT for a large site's issue would fail outright.
 */
const INSERT_CHUNK = 1000;

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

/**
 * Writes one run's findings. All of it happens in one transaction, so a worker
 * that dies halfway leaves nothing behind and the retry starts clean.
 *
 * A retry of a run whose earlier attempt did commit is recognised by
 * `lastSeenRunId === runId`. Such an issue keeps the kind that attempt recorded
 * (the roll-up now says OPEN, which would otherwise turn a DETECTED into a
 * PERSISTED) and its occurrence count is not added a second time.
 */
export async function persistFindings(input: PersistInput): Promise<PersistResult> {
  const log = childLogger({ component: "issues", runId: input.runId });
  const result: PersistResult = {
    issuesOpened: 0,
    issuesPersisted: 0,
    issuesRegressed: 0,
    issuesResolved: 0,
    occurrencesWritten: 0,
  };

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(seoIssues)
      .where(eq(seoIssues.projectId, input.projectId));
    const byFingerprint = new Map<string, SeoIssue>(existing.map((i) => [i.fingerprint, i]));
    const seenFingerprints = new Set<string>();

    // Kinds an earlier attempt of this same run already wrote, per issue.
    const earlierKind = new Map<string, OccurrenceKind>();
    const earlier = await tx
      .selectDistinct({ issueId: issueOccurrences.issueId, kind: issueOccurrences.kind })
      .from(issueOccurrences)
      .where(and(eq(issueOccurrences.auditRunId, input.runId), ne(issueOccurrences.kind, "RESOLVED")));
    for (const row of earlier) earlierKind.set(row.issueId, row.kind);

    for (const group of input.groups) {
      seenFingerprints.add(group.fingerprint);
      const prior = byFingerprint.get(group.fingerprint);
      const evidence = { evidence: group.findings.slice(0, 5).map((f) => f.evidence) };

      let kind: OccurrenceKind;
      let issue: SeoIssue;

      if (!prior) {
        kind = "DETECTED";
        issue = (
          await tx
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
              data: evidence,
            })
            .returning()
        )[0]!;
        result.issuesOpened++;
      } else {
        const repeat = prior.lastSeenRunId === input.runId ? earlierKind.get(prior.id) : undefined;
        // A previously FIXED issue coming back is a regression, and that
        // distinction is what makes the history worth keeping. An issue this
        // same run already resolved (earlier attempt) simply persists.
        kind =
          repeat ??
          (prior.status === "FIXED" && prior.lastSeenRunId !== input.runId ? "REGRESSED" : "PERSISTED");
        if (kind === "DETECTED") result.issuesOpened++;
        else if (kind === "REGRESSED") result.issuesRegressed++;
        else result.issuesPersisted++;

        issue = (
          await tx
            .update(seoIssues)
            .set({
              // A person's decision to ignore an issue survives rescans.
              status: prior.status === "IGNORED" ? "IGNORED" : "OPEN",
              severity: group.severity,
              title: group.title,
              pageCount: group.urls.length,
              occurrenceCount: repeat ? prior.occurrenceCount : prior.occurrenceCount + group.findings.length,
              lastSeenAt: new Date(),
              lastSeenRunId: input.runId,
              data: evidence,
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
      for (const chunk of chunks(rows, INSERT_CHUNK)) {
        const written = await tx
          .insert(issueOccurrences)
          .values(chunk)
          .onConflictDoNothing()
          .returning({ id: issueOccurrences.id });
        result.occurrencesWritten += written.length;
      }
    }

    // Anything previously open and absent from this run is resolved — recorded as
    // a new RESOLVED occurrence, not by deleting the history. IGNORED issues are
    // left alone: they are not open, and a person chose their state.
    const goneIssues = existing.filter(
      (i) => i.status === "OPEN" && !seenFingerprints.has(i.fingerprint),
    );
    for (const chunk of chunks(goneIssues, INSERT_CHUNK)) {
      await tx
        .update(seoIssues)
        .set({ status: "FIXED", lastSeenRunId: input.runId, lastSeenAt: new Date() })
        .where(
          and(
            eq(seoIssues.projectId, input.projectId),
            inArray(
              seoIssues.id,
              chunk.map((i) => i.id),
            ),
          ),
        );

      const written = await tx
        .insert(issueOccurrences)
        .values(
          chunk.map((i) => ({
            issueId: i.id,
            auditRunId: input.runId,
            pageSnapshotId: null,
            url: `project:${input.projectId}`,
            kind: "RESOLVED" as const,
            severity: i.severity,
            evidence: { resolvedInRun: input.runId, previousPageCount: i.pageCount },
          })),
        )
        .onConflictDoNothing()
        .returning({ id: issueOccurrences.id });
      result.occurrencesWritten += written.length;
    }
    result.issuesResolved = goneIssues.length;
  });

  metric("issues.opened", result.issuesOpened);
  metric("issues.resolved", result.issuesResolved);
  metric("issues.occurrences", result.occurrencesWritten);
  log.info(result, "findings persisted");
  return result;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
    // Ordered before the LIMIT, so it is the newest `limit` rows, not any `limit`.
    .orderBy(desc(issueOccurrences.observedAt), desc(issueOccurrences.id))
    .limit(limit);
  return rows;
}
