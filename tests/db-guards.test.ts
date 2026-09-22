/**
 * Database guards added in migration 0004: the approval trigger cannot be
 * bypassed by relabelling a proposal, TRUNCATE is refused on the ledgers, and
 * the new foreign keys do not stop an organization purge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  auditLog,
  auditRuns,
  closeDb,
  db,
  eq,
  fixProposals,
  issueOccurrences,
  memberships,
  organizations,
  pageSnapshots,
  pgError,
  pool,
  projects,
  purgeOrganization,
  seoIssues,
  sessions,
  users,
  type FixAction,
  type RiskLevel,
} from "@seo/db";

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const inner = pgError(err);
    expect(inner?.code).toBe("23001");
    expect(inner?.message ?? (err as Error).message).toMatch(pattern);
    return;
  }
  throw new Error(`expected the database to refuse the write (${pattern})`);
}

let orgId: string;
let projectId: string;

async function proposal(action: FixAction, risk: RiskLevel, status: "DRAFT" | "AWAITING_APPROVAL" = "AWAITING_APPROVAL") {
  return (
    await db
      .insert(fixProposals)
      .values({
        projectId,
        ruleId: "rule.test",
        action,
        risk,
        status,
        title: "t",
        targetCount: 1,
        changes: [{ url: "/a", field: "f", before: null, after: "b" }],
      })
      .returning()
  )[0]!;
}

beforeAll(async () => {
  orgId = (await db.insert(organizations).values({ name: "Guards", slug: `guards-${Date.now()}` }).returning())[0]!.id;
  projectId = (
    await db.insert(projects).values({ orgId, name: "p", baseUrl: "https://guards.example" }).returning()
  )[0]!.id;
});

afterAll(async () => {
  if (orgId) await purgeOrganization(orgId).catch(() => {});
  await closeDb();
});

describe("approval trigger (0004)", () => {
  it("raises a mislabelled risk to the action's floor on insert", async () => {
    const p = await proposal("REDIRECT", "LOW");
    expect(p.risk).toBe("RESTRICTED");
    const t = await proposal("TITLE_REWRITE", "LOW");
    expect(t.risk).toBe("SENSITIVE");
    const low = await proposal("ALT_TEXT", "LOW");
    expect(low.risk).toBe("LOW");
  });

  it("refuses lowering the risk, then applying", async () => {
    const p = await proposal("TITLE_REWRITE", "SENSITIVE");
    await refused(
      db.update(fixProposals).set({ risk: "LOW" }).where(eq(fixProposals.id, p.id)),
      /risk cannot be lowered/,
    );
    await refused(
      db.update(fixProposals).set({ risk: "LOW", status: "APPLIED" }).where(eq(fixProposals.id, p.id)),
      /risk cannot be lowered/,
    );
    await refused(
      db.update(fixProposals).set({ status: "APPLIED" }).where(eq(fixProposals.id, p.id)),
      /requires an approved approval/,
    );
  });

  it("refuses changing the action", async () => {
    const p = await proposal("META_REWRITE", "LOW", "DRAFT");
    await refused(
      db.update(fixProposals).set({ action: "ALT_TEXT" }).where(eq(fixProposals.id, p.id)),
      /action cannot change/,
    );
  });

  it("refuses a restricted action inserted directly as APPLIED", async () => {
    await refused(
      db.insert(fixProposals).values({
        projectId,
        ruleId: "rule.test",
        action: "URL_CHANGE",
        risk: "LOW",
        status: "APPLIED",
        title: "t",
        changes: [],
      }),
      /requires an approved approval/,
    );
  });

  it("still lets a LOW action apply without approval, and an approved one apply", async () => {
    const low = await proposal("ALT_TEXT", "LOW", "DRAFT");
    await db.update(fixProposals).set({ status: "APPLIED" }).where(eq(fixProposals.id, low.id));

    const r = await proposal("REDIRECT", "RESTRICTED");
    await db.insert(approvals).values({ fixProposalId: r.id, decision: "APPROVED", requestedBy: "a", decidedById: "u" });
    await db.update(fixProposals).set({ status: "APPLYING" }).where(eq(fixProposals.id, r.id));
    await db.update(fixProposals).set({ status: "APPLIED" }).where(eq(fixProposals.id, r.id));
  });
});

describe("TRUNCATE on the ledgers (0004)", () => {
  // Inside a transaction that is always rolled back: if the guard were missing
  // the test must not wipe the development database's history.
  for (const table of ["issue_occurrences", "audit_log"]) {
    it(`refuses TRUNCATE ${table}`, async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(client.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only; TRUNCATE is not permitted/);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  }
  it("refuses it even with the purge door open", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL seo.allow_purge = 'on'");
      await expect(client.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("foreign keys (0004)", () => {
  it("an occurrence must point at a real snapshot", async () => {
    const run = (await db.insert(auditRuns).values({ projectId, status: "SUCCEEDED", idempotencyKey: `fk-${Date.now()}` }).returning())[0]!;
    const issue = (
      await db
        .insert(seoIssues)
        .values({ projectId, ruleId: "r", fingerprint: `fk-${Date.now()}`, severity: "INFO", title: "t", category: "c" })
        .returning()
    )[0]!;
    await expect(
      db.insert(issueOccurrences).values({
        issueId: issue.id,
        auditRunId: run.id,
        pageSnapshotId: "does-not-exist",
        url: "/x",
        kind: "DETECTED",
        severity: "INFO",
      }),
    ).rejects.toSatisfy((err: unknown) => pgError(err)?.code === "23503");
  });

  it("purgeOrganization still erases everything, ledgers and new FKs included", async () => {
    const org = (await db.insert(organizations).values({ name: "Purge", slug: `purge-${Date.now()}` }).returning())[0]!;
    const user = (
      await db.insert(users).values({ email: `purge-${Date.now()}@e.ir`, passwordHash: "x" }).returning()
    )[0]!;
    await db.insert(memberships).values({ userId: user.id, orgId: org.id, role: "OWNER" });
    await db.insert(sessions).values({ tokenHash: `h-${Date.now()}`, userId: user.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) });
    const project = (await db.insert(projects).values({ orgId: org.id, name: "p", baseUrl: "https://purge.example" }).returning())[0]!;
    const run = (await db.insert(auditRuns).values({ projectId: project.id, status: "SUCCEEDED", idempotencyKey: "k" }).returning())[0]!;
    const snap = (
      await db
        .insert(pageSnapshots)
        .values({ auditRunId: run.id, projectId: project.id, url: "https://purge.example/", normalizedUrl: "https://purge.example/", statusCode: 200, contentHash: "h" })
        .returning()
    )[0]!;
    const issue = (
      await db
        .insert(seoIssues)
        .values({ projectId: project.id, ruleId: "r", fingerprint: "fp", severity: "SERIOUS", title: "t", category: "c" })
        .returning()
    )[0]!;
    await db.insert(issueOccurrences).values({ issueId: issue.id, auditRunId: run.id, pageSnapshotId: snap.id, url: snap.url, kind: "DETECTED", severity: "SERIOUS" });
    // An applied restricted fix linked to the issue: the cascade's SET NULL on
    // issue_id must not trip the approval trigger after its approval is gone.
    const fix = (
      await db
        .insert(fixProposals)
        .values({ projectId: project.id, issueId: issue.id, ruleId: "r", action: "REDIRECT", risk: "RESTRICTED", status: "AWAITING_APPROVAL", title: "t", changes: [] })
        .returning()
    )[0]!;
    await db.insert(approvals).values({ fixProposalId: fix.id, decision: "APPROVED", requestedBy: "a" });
    await db.update(fixProposals).set({ status: "APPLIED" }).where(eq(fixProposals.id, fix.id));
    await db.insert(auditLog).values({ orgId: org.id, actorType: "SYSTEM", action: "project.create" });

    await purgeOrganization(org.id);

    expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toHaveLength(0);
    expect(await db.select().from(issueOccurrences).where(eq(issueOccurrences.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(fixProposals).where(eq(fixProposals.id, fix.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.orgId, org.id))).toHaveLength(0);
    await db.delete(users).where(eq(users.id, user.id));
  });

  it("deleting an issue keeps its proposal, unlinked", async () => {
    const issue = (
      await db
        .insert(seoIssues)
        .values({ projectId, ruleId: "r", fingerprint: `unlink-${Date.now()}`, severity: "INFO", title: "t", category: "c" })
        .returning()
    )[0]!;
    const p = (
      await db
        .insert(fixProposals)
        .values({ projectId, issueId: issue.id, ruleId: "r", action: "ALT_TEXT", risk: "LOW", title: "t", changes: [] })
        .returning()
    )[0]!;
    await db.delete(seoIssues).where(eq(seoIssues.id, issue.id));
    const [after] = await db.select().from(fixProposals).where(eq(fixProposals.id, p.id));
    expect(after?.issueId).toBeNull();
  });
});
