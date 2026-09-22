/**
 * The run lifecycle around analysis: which states a job may pick a run up
 * from, what a failed attempt leaves behind, and that repeated runs do not
 * queue the same fix twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditRuns, closeDb, db, eq, fixProposals, inArray, organizations, projects, purgeOrganization } from "@seo/db";
import { BlockedAddressError, closeQueues, closeRedis, scanService } from "@seo/core";
import { analyze, isPermanentFailure, markRunFailed } from "@seo/pipeline";
import { startFixture, type Fixture } from "./fixture-site.js";

let fixture: Fixture;
let orgId: string;
let projectId: string;

async function newRun(status: "QUEUED" | "RUNNING" | "SUCCEEDED" = "QUEUED") {
  return (
    await db
      .insert(auditRuns)
      .values({ projectId, status, idempotencyKey: `k-${Date.now()}-${Math.random()}` })
      .returning()
  )[0]!;
}

const runRow = async (id: string) => (await db.select().from(auditRuns).where(eq(auditRuns.id, id)))[0]!;

beforeAll(async () => {
  fixture = await startFixture();
  orgId = (await db.insert(organizations).values({ name: "Lifecycle", slug: `life-${Date.now()}` }).returning())[0]!.id;
  projectId = (
    await db
      .insert(projects)
      .values({ orgId, name: "Fixture", baseUrl: fixture.baseUrl, locale: "fa", pageCap: 100, crawlRate: 50 })
      .returning()
  )[0]!.id;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  await purgeOrganization(orgId);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("analyze", () => {
  it("does nothing for a run that is no longer active", async () => {
    const done = await newRun("SUCCEEDED");
    const requests = fixture.requests.length;
    const outcome = await analyze(done.id);
    expect(outcome.skipped).toBe(true);
    expect(fixture.requests.length).toBe(requests);
    const row = await runRow(done.id);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.attempts).toBe(0);
    await db.delete(auditRuns).where(eq(auditRuns.id, done.id));
  });

  it("records a heartbeat, and a second run queues no fix twice", async () => {
    const first = await newRun();
    const a = await analyze(first.id);
    expect(a.skipped).toBe(false);
    const row = await runRow(first.id);
    expect(row.status).toBe("SUCCEEDED");
    expect(row.heartbeatAt).toBeTruthy();
    expect(row.attempts).toBe(1);

    const openStatuses = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "APPLYING"] as const;
    const openKeys = async () => {
      const open = await db
        .select()
        .from(fixProposals)
        .where(and(eq(fixProposals.projectId, projectId), inArray(fixProposals.status, [...openStatuses])));
      return open.flatMap((p) =>
        (p.changes as Array<{ url: string; selector?: string }>).map((c) =>
          JSON.stringify([p.ruleId, p.action, c.url, c.selector ?? null]),
        ),
      );
    };
    const afterFirst = await openKeys();
    expect(afterFirst.length).toBeGreaterThan(0);

    const second = await newRun();
    const b = await analyze(second.id);
    expect(b.proposals).toBe(0);
    const afterSecond = await openKeys();
    expect(afterSecond.length).toBe(afterFirst.length);
    expect(new Set(afterSecond).size).toBe(afterSecond.length);
  }, 120_000);
});

describe("markRunFailed", () => {
  it("puts a run with retries left back in the queue, keeping its slot and the error", async () => {
    const run = await newRun("RUNNING");
    const res = await markRunFailed(run.id, new Error("socket hang up"), false);
    expect(res.final).toBe(false);
    const row = await runRow(run.id);
    expect(row.status).toBe("QUEUED");
    expect(row.error).toBe("socket hang up");
    expect(row.finishedAt).toBeNull();
    // Still the project's active run.
    expect((await scanService.activeRun(projectId))?.id).toBe(run.id);

    await markRunFailed(run.id, new Error("still down"), true);
    const dead = await runRow(run.id);
    expect(dead.status).toBe("DEAD_LETTER");
    expect(dead.errorCode).toBe("RETRIES_EXHAUSTED");
    expect(dead.finishedAt).toBeTruthy();
  });

  it("ends a run at once when the address is refused", async () => {
    const run = await newRun("RUNNING");
    const err = new BlockedAddressError("10.0.0.1", "private or reserved address");
    expect(isPermanentFailure(err)).toBe(true);
    const res = await markRunFailed(run.id, err, false);
    expect(res.final).toBe(true);
    const row = await runRow(run.id);
    expect(row.status).toBe("DEAD_LETTER");
    expect(row.errorCode).toBe("BLOCKED_ADDRESS");
    expect(row.error).toMatch(/not a public address/);
  });

  it("leaves a finished run alone", async () => {
    const run = await newRun("SUCCEEDED");
    await markRunFailed(run.id, new Error("late failure"), true);
    expect((await runRow(run.id)).status).toBe("SUCCEEDED");
  });
});
