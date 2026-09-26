/**
 * Fix execution through the Cloudflare edge, against the Cloudflare API double,
 * a live origin and a real database.
 *
 * What must hold:
 *   - the write target decides the connector (explicit setting, else the edge
 *     when connected, else WordPress), and the execution records it;
 *   - rollback goes through the connector the execution used, even after the
 *     project's target changed;
 *   - rollback removes the edge override instead of pinning the old text, so a
 *     later edit on the site shows through; a pre-existing override is put back;
 *   - an action the edge cannot perform fails honestly as unsupported_action.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  and,
  closeDb,
  connectors,
  db,
  eq,
  fixExecutions,
  fixProposals,
  organizations,
  projects,
  purgeOrganization,
  type FixAction,
} from "@seo/db";
import { closeQueues, closeRedis, seal } from "@seo/core";
import { execute, rollback, type SnapshotEntry } from "@seo/pipeline";
import { resolveWriteTarget } from "@seo/connectors";
import { MANIFEST_KEY, pageKey } from "../packages/connectors/src/edge/keys.js";
import { routeTestHostsToLocalhost } from "./dns-stub.js";
import { FAKE_CF_TOKEN, memoryKv, startFakeCloudflare, type FakeCf } from "./fake-cloudflare.js";
import { FAKE_WP_CREDENTIALS, startFakeWordPress, type FakeWp } from "./fake-wordpress.js";

const USER = { type: "USER" as const, id: "u1" };
const HOST = "shop.example.test";

let cf: FakeCf;
let kv: ReturnType<typeof memoryKv>;
let wp: FakeWp;
let site: Server;
let siteUrl: string;
let orgId: string;
let projectId: string;
/** What the site itself serves for the product page's description. */
let originDescription = "Origin description";

async function proposal(action: FixAction, changes: Array<{ url: string; field: string; before: string | null; after: string; selector?: string }>) {
  return (
    await db
      .insert(fixProposals)
      .values({ projectId, ruleId: "test.rule", action, risk: "LOW", status: "DRAFT", title: "t", targetCount: changes.length, changes })
      .returning()
  )[0]!;
}

async function dryThenApply(id: string) {
  await execute({ proposalId: id, dryRun: true, actor: USER });
  return execute({ proposalId: id, dryRun: false, actor: USER });
}

const edgeRow = () => and(eq(connectors.projectId, projectId), eq(connectors.kind, "CLOUDFLARE"));

const setTarget = (writeTarget: "WORDPRESS" | "CLOUDFLARE" | null) =>
  db.update(projects).set({ writeTarget }).where(eq(projects.id, projectId));

const rule = async (url: string) => {
  const raw = await kv.get(await pageKey(url));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

beforeAll(async () => {
  routeTestHostsToLocalhost();
  kv = memoryKv();
  cf = await startFakeCloudflare({ kv });
  wp = await startFakeWordPress();
  // The origin, as the panel reaches it through Cloudflare with the bypass
  // secret: the site's own HTML, never rewritten.
  site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><head><title>Shoe</title><meta name="description" content="${originDescription}"></head><body><h1>a</h1><h1>b</h1></body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://${HOST}:${(site.address() as { port: number }).port}`;

  orgId = (await db.insert(organizations).values({ name: "Edge org", slug: `edge-${Date.now()}` }).returning())[0]!.id;
  projectId = (await db.insert(projects).values({ orgId, name: "Edge", baseUrl: `${siteUrl}/` }).returning())[0]!.id;
  const edgeCreds = seal(JSON.stringify({ apiToken: FAKE_CF_TOKEN, siteUrl: `${siteUrl}/`, apiBase: cf.apiBase }));
  const wpCreds = seal(JSON.stringify({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS }));
  await db.insert(connectors).values([
    { projectId, kind: "CLOUDFLARE", status: "CONNECTED", secretCipher: edgeCreds.cipher, secretIv: edgeCreds.iv, secretTag: edgeCreds.tag },
    { projectId, kind: "WORDPRESS", status: "CONNECTED", secretCipher: wpCreds.cipher, secretIv: wpCreds.iv, secretTag: wpCreds.tag },
  ]);
  const { cloudflare } = await import("@seo/connectors");
  await cloudflare({ apiToken: FAKE_CF_TOKEN, siteUrl: `${siteUrl}/`, apiBase: cf.apiBase }).install();
});

beforeEach(async () => {
  originDescription = "Origin description";
  await setTarget(null);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => site.close(() => r()));
  await cf.close();
  await wp.close();
  await purgeOrganization(orgId);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("write target", () => {
  it("is the edge when Cloudflare is connected and nothing is configured", async () => {
    expect(await resolveWriteTarget(projectId)).toEqual({ kind: "CLOUDFLARE", configured: null, source: "cloudflare_connected" });
    await setTarget("WORDPRESS");
    expect(await resolveWriteTarget(projectId)).toEqual({ kind: "WORDPRESS", configured: "WORDPRESS", source: "configured" });
  });

  it("falls back to WordPress when the edge connector is not healthy", async () => {
    await db.update(connectors).set({ status: "ERROR" }).where(edgeRow());
    try {
      expect((await resolveWriteTarget(projectId)).kind).toBe("WORDPRESS");
    } finally {
      await db.update(connectors).set({ status: "CONNECTED" }).where(edgeRow());
    }
  });

  it("an explicit target that is not connected refuses to run rather than falling back", async () => {
    await setTarget("CLOUDFLARE");
    await db.update(connectors).set({ status: "NOT_CONNECTED" }).where(edgeRow());
    try {
      const p = await proposal("META_REWRITE", [{ url: `${siteUrl}/p`, field: "meta_description", before: "Origin description", after: "x" }]);
      await expect(execute({ proposalId: p.id, dryRun: true, actor: USER })).rejects.toMatchObject({ code: "CONNECTOR_NOT_CONNECTED" });
    } finally {
      await db.update(connectors).set({ status: "CONNECTED" }).where(edgeRow());
    }
  });
});

describe("apply and rollback at the edge", () => {
  it("applies through the edge, records it, and rollback removes the override", async () => {
    const url = `${siteUrl}/product/shoe`;
    const p = await proposal("META_REWRITE", [{ url, field: "meta_description", before: "Origin description", after: "Trimmed description" }]);
    const out = await dryThenApply(p.id);
    expect(out).toMatchObject({ status: "APPLIED", applied: 1, failed: 0 });
    expect(await rule(url)).toEqual({ description: "Trimmed description" });

    const execution = (await db.select().from(fixExecutions).where(eq(fixExecutions.id, out.executionId)))[0]!;
    expect(execution.connectorKind).toBe("CLOUDFLARE");
    expect((execution.snapshot as SnapshotEntry[])[0]).toMatchObject({ previous: "Origin description", restore: null, state: "written" });

    // The site's own text changes after the fix, and the project moves to WordPress.
    originDescription = "Edited in the CMS later";
    await setTarget("WORDPRESS");
    const undo = await rollback({ executionId: out.executionId, actor: USER });
    expect(undo).toMatchObject({ status: "ROLLED_BACK", failed: 0 });
    // Removed, not pinned to "Origin description": the CMS edit now shows through.
    expect(await rule(url)).toBeNull();
    expect(JSON.parse((await kv.get(MANIFEST_KEY))!).keys).not.toContain(await pageKey(url));
  });

  it("puts back an override that existed before the fix", async () => {
    const url = `${siteUrl}/product/hat`;
    await kv.put(await pageKey(url), JSON.stringify({ description: "Earlier edge text" }));
    const p = await proposal("META_REWRITE", [{ url, field: "meta_description", before: "Earlier edge text", after: "Newer" }]);
    const out = await dryThenApply(p.id);
    expect(out.applied).toBe(1);
    await rollback({ executionId: out.executionId, actor: USER });
    expect(await rule(url)).toEqual({ description: "Earlier edge text" });
  });

  it("skips a page whose value moved since the scan", async () => {
    const p = await proposal("META_REWRITE", [{ url: `${siteUrl}/moved`, field: "meta_description", before: "What the scan saw", after: "x" }]);
    const out = await dryThenApply(p.id);
    expect(out.results[0]).toMatchObject({ ok: false, code: "changed_since_scan" });
    expect(await rule(`${siteUrl}/moved`)).toBeNull();
  });

  it("an action the edge cannot perform fails as unsupported_action", async () => {
    const p = await proposal("H1_FIX", [{ url: `${siteUrl}/product/shoe`, field: "headings", before: "a | b", after: "h1: a · h2: b" }]);
    await db.update(fixProposals).set({ risk: "SENSITIVE" }).where(eq(fixProposals.id, p.id));
    const dry = await execute({ proposalId: p.id, dryRun: true, actor: USER });
    expect(dry.results[0]).toMatchObject({ ok: false, code: "unsupported_action" });
    expect(dry.results[0]!.error).toMatch(/^CLOUDFLARE cannot perform H1_FIX/);
  });

  it("an explicit WordPress target writes to WordPress and records it", async () => {
    await setTarget("WORDPRESS");
    const p = await proposal("META_REWRITE", [{ url: `${wp.baseUrl}/about/`, field: "meta_description", before: null, after: "x" }]);
    const dry = await execute({ proposalId: p.id, dryRun: true, actor: USER });
    const row = (await db.select().from(fixExecutions).where(eq(fixExecutions.id, dry.executionId)))[0]!;
    expect(row.connectorKind).toBe("WORDPRESS");
    // No bridge and no SEO plugin on this WordPress: honestly unsupported.
    expect(dry.results[0]).toMatchObject({ ok: false, code: "unsupported_action" });
  });
});
