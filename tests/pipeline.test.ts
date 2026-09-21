/**
 * End-to-end: a real HTTP fixture site, a real crawl, real Postgres writes.
 *
 * These tests assert the invariants that make v0.4 what it is, not just that the
 * code runs: one active run per project, replay-safe scan creation, append-only
 * occurrence history, and a database that refuses to execute a restricted fix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditRuns,
  db,
  eq,
  and,
  issueOccurrences,
  organizations,
  projects,
  seoIssues,
  fixProposals,
  approvals,
  pageSnapshots,
  closeDb,
  purgeOrganization,
  sql,
} from "@seo/db";
import {
  ScanAlreadyRunning,
  closeQueues,
  closeRedis,
  redis,
  scanService,
  ALWAYS_APPROVAL,
  effectiveRisk,
  evaluatePolicy,
} from "@seo/core";
import { analyze } from "@seo/pipeline";
import { pgError } from "@seo/db";

/**
 * Assert a database write was refused, matching the driver's own message — Drizzle
 * wraps it, so read the cause rather than the wrapper's "Failed query" text.
 */
async function refusedBy(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const inner = pgError(err);
    expect(inner?.message ?? (err as Error).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected the database to refuse the write (${pattern})`);
}
import { startFixture, type Fixture } from "./fixture-site.js";

let fixture: Fixture;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  fixture = await startFixture();

  const org = (
    await db
      .insert(organizations)
      .values({ name: "Test Org", slug: `test-${Date.now()}` })
      .returning()
  )[0]!;
  orgId = org.id;

  const project = (
    await db
      .insert(projects)
      .values({
        orgId,
        name: "Fixture site",
        baseUrl: fixture.baseUrl,
        locale: "fa",
        pageCap: 100,
        crawlRate: 50,
      })
      .returning()
  )[0]!;
  projectId = project.id;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  // The ledgers are append-only, so teardown goes through the explicit purge door.
  await purgeOrganization(orgId);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("scan creation", () => {
  it("returns the same run when the idempotency key is replayed", async () => {
    const key = `idem-${Date.now()}`;
    const first = await scanService.createScan({
      projectId,
      orgId,
      actor: { type: "USER", id: "u1" },
      idempotencyKey: key,
      bypassRateLimit: true,
    });
    const second = await scanService.createScan({
      projectId,
      orgId,
      actor: { type: "USER", id: "u1" },
      idempotencyKey: key,
      bypassRateLimit: true,
    });

    expect(second.replayed).toBe(true);
    expect(second.run.id).toBe(first.run.id);

    const runs = await db.select().from(auditRuns).where(eq(auditRuns.projectId, projectId));
    expect(runs).toHaveLength(1);
  });

  it("refuses a second scan while one is active", async () => {
    await expect(
      scanService.createScan({
        projectId,
        orgId,
        actor: { type: "USER", id: "u1" },
        idempotencyKey: `other-${Date.now()}`,
        bypassRateLimit: true,
      }),
    ).rejects.toBeInstanceOf(ScanAlreadyRunning);
  });

  it("the database itself rejects a second active run", async () => {
    // Bypassing the service entirely: the partial unique index is the real guard.
    await refusedBy(
      db.insert(auditRuns).values({
        projectId,
        status: "RUNNING",
        idempotencyKey: `direct-${Date.now()}`,
      }),
      /audit_runs_one_active_per_project/,
    );
  });
});

describe("analysis", () => {
  let runId: string;

  it("crawls the fixture site and scores it", async () => {
    const active = await scanService.activeRun(projectId);
    runId = active!.id;

    const outcome = await analyze(runId);

    expect(outcome.canceled).toBe(false);
    expect(outcome.pagesCrawled).toBeGreaterThan(8);
    // The site is deliberately broken, so a perfect score would mean the rules
    // are not running.
    expect(outcome.score).toBeGreaterThan(0);
    expect(outcome.score).toBeLessThan(90);

    const run = await scanService.getRun(runId);
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.finishedAt).toBeTruthy();
  }, 120_000);

  it("honours robots.txt", () => {
    expect(fixture.requests).toContain("/robots.txt");
    expect(fixture.requests).not.toContain("/private/secret");
  });

  it("never invents URLs it was not linked to", () => {
    expect(fixture.requests).not.toContain("/unlinked");
  });

  it("records each redirect as its own row and resolves the chain", async () => {
    const [start] = await db
      .select()
      .from(pageSnapshots)
      .where(
        and(
          eq(pageSnapshots.auditRunId, runId),
          eq(pageSnapshots.normalizedUrl, `${fixture.baseUrl}/old-shoes`),
        ),
      );
    expect(start?.statusCode).toBe(301);
    expect(start?.redirectTarget).toBe(`${fixture.baseUrl}/old-shoes-2`);

    // The chain includes the start, so three hops means four entries, ending at
    // the destination that actually answers 200.
    const chain = start?.redirectChain as string[];
    expect(chain).toEqual([
      `${fixture.baseUrl}/old-shoes`,
      `${fixture.baseUrl}/old-shoes-2`,
      `${fixture.baseUrl}/shoes-legacy`,
      `${fixture.baseUrl}/shop`,
    ]);

    // And the destination was crawled in its own right.
    const [dest] = await db
      .select()
      .from(pageSnapshots)
      .where(
        and(
          eq(pageSnapshots.auditRunId, runId),
          eq(pageSnapshots.normalizedUrl, `${fixture.baseUrl}/shop`),
        ),
      );
    expect(dest?.statusCode).toBe(200);
  });

  it("detects the defects the fixture was built with", async () => {
    const issues = await db.select().from(seoIssues).where(eq(seoIssues.projectId, projectId));
    const ruleIds = new Set(issues.map((i) => i.ruleId));

    for (const expected of [
      "rule.title.missing",
      "rule.title.duplicate",
      "rule.title.length",
      "rule.meta.missing",
      "rule.meta.length",
      "rule.h1.structure",
      "rule.canonical.missing",
      "rule.canonical.broken",
      "rule.index.noindex_linked",
      "rule.index.http_error",
      "rule.index.redirect_chain",
      "rule.sitemap.url_not_indexable",
      "rule.robots.blocks_sitemap_url",
      "rule.alt.missing",
      "rule.duplicate.content",
      "rule.links.depth",
      "rule.url.numeric_slug",
    ]) {
      expect(ruleIds, `missing ${expected}`).toContain(expected);
    }
  });

  it("writes an occurrence per affected url", async () => {
    const [issue] = await db
      .select()
      .from(seoIssues)
      .where(and(eq(seoIssues.projectId, projectId), eq(seoIssues.ruleId, "rule.title.duplicate")))
      .limit(1);
    const occ = await db
      .select()
      .from(issueOccurrences)
      .where(eq(issueOccurrences.issueId, issue!.id));
    expect(occ.length).toBeGreaterThanOrEqual(2);
    expect(occ.every((o) => o.kind === "DETECTED")).toBe(true);
  });
});

describe("append-only history", () => {
  it("rejects UPDATE on issue_occurrences", async () => {
    const [occ] = await db.select().from(issueOccurrences).limit(1);
    await refusedBy(
      db.update(issueOccurrences).set({ url: "tampered" }).where(eq(issueOccurrences.id, occ!.id)),
      /append-only/,
    );
  });

  it("rejects DELETE on issue_occurrences", async () => {
    const [occ] = await db.select().from(issueOccurrences).limit(1);
    await refusedBy(db.delete(issueOccurrences).where(eq(issueOccurrences.id, occ!.id)), /append-only/);
  });

  it("records a second run as PERSISTED rather than overwriting the first", async () => {
    const second = await scanService.createScan({
      projectId,
      orgId,
      actor: { type: "USER", id: "u1" },
      idempotencyKey: `second-${Date.now()}`,
      bypassRateLimit: true,
    });
    await analyze(second.run.id);

    const [issue] = await db
      .select()
      .from(seoIssues)
      .where(and(eq(seoIssues.projectId, projectId), eq(seoIssues.ruleId, "rule.title.duplicate")))
      .limit(1);
    const kinds = await db
      .select({ kind: issueOccurrences.kind })
      .from(issueOccurrences)
      .where(eq(issueOccurrences.issueId, issue!.id));

    expect(kinds.some((k) => k.kind === "DETECTED")).toBe(true);
    expect(kinds.some((k) => k.kind === "PERSISTED")).toBe(true);
  }, 120_000);
});

describe("execution safety policy", () => {
  it("classifies redirect, url change and merge as never-automatic", () => {
    for (const action of ALWAYS_APPROVAL) {
      expect(effectiveRisk(action)).toBe("RESTRICTED");
      const decision = evaluatePolicy({
        action,
        changeCount: 1,
        dryRun: false,
        approved: false,
        hasDryRunResult: true,
        actor: "AGENT",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain("restricted_action");
    }
  });

  it("cannot be downgraded by passing a lower risk", () => {
    expect(effectiveRisk("REDIRECT", "LOW")).toBe("RESTRICTED");
  });

  it("allows a low-risk fix for the agent once a dry run exists", () => {
    const decision = evaluatePolicy({
      action: "ALT_TEXT",
      changeCount: 5,
      dryRun: false,
      approved: false,
      hasDryRunResult: true,
      actor: "AGENT",
    });
    expect(decision.allowed).toBe(true);
  });

  it("requires a dry run before a live apply", () => {
    const decision = evaluatePolicy({
      action: "ALT_TEXT",
      changeCount: 5,
      dryRun: false,
      approved: false,
      hasDryRunResult: false,
      actor: "USER",
    });
    expect(decision.reasons).toContain("dry_run_required");
  });

  it("the database refuses to apply a restricted proposal without approval", async () => {
    const proposal = (
      await db
        .insert(fixProposals)
        .values({
          projectId,
          ruleId: "rule.index.redirect_chain",
          action: "REDIRECT",
          risk: "RESTRICTED",
          status: "AWAITING_APPROVAL",
          title: "Collapse a redirect chain",
          targetCount: 1,
          changes: [{ url: "/a", field: "redirect", before: "/a", after: "/b" }],
        })
        .returning()
    )[0]!;
    await db.insert(approvals).values({
      fixProposalId: proposal.id,
      decision: "PENDING",
      requestedBy: "agent",
    });

    await refusedBy(
      db.update(fixProposals).set({ status: "APPLIED" }).where(eq(fixProposals.id, proposal.id)),
      /requires an approved approval/,
    );

    // With approval recorded, the same transition is allowed.
    await db
      .update(approvals)
      .set({ decision: "APPROVED", decidedById: "u1", decidedAt: new Date() })
      .where(eq(approvals.fixProposalId, proposal.id));
    await expect(
      db.update(fixProposals).set({ status: "APPLIED" }).where(eq(fixProposals.id, proposal.id)),
    ).resolves.toBeDefined();
  });

  it("an agent cannot approve anything", async () => {
    const proposal = (
      await db
        .insert(fixProposals)
        .values({
          projectId,
          ruleId: "rule.title.duplicate",
          action: "TITLE_REWRITE",
          risk: "SENSITIVE",
          status: "AWAITING_APPROVAL",
          title: "Rewrite a title",
          targetCount: 1,
          changes: [{ url: "/x", field: "title", before: "a", after: "b" }],
        })
        .returning()
    )[0]!;
    await db.insert(approvals).values({
      fixProposalId: proposal.id,
      decision: "PENDING",
      requestedBy: "agent",
    });

    const { proposalService } = await import("@seo/core");
    await expect(
      proposalService.decide({
        proposalId: proposal.id,
        orgId,
        actor: { type: "AGENT", id: "agent" },
        approve: true,
      }),
    ).rejects.toThrow(/Only a person can approve/);
  });
});

describe("audit log", () => {
  it("is append-only and recorded the scan", async () => {
    const rows = await db.execute(
      sql`select action from audit_log where org_id = ${orgId} order by created_at`,
    );
    const actions = (rows.rows as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain("scan.enqueue");
    expect(actions).toContain("fix.propose");

    const [entry] = rows.rows as Array<{ action: string }>;
    expect(entry).toBeTruthy();
    await refusedBy(db.execute(sql`update audit_log set action = 'tampered' where org_id = ${orgId}`), /append-only/);

    // And a plain delete is refused too, without the purge flag.
    await refusedBy(db.execute(sql`delete from audit_log where org_id = ${orgId}`), /append-only/);
  });
});

describe("redis", () => {
  it("is reachable", async () => {
    expect(await redis.ping()).toBe("PONG");
  });
});

describe("concurrency", () => {
  it("five simultaneous scan requests produce exactly one run", async () => {
    const project = (
      await db
        .insert(projects)
        .values({ orgId, name: "Race", baseUrl: fixture.baseUrl, pageCap: 5, crawlRate: 50 })
        .returning()
    )[0]!;

    // Distinct keys, fired together: the pre-check cannot serialise these, so
    // whichever lose must lose at the partial unique index.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        scanService.createScan({
          projectId: project.id,
          orgId,
          actor: { type: "USER", id: "u1" },
          idempotencyKey: `race-${Date.now()}-${i}`,
          bypassRateLimit: true,
        }),
      ),
    );

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    for (const l of lost) expect(l.reason).toBeInstanceOf(ScanAlreadyRunning);

    const rows = await db.select().from(auditRuns).where(eq(auditRuns.projectId, project.id));
    expect(rows).toHaveLength(1);
  });
});
