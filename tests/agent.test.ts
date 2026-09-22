/**
 * Agent mode and the fix executor, against a WordPress double over real HTTP.
 *
 * What must hold:
 *   - a LOW-risk fix is dry-run, then applied, and the site really changes;
 *   - rollback restores exactly the value recorded before the write;
 *   - the agent never touches a SENSITIVE or RESTRICTED proposal;
 *   - a restricted redirect cannot execute even when the site could perform it,
 *     until a person approves it — and then it can;
 *   - a write the site cannot perform is reported as unsupported, not faked;
 *   - credentials are stored sealed, never in plaintext.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  closeDb,
  connectors,
  db,
  eq,
  fixExecutions,
  fixProposals,
  organizations,
  projects,
  purgeOrganization,
} from "@seo/db";
import { closeQueues, closeRedis, proposalService, seal } from "@seo/core";
import { execute, rollback, runAgent } from "@seo/pipeline";
import { wordpress } from "@seo/connectors";
import { FAKE_WP_CREDENTIALS, startFakeWordPress, type FakeWp } from "./fake-wordpress.js";

let wp: FakeWp;
let orgId: string;
let projectId: string;

async function proposal(values: Partial<typeof fixProposals.$inferInsert> & Pick<typeof fixProposals.$inferInsert, "action" | "risk" | "changes">) {
  return (
    await db
      .insert(fixProposals)
      .values({
        projectId,
        ruleId: "test.rule",
        status: "DRAFT",
        title: "test",
        targetCount: (values.changes as unknown[]).length,
        ...values,
      })
      .returning()
  )[0]!;
}

beforeAll(async () => {
  wp = await startFakeWordPress({ bridge: true });

  orgId = (await db.insert(organizations).values({ name: "Agent org", slug: `agent-${Date.now()}` }).returning())[0]!.id;
  projectId = (
    await db
      .insert(projects)
      .values({ orgId, name: "WP site", baseUrl: wp.baseUrl })
      .returning()
  )[0]!.id;

  const creds = { siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS };
  const sealed = seal(JSON.stringify(creds));
  await db.insert(connectors).values({
    projectId,
    kind: "WORDPRESS",
    status: "CONNECTED",
    secretCipher: sealed.cipher,
    secretIv: sealed.iv,
    secretTag: sealed.tag,
  });
});

afterAll(async () => {
  await wp.close();
  await purgeOrganization(orgId);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("wordpress connector", () => {
  it("rejects a wrong application password", async () => {
    const bad = wordpress({ siteUrl: wp.baseUrl, username: "seo-bot", applicationPassword: "nope nope nope" });
    const res = await bad.check();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid_credentials");
  });

  it.each([
    ["blockUsers", true, undefined],
    ["stripAuth", false, "credentials_not_received"],
    ["waf", false, "firewall_blocked"],
    ["subscriber", false, "insufficient_role"],
  ] as const)("explains a %s site precisely", async (mode, ok, reason) => {
    const site = await startFakeWordPress({ bridge: true, mode });
    try {
      const res = await wordpress({ siteUrl: site.baseUrl, ...FAKE_WP_CREDENTIALS }).check();
      expect(res.ok).toBe(ok);
      if (reason) expect(res.reason).toBe(reason);
      if (mode === "blockUsers") expect(res.capabilities?.notes.join(" ")).toMatch(/users endpoint/);
    } finally {
      await site.close();
    }
  });

  it("probes what the site supports", async () => {
    const client = wordpress({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS });
    const res = await client.check();
    expect(res.ok).toBe(true);
    expect(res.capabilities?.supportedActions).toEqual(
      expect.arrayContaining(["ALT_TEXT", "META_REWRITE", "REDIRECT"]),
    );
  });

  it("without the bridge plugin, reports SEO fields as unsupported instead of pretending", async () => {
    const plain = await startFakeWordPress({ bridge: false });
    try {
      const client = wordpress({ siteUrl: plain.baseUrl, ...FAKE_WP_CREDENTIALS });
      const caps = await client.capabilities();
      expect(caps.supportedActions).not.toContain("META_REWRITE");
      expect(caps.supportedActions).not.toContain("REDIRECT");

      const res = await client.write!({
        url: `${plain.baseUrl}/p/1204`,
        field: "meta_description",
        before: null,
        after: "x",
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("unsupported_field");
      expect(plain.writes).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });

  it("stores credentials sealed, never in plaintext", async () => {
    const [row] = await db.select().from(connectors).where(eq(connectors.projectId, projectId));
    expect(row?.secretCipher).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(FAKE_WP_CREDENTIALS.applicationPassword);
  });
});

describe("low-risk fix: dry run, apply, rollback", () => {
  let proposalId: string;

  it("a live apply is refused before a dry run exists", async () => {
    const p = await proposal({
      action: "ALT_TEXT",
      risk: "LOW",
      changes: [
        {
          url: `${wp.baseUrl}/p/1204`,
          field: "img.alt",
          before: null,
          after: "کتانی دویدن مردانه ۱۲۰۴",
          selector: `${wp.baseUrl}/wp-content/uploads/1204.webp`,
        },
      ],
    });
    proposalId = p.id;
    await expect(
      execute({ proposalId, dryRun: false, actor: { type: "USER", id: "u1" } }),
    ).rejects.toThrow(/dry_run_required/);
    expect(wp.writes).toHaveLength(0);
  });

  it("the dry run writes nothing", async () => {
    const out = await execute({ proposalId, dryRun: true, actor: { type: "USER", id: "u1" } });
    expect(out.applied).toBe(1);
    expect(wp.writes).toHaveLength(0);
    expect(wp.media.get(501)?.alt_text).toBe("");
  });

  it("the live apply changes the site and records what it replaced", async () => {
    const out = await execute({ proposalId, dryRun: false, actor: { type: "USER", id: "u1" } });
    expect(out.applied).toBe(1);
    expect(wp.media.get(501)?.alt_text).toBe("کتانی دویدن مردانه ۱۲۰۴");

    const [row] = await db.select().from(fixProposals).where(eq(fixProposals.id, proposalId));
    expect(row?.status).toBe("APPLIED");

    const [exec] = await db
      .select()
      .from(fixExecutions)
      .where(eq(fixExecutions.id, out.executionId));
    expect((exec?.snapshot as Array<{ previous: string | null }>)[0]?.previous).toBe("");
  });

  it("applying twice is refused", async () => {
    await expect(
      execute({ proposalId, dryRun: false, actor: { type: "USER", id: "u1" } }),
    ).rejects.toThrow(/already been applied/);
  });

  it("rollback restores the previous value", async () => {
    const [exec] = await db
      .select()
      .from(fixExecutions)
      .where(eq(fixExecutions.fixProposalId, proposalId));
    const live = (
      await db.select().from(fixExecutions).where(eq(fixExecutions.fixProposalId, proposalId))
    ).find((e) => !e.dryRun)!;
    expect(exec).toBeTruthy();

    await rollback({ executionId: live.id, actor: { type: "USER", id: "u1" } });
    expect(wp.media.get(501)?.alt_text).toBe("");

    const [row] = await db.select().from(fixProposals).where(eq(fixProposals.id, proposalId));
    expect(row?.status).toBe("ROLLED_BACK");
  });
});

describe("agent mode", () => {
  it("auto-applies LOW risk and leaves SENSITIVE and RESTRICTED untouched", async () => {
    const low = await proposal({
      action: "ALT_TEXT",
      risk: "LOW",
      changes: [
        {
          url: `${wp.baseUrl}/p/1205`,
          field: "img.alt",
          before: null,
          after: "کتانی دویدن زنانه ۱۲۰۵",
          selector: `${wp.baseUrl}/wp-content/uploads/1205.webp`,
        },
      ],
    });

    const sensitive = await proposal({
      action: "TITLE_REWRITE",
      risk: "SENSITIVE",
      status: "AWAITING_APPROVAL",
      changes: [{ url: `${wp.baseUrl}/p/1205`, field: "title", before: "کتانی ۱۲۰۵", after: "عنوان جدید" }],
    });
    await db.insert(approvals).values({ fixProposalId: sensitive.id, requestedBy: "agent" });

    const restricted = await proposal({
      action: "REDIRECT",
      // Deliberately mislabelled as LOW: the policy must not believe it.
      risk: "LOW",
      changes: [{ url: `${wp.baseUrl}/old`, field: "redirect", before: null, after: `${wp.baseUrl}/new` }],
    });

    const writesBefore = wp.writes.length;
    const report = await runAgent(projectId);

    expect(wp.media.get(502)?.alt_text).toBe("کتانی دویدن زنانه ۱۲۰۵");
    expect(report.autoApplied).toBeGreaterThanOrEqual(1);

    // Nothing but the one alt-text write reached the site.
    const newWrites = wp.writes.slice(writesBefore);
    expect(newWrites.every((w) => w.path.startsWith("/wp-json/wp/v2/media/"))).toBe(true);
    expect(wp.redirects.size).toBe(0);

    const status = async (id: string) =>
      (await db.select().from(fixProposals).where(eq(fixProposals.id, id)))[0]!.status;
    expect(await status(low.id)).toBe("APPLIED");
    expect(await status(sensitive.id)).toBe("AWAITING_APPROVAL");
    expect(await status(restricted.id)).not.toBe("APPLIED");
  });

  it("a redirect runs only after a person approves it", async () => {
    const p = await proposal({
      action: "REDIRECT",
      risk: "RESTRICTED",
      status: "AWAITING_APPROVAL",
      changes: [{ url: `${wp.baseUrl}/legacy`, field: "redirect", before: null, after: `${wp.baseUrl}/shop` }],
    });
    await db.insert(approvals).values({ fixProposalId: p.id, requestedBy: "agent" });

    // Dry run is always allowed, and changes nothing.
    await execute({ proposalId: p.id, dryRun: true, actor: { type: "USER", id: "u1" } });
    expect(wp.redirects.size).toBe(0);

    await expect(
      execute({ proposalId: p.id, dryRun: false, actor: { type: "USER", id: "u1" } }),
    ).rejects.toThrow(/never run without human approval/);

    // The agent cannot grant it…
    await expect(
      proposalService.decide({ proposalId: p.id, orgId, actor: { type: "AGENT", id: "agent" }, approve: true }),
    ).rejects.toThrow(/Only a person/);

    // …a person can.
    await proposalService.decide({ proposalId: p.id, orgId, actor: { type: "USER", id: "admin-1" }, approve: true });
    const out = await execute({ proposalId: p.id, dryRun: false, actor: { type: "USER", id: "admin-1" } });
    expect(out.applied).toBe(1);
    expect(wp.redirects.get(`${wp.baseUrl}/legacy`)).toBe(`${wp.baseUrl}/shop`);
  });
});
