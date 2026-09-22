/**
 * Small read helpers the screens need beyond lib/queries.ts: who an audit actor
 * is, and the latest live execution of each fix (what a retry or a rollback
 * would act on).
 */
import { db, desc, eq, and, fixExecutions, inArray, users, type FixStatus } from "@seo/db";

export type UserLabel = { email: string; name: string | null };

/** Users by id, for turning actor ids into people. Unknown ids are simply absent. */
export async function usersByIds(ids: Array<string | null | undefined>): Promise<Map<string, UserLabel>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, { email: r.email, name: r.name }]));
}

export type LiveExecution = {
  id: string;
  status: FixStatus;
  appliedCount: number;
  failedCount: number;
  error: string | null;
  results: unknown;
  rolledBackAt: Date | null;
  finishedAt: Date | null;
};

/** The newest non-dry-run execution per proposal. */
export async function latestLiveExecutions(proposalIds: string[]): Promise<Map<string, LiveExecution>> {
  if (proposalIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([fixExecutions.fixProposalId], {
      proposalId: fixExecutions.fixProposalId,
      id: fixExecutions.id,
      status: fixExecutions.status,
      appliedCount: fixExecutions.appliedCount,
      failedCount: fixExecutions.failedCount,
      error: fixExecutions.error,
      results: fixExecutions.results,
      rolledBackAt: fixExecutions.rolledBackAt,
      finishedAt: fixExecutions.finishedAt,
    })
    .from(fixExecutions)
    .where(and(inArray(fixExecutions.fixProposalId, proposalIds), eq(fixExecutions.dryRun, false)))
    .orderBy(fixExecutions.fixProposalId, desc(fixExecutions.startedAt));
  return new Map(rows.map(({ proposalId, ...rest }) => [proposalId, rest]));
}
