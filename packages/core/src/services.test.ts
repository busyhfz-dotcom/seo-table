/**
 * Service-level regressions against real Postgres and Redis: issue persistence
 * (chunking, retries, IGNORED), timeline order, status-conditional cancel and
 * decide, the heartbeat-based reaper, fix job ids and the sliding-window limiter.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  auditRuns,
  closeDb,
  db,
  eq,
  fixProposals,
  issueOccurrences,
  organizations,
  projects,
  purgeOrganization,
  seoIssues,
  type AuditRun,
} from "@seo/db";
import type { IssueGroup } from "./rules/index.js";
import { persistFindings, issueTimeline } from "./services/issues.js";
import { cancelScan, createScan, heartbeat, reapStaleRuns } from "./services/scan.js";
import { decide } from "./services/proposals.js";
import { auditJobId, auditQueue, closeQueues, enqueueFix, fixQueue } from "./queue.js";
import { closeRedis } from "./redis.js";
import { rateLimit } from "./ratelimit.js";
import { Conflict, NotFound } from "./errors.js";

let orgId: string;
let otherOrgId: string;

async function newProject(): Promise<string> {
  return (
    await db
      .insert(projects)
      .values({ orgId, name: "svc", baseUrl: "https://svc.example" })
      .returning()
  )[0]!.id;
}

async function newRun(projectId: string, values: Partial<typeof auditRuns.$inferInsert> = {}): Promise<AuditRun> {
  return (
    await db
      .insert(auditRuns)
      .values({ projectId, status: "SUCCEEDED", idempotencyKey: `k-${Math.random()}`, ...values })
      .returning()
  )[0]!;
}

function group(fp: string, urls: string[]): IssueGroup {
  return {
    ruleId: "rule.test",
    fingerprint: fp,
    category: "test",
    severity: "WARNING",
    title: "Test issue",
    urls,
    findings: urls.map((url) => ({
      ruleId: "rule.test",
      category: "test",
      severity: "WARNING" as const,
      title: "Test issue",
      url,
      evidence: {},
    })),
  };
}

beforeAll(async () => {
  orgId = (await db.insert(organizations).values({ name: "Svc", slug: `svc-${Date.now()}` }).returning())[0]!.id;
  otherOrgId = (await db.insert(organizations).values({ name: "Other", slug: `svc-o-${Date.now()}` }).returning())[0]!.id;
});

afterAll(async () => {
  await purgeOrganization(orgId).catch(() => {});
  await purgeOrganization(otherOrgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("persistFindings", () => {
  it("writes an issue with more urls than one INSERT can bind", async () => {
    const projectId = await newProject();
    const run = await newRun(projectId);
    const urls = Array.from({ length: 9_000 }, (_, i) => `https://svc.example/p/${i}`);
    const res = await persistFindings({ projectId, runId: run.id, groups: [group("big", urls)], snapshotIdByUrl: new Map() });
    expect(res.occurrencesWritten).toBe(9_000);
  });

  it("a retry of the same run neither duplicates nor relabels history", async () => {
    const projectId = await newProject();
    const run = await newRun(projectId);
    const input = { projectId, runId: run.id, groups: [group("retry", ["https://svc.example/a", "https://svc.example/b"])], snapshotIdByUrl: new Map() };
    await persistFindings(input);
    const again = await persistFindings(input);
    expect(again.occurrencesWritten).toBe(0);
    expect(again.issuesOpened).toBe(1);

    const [issue] = await db.select().from(seoIssues).where(eq(seoIssues.projectId, projectId));
    expect(issue!.occurrenceCount).toBe(2);
    const kinds = await db.select({ kind: issueOccurrences.kind }).from(issueOccurrences).where(eq(issueOccurrences.issueId, issue!.id));
    expect(kinds.map((k) => k.kind)).toEqual(["DETECTED", "DETECTED"]);

    // The next run is a real PERSISTED and does count.
    const run2 = await newRun(projectId);
    const next = await persistFindings({ ...input, runId: run2.id });
    expect(next.issuesPersisted).toBe(1);
    const [after] = await db.select().from(seoIssues).where(eq(seoIssues.id, issue!.id));
    expect(after!.occurrenceCount).toBe(4);
  });

  it("keeps an IGNORED issue ignored, whether it is seen again or not", async () => {
    const projectId = await newProject();
    const g = group("ignored", ["https://svc.example/i"]);
    await persistFindings({ projectId, runId: (await newRun(projectId)).id, groups: [g], snapshotIdByUrl: new Map() });
    await db.update(seoIssues).set({ status: "IGNORED" }).where(eq(seoIssues.projectId, projectId));

    await persistFindings({ projectId, runId: (await newRun(projectId)).id, groups: [g], snapshotIdByUrl: new Map() });
    expect((await db.select().from(seoIssues).where(eq(seoIssues.projectId, projectId)))[0]!.status).toBe("IGNORED");

    const gone = await persistFindings({ projectId, runId: (await newRun(projectId)).id, groups: [], snapshotIdByUrl: new Map() });
    expect(gone.issuesResolved).toBe(0);
    expect((await db.select().from(seoIssues).where(eq(seoIssues.projectId, projectId)))[0]!.status).toBe("IGNORED");
  });
});

describe("issueTimeline", () => {
  it("returns the newest rows when limited", async () => {
    const projectId = await newProject();
    const g = group("timeline", ["https://svc.example/t"]);
    const runs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const run = await newRun(projectId);
      runs.push(run.id);
      await persistFindings({ projectId, runId: run.id, groups: i === 2 ? [] : [g], snapshotIdByUrl: new Map() });
    }
    const [issue] = await db.select().from(seoIssues).where(eq(seoIssues.projectId, projectId));
    const latest = await issueTimeline(issue!.id, 1);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.auditRunId).toBe(runs[3]);
    expect(latest[0]!.kind).toBe("REGRESSED");
  });
});

describe("cancelScan", () => {
  it("never overwrites a terminal state", async () => {
    const projectId = await newProject();
    const run = await newRun(projectId, { status: "SUCCEEDED" });
    await expect(cancelScan({ runId: run.id, orgId, actor: { type: "USER", id: "u" } })).rejects.toBeInstanceOf(Conflict);
    expect((await db.select().from(auditRuns).where(eq(auditRuns.id, run.id)))[0]!.status).toBe("SUCCEEDED");
  });

  it("does not see another organization's run", async () => {
    const projectId = await newProject();
    const run = await newRun(projectId, { status: "RUNNING" });
    await expect(cancelScan({ runId: run.id, orgId: otherOrgId, actor: { type: "USER", id: "u" } })).rejects.toBeInstanceOf(NotFound);
    await cancelScan({ runId: run.id, orgId, actor: { type: "USER", id: "u" } });
  });
});

describe("createScan", () => {
  it("stores the job id with the row", async () => {
    const projectId = await newProject();
    const { run } = await createScan({ projectId, orgId, actor: { type: "USER", id: "u" }, bypassRateLimit: true });
    expect(run.jobId).toBe(auditJobId(run.id));
    expect(await auditQueue.getJob(run.jobId!)).toBeTruthy();
    await cancelScan({ runId: run.id, orgId, actor: { type: "USER", id: "u" } });
  });
});

describe("decide", () => {
  it("of two concurrent decisions exactly one wins", async () => {
    const projectId = await newProject();
    const p = (
      await db
        .insert(fixProposals)
        .values({ projectId, ruleId: "r", action: "TITLE_REWRITE", risk: "SENSITIVE", status: "AWAITING_APPROVAL", title: "t", changes: [] })
        .returning()
    )[0]!;
    await db.insert(approvals).values({ fixProposalId: p.id, requestedBy: "agent" });

    const results = await Promise.allSettled([
      decide({ proposalId: p.id, orgId, actor: { type: "USER", id: "a" }, approve: true }),
      decide({ proposalId: p.id, orgId, actor: { type: "USER", id: "b" }, approve: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(Conflict);

    const [row] = await db.select().from(fixProposals).where(eq(fixProposals.id, p.id));
    const [approval] = await db.select().from(approvals).where(eq(approvals.fixProposalId, p.id));
    expect(approval!.decision).toBe(row!.status);
  });

  it("does not see another organization's proposal", async () => {
    const projectId = await newProject();
    const p = (
      await db
        .insert(fixProposals)
        .values({ projectId, ruleId: "r", action: "TITLE_REWRITE", risk: "SENSITIVE", status: "AWAITING_APPROVAL", title: "t", changes: [] })
        .returning()
    )[0]!;
    await expect(
      decide({ proposalId: p.id, orgId: otherOrgId, actor: { type: "USER", id: "a" }, approve: true }),
    ).rejects.toBeInstanceOf(NotFound);
  });
});

describe("heartbeat and reaper", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("heartbeat writes at most once per 15 s per run", async () => {
    const projectId = await newProject();
    const run = await newRun(projectId, { status: "RUNNING" });
    await heartbeat(run.id);
    const first = (await db.select().from(auditRuns).where(eq(auditRuns.id, run.id)))[0]!.heartbeatAt;
    expect(first).toBeInstanceOf(Date);
    await db.update(auditRuns).set({ heartbeatAt: null }).where(eq(auditRuns.id, run.id));
    await heartbeat(run.id);
    expect((await db.select().from(auditRuns).where(eq(auditRuns.id, run.id)))[0]!.heartbeatAt).toBeNull();
    await db.update(auditRuns).set({ status: "SUCCEEDED" }).where(eq(auditRuns.id, run.id));
  });

  it("reaps only quiet runs whose job is gone", async () => {
    const quietDead = await newRun(await newProject(), { status: "RUNNING", queuedAt: minutesAgo(120), startedAt: minutesAgo(120), heartbeatAt: minutesAgo(30) });
    const longButBeating = await newRun(await newProject(), { status: "RUNNING", queuedAt: minutesAgo(300), startedAt: minutesAgo(300), heartbeatAt: minutesAgo(1) });
    const quietAlive = await newRun(await newProject(), { status: "RUNNING", queuedAt: minutesAgo(120), startedAt: minutesAgo(120) });
    const waiting = await newRun(await newProject(), { status: "QUEUED", queuedAt: minutesAgo(600) });
    const lost = await newRun(await newProject(), { status: "QUEUED", queuedAt: minutesAgo(10) });
    const justQueued = await newRun(await newProject(), { status: "QUEUED" });

    const alive = new Set([quietAlive.id, waiting.id]);
    const checked: string[] = [];
    const ours = new Set([quietDead.id, longButBeating.id, quietAlive.id, waiting.id, lost.id, justQueued.id]);
    await reapStaleRuns({
      staleMinutes: 15,
      isJobAlive: async (id) => {
        checked.push(id);
        // Runs left over by other suites are reported alive so they are not touched.
        return !ours.has(id) || alive.has(id);
      },
    });

    const status = async (id: string) => (await db.select().from(auditRuns).where(eq(auditRuns.id, id)))[0]!.status;
    expect(await status(quietDead.id)).toBe("DEAD_LETTER");
    expect(await status(lost.id)).toBe("DEAD_LETTER");
    expect(await status(longButBeating.id)).toBe("RUNNING");
    expect(await status(quietAlive.id)).toBe("RUNNING");
    expect(await status(waiting.id)).toBe("QUEUED");
    expect(await status(justQueued.id)).toBe("QUEUED");
    // A beating run is not even looked up in the queue.
    expect(checked).not.toContain(longButBeating.id);

    for (const r of [longButBeating, quietAlive, waiting, justQueued]) {
      await db.update(auditRuns).set({ status: "CANCELED" }).where(eq(auditRuns.id, r.id));
    }
  });

  it("keeps a run when the liveness check fails", async () => {
    const run = await newRun(await newProject(), { status: "RUNNING", startedAt: minutesAgo(120), heartbeatAt: minutesAgo(60) });
    await reapStaleRuns({
      isJobAlive: async (id) => {
        if (id === run.id) throw new Error("redis down");
        return true;
      },
    });
    expect((await db.select().from(auditRuns).where(eq(auditRuns.id, run.id)))[0]!.status).toBe("RUNNING");
    await db.update(auditRuns).set({ status: "CANCELED" }).where(eq(auditRuns.id, run.id));
  });
});

describe("fix jobs", () => {
  it("a second dry run of the same proposal is really enqueued", async () => {
    const data = { proposalId: `p-${Date.now()}`, projectId: "x", dryRun: true, requestedBy: "u", correlationId: "c" };
    const a = await enqueueFix(data);
    const b = await enqueueFix(data);
    expect(a).not.toBe(b);
    expect(await fixQueue.getJob(a)).toBeTruthy();
    expect(await fixQueue.getJob(b)).toBeTruthy();
    await (await fixQueue.getJob(a))?.remove();
    await (await fixQueue.getJob(b))?.remove();
  });
});

describe("sliding-window rate limiter", () => {
  it("admits exactly `limit` per window and says when the next slot frees", async () => {
    const key = `test:${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => rateLimit(key, 3, 800)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    const denied = results.find((r) => !r.allowed)!;
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(800);

    await new Promise((r) => setTimeout(r, denied.retryAfterMs + 50));
    expect((await rateLimit(key, 3, 800)).allowed).toBe(true);
  });
});
