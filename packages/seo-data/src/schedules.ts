/**
 * Per-project schedules (scan, rank, pagespeed, competitors, report).
 *
 * The scheduler is a loop in the worker, with all state in PostgreSQL:
 *
 *   every minute:  BEGIN
 *                  SELECT … WHERE enabled AND next_run_at <= now()
 *                    FOR UPDATE SKIP LOCKED LIMIT 50
 *                  enqueue each job, then set last_run_at and the next run
 *                  COMMIT
 *
 * - Survives restarts: nothing lives in process memory or in Redis schedules.
 * - No double runs with several workers: a due row is locked by exactly one
 *   transaction (SKIP LOCKED), and by the time the lock is released its
 *   next_run_at is in the future.
 * - Enqueue happens before COMMIT, so a crash in between re-runs the schedule
 *   rather than losing it; the queues deduplicate a job already waiting for the
 *   same project, and a scan refuses to overlap an active one.
 * - Downtime: the next run is computed from now, so a worker that was down for
 *   a week runs a missed schedule once, not seven times.
 *
 * Cron is standard five-field, evaluated in the schedule's IANA timezone;
 * nextRunAt is an absolute UTC instant.
 */
import cronParser from "cron-parser";
import { z } from "zod";
import { and, db, eq, pool, projects, schedules, sql, type ProjectKind, type Schedule, type ScheduleKind } from "@seo/db";
import { BadRequest, childLogger } from "@seo/core";

export const SCHEDULE_KINDS: readonly ScheduleKind[] = ["scan", "rank", "pagespeed", "competitors", "report", "social_sync"];

/** What a new project starts with (migration 0007 inserts the same values). */
export const DEFAULT_SCHEDULES: Record<ScheduleKind, { cron: string; enabled: boolean }> = {
  scan: { cron: "0 3 * * 1", enabled: true },
  rank: { cron: "0 4 * * *", enabled: true },
  pagespeed: { cron: "0 5 * * 3", enabled: true },
  competitors: { cron: "0 6 * * 0", enabled: true },
  report: { cron: "0 7 1 * *", enabled: false },
  /** Instagram / Telegram projects only (migration 0009 creates it for them). */
  social_sync: { cron: "0 2 * * *", enabled: true },
};

/** Two runs of one schedule must be at least this far apart. */
const MIN_INTERVAL_MS = 60 * 60_000;

export function scheduleKind(raw: string | undefined): ScheduleKind {
  if (!SCHEDULE_KINDS.includes(raw as ScheduleKind)) throw new BadRequest("Unknown schedule", { kind: raw });
  return raw as ScheduleKind;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The next run strictly after `from`; throws when the cron cannot be parsed. */
export function nextRun(cron: string, timezone: string, from: Date): Date {
  return cronParser.parseExpression(cron, { currentDate: from, tz: timezone }).next().toDate();
}

export function validateCron(cron: string, timezone: string): void {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new BadRequest("Cron must have five fields: minute hour day-of-month month day-of-week", { field: "cron" });
  if (!isValidTimezone(timezone)) throw new BadRequest("Unknown timezone", { field: "timezone" });
  let it;
  try {
    it = cronParser.parseExpression(cron, { currentDate: new Date(), tz: timezone });
  } catch (err) {
    throw new BadRequest(`Invalid cron: ${(err as Error).message}`, { field: "cron" });
  }
  // Check the gaps over the next several runs: "*/5 * * * *" or "0,30 * * * *" run too often.
  let prev = it.next().toDate().getTime();
  for (let i = 0; i < 24; i++) {
    const next = it.next().toDate().getTime();
    if (next - prev < MIN_INTERVAL_MS) {
      throw new BadRequest("A schedule may run at most once an hour", { field: "cron" });
    }
    prev = next;
  }
}

export const updateScheduleInput = z.object({
  cron: z.string().trim().min(9).max(100).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

/** The schedules that mean something for a project of this kind. */
export function scheduleKindsFor(projectKind: ProjectKind): readonly ScheduleKind[] {
  return projectKind === "WEBSITE" ? SCHEDULE_KINDS.filter((k) => k !== "social_sync") : ["social_sync"];
}

export async function listSchedules(projectId: string, now = new Date()): Promise<Schedule[]> {
  const rows = await db.select().from(schedules).where(eq(schedules.projectId, projectId));
  const project = (await db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  // A kind the user deleted (or a project from before the defaults) shows as its disabled default.
  return scheduleKindsFor(project?.kind ?? "WEBSITE").map((kind) => {
    const r = rows.find((x) => x.kind === kind);
    if (r) return { ...r, nextRunAt: r.enabled ? (r.nextRunAt ?? nextRun(r.cron, r.timezone, now)) : null };
    return {
      id: "",
      projectId,
      kind,
      cron: DEFAULT_SCHEDULES[kind].cron,
      timezone: "UTC",
      enabled: false,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function updateSchedule(
  projectId: string,
  kind: ScheduleKind,
  input: z.infer<typeof updateScheduleInput>,
  now = new Date(),
): Promise<Schedule> {
  const current = (await db.select().from(schedules).where(and(eq(schedules.projectId, projectId), eq(schedules.kind, kind))).limit(1))[0];
  const cron = input.cron ?? current?.cron ?? DEFAULT_SCHEDULES[kind].cron;
  const timezone = input.timezone ?? current?.timezone ?? "UTC";
  const enabled = input.enabled ?? current?.enabled ?? DEFAULT_SCHEDULES[kind].enabled;
  validateCron(cron, timezone);
  const values = { cron, timezone, enabled, nextRunAt: enabled ? nextRun(cron, timezone, now) : null, updatedAt: now, lastError: null };
  const saved = await db
    .insert(schedules)
    .values({ projectId, kind, ...values })
    .onConflictDoUpdate({ target: [schedules.projectId, schedules.kind], set: values })
    .returning();
  return saved[0]!;
}

// ---------------------------------------------------------------- the loop

export type Dispatch = (schedule: { id: string; projectId: string; orgId: string; kind: ScheduleKind }) => Promise<void>;

/**
 * Claim and dispatch every due schedule. Returns how many were dispatched.
 * `dispatch` enqueues the job; if it throws, the schedule still advances (so a
 * permanently failing project does not retry every minute) and the error is
 * kept in last_error for the panel.
 */
export async function tick(dispatch: Dispatch, now = new Date()): Promise<number> {
  const log = childLogger({ component: "scheduler" });
  // Rows never computed yet (new projects, defaults from the migration) get a next run first.
  const pending = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), sql`${schedules.nextRunAt} IS NULL`))
    .limit(500);
  for (const s of pending) {
    let next: Date | null = null;
    try {
      next = nextRun(s.cron, s.timezone, now);
    } catch {
      /* an invalid cron stored by hand stays unscheduled, with the reason below */
    }
    await db
      .update(schedules)
      .set(next ? { nextRunAt: next } : { enabled: false, lastError: "invalid_cron" })
      .where(and(eq(schedules.id, s.id), sql`${schedules.nextRunAt} IS NULL`));
  }

  const client = await pool.connect();
  let dispatched = 0;
  try {
    await client.query("BEGIN");
    const due = await client.query<{ id: string; project_id: string; kind: ScheduleKind; cron: string; timezone: string; org_id: string }>(
      `SELECT s.id, s.project_id, s.kind, s.cron, s.timezone, p.org_id
         FROM schedules s JOIN projects p ON p.id = s.project_id
        WHERE s.enabled AND s.next_run_at <= $1
        ORDER BY s.next_run_at
        LIMIT 50
        FOR UPDATE OF s SKIP LOCKED`,
      [now],
    );
    for (const s of due.rows) {
      let error: string | null = null;
      try {
        await dispatch({ id: s.id, projectId: s.project_id, orgId: s.org_id, kind: s.kind });
        dispatched++;
      } catch (err) {
        error = (err as { code?: string }).code ?? (err as Error).message.slice(0, 200);
        log.warn({ scheduleId: s.id, kind: s.kind, err: (err as Error).message }, "scheduled run not started");
      }
      let next: Date | null = null;
      try {
        next = nextRun(s.cron, s.timezone, now);
      } catch {
        error = "invalid_cron";
      }
      await client.query(
        `UPDATE schedules SET last_run_at = $2, next_run_at = $3, last_error = $4, enabled = enabled AND $3::timestamptz IS NOT NULL WHERE id = $1`,
        [s.id, now, next, error],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return dispatched;
}
