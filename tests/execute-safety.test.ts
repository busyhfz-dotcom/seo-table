/**
 * Write safety for the WordPress connector and the fix executor, against the
 * WordPress double over real HTTP and a real database.
 *
 * What must hold:
 *   - a write lands on the post whose permalink IS the URL, or nowhere;
 *   - an image's alt is matched exactly, and changed where the page renders it;
 *   - two simultaneous applies write once;
 *   - the rollback snapshot comes from a real read, is stored before the write,
 *     and an unreadable value blocks the write;
 *   - rollback deletes what a fix added, and leaves alone what a person changed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { Conflict, closeQueues, closeRedis, seal } from "@seo/core";
import { execute, rollback } from "@seo/pipeline";
import { wordpress } from "@seo/connectors";
import { cacheKey } from "../packages/connectors/src/google-auth.js";
import { FAKE_WP_CREDENTIALS, startFakeWordPress, type FakeWp } from "./fake-wordpress.js";

const USER = { type: "USER" as const, id: "u1" };

let wp: FakeWp;
let orgId: string;
let projectId: string;

type ChangeIn = { url: string; field: string; before: string | null; after: string; selector?: string };

async function proposal(action: "META_REWRITE" | "REDIRECT" | "ALT_TEXT", changes: ChangeIn[]) {
  const restricted = action === "REDIRECT";
  const row = (
    await db
      .insert(fixProposals)
      .values({
        projectId,
        ruleId: "test.rule",
        action,
        risk: restricted ? "RESTRICTED" : "LOW",
        status: restricted ? "APPROVED" : "DRAFT",
        title: "test",
        targetCount: changes.length,
        changes,
      })
      .returning()
  )[0]!;
  if (restricted) {
    await db.insert(approvals).values({
      fixProposalId: row.id,
      decision: "APPROVED",
      requestedBy: "agent",
      decidedById: "admin",
      decidedAt: new Date(),
    });
  }
  return row;
}

/** Dry run, then apply: the order the policy demands. */
async function dryThenApply(id: string) {
  await execute({ proposalId: id, dryRun: true, actor: USER });
  return execute({ proposalId: id, dryRun: false, actor: USER });
}

const statusOf = async (id: string) =>
  (await db.select().from(fixProposals).where(eq(fixProposals.id, id)))[0]!.status;

beforeAll(async () => {
  wp = await startFakeWordPress({ bridge: true, frontPageId: 16 });
  orgId = (await db.insert(organizations).values({ name: "Safety org", slug: `safety-${Date.now()}` }).returning())[0]!.id;
  projectId = (await db.insert(projects).values({ orgId, name: "WP", baseUrl: wp.baseUrl }).returning())[0]!.id;
  const sealed = seal(JSON.stringify({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS }));
  await db.insert(connectors).values({
    projectId,
    kind: "WORDPRESS",
    status: "CONNECTED",
    secretCipher: sealed.cipher,
    secretIv: sealed.iv,
    secretTag: sealed.tag,
  });
});

beforeEach(() => {
  wp.knobs.failSeoReads = false;
  wp.knobs.writeDelayMs = 0;
  wp.knobs.misresolve.clear();
});

afterAll(async () => {
  await wp.close();
  await purgeOrganization(orgId);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

// ---------------------------------------------------------------------------

describe("resolving a URL to a post", () => {
  const client = () => wordpress({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS });
  const writeMeta = (path: string, value = "desc") =>
    client().write!({ url: `${wp.baseUrl}${path}`, field: "meta_description", before: null, after: value });

  it("writes to the post whose permalink is the URL (bridge)", async () => {
    expect((await writeMeta("/careers/team", "careers")).ok).toBe(true);
    expect(wp.seo.get(15)?.meta_description).toBe("careers");
    expect(wp.seo.get(14)?.meta_description).toBeUndefined();

    expect((await writeMeta("/product/shoe/", "shoe")).ok).toBe(true);
    expect(wp.seo.get(31)?.meta_description).toBe("shoe");

    expect((await writeMeta(`/2024/${encodeURIComponent("کفش-دویدن")}/`, "کفش")).ok).toBe(true);
    expect(wp.seo.get(22)?.meta_description).toBe("کفش");

    // The front page, which only WordPress itself can resolve.
    expect((await writeMeta("/", "home")).ok).toBe(true);
    expect(wp.seo.get(16)?.meta_description).toBe("home");
  });

  it("refuses when the resolved post's link is not the URL", async () => {
    wp.knobs.misresolve.set("/p/1204", 12);
    const before = wp.writes.length;
    const res = await writeMeta("/p/1204");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("post_url_mismatch");
    expect(wp.writes.length).toBe(before);
  });

  it("refuses a URL on another site", async () => {
    const res = await client().write!({ url: "https://other.example/p/1204", field: "meta_description", before: null, after: "x" });
    expect(res.code).toBe("url_outside_site");
  });

  it("without the bridge, resolves by slug and full path, never by search", async () => {
    const plain = await startFakeWordPress({ bridge: false });
    try {
      const c = wordpress({ siteUrl: plain.baseUrl, ...FAKE_WP_CREDENTIALS });
      const team = `${plain.baseUrl}/wp-content/uploads/team.jpg`;

      const ok = await c.write!({ url: `${plain.baseUrl}/careers/team/`, field: "img.alt", before: null, after: "the team", selector: team });
      expect(ok.ok).toBe(true);
      expect(plain.posts.find((p) => p.id === 15)!.content).toContain('alt="the team"');
      expect(plain.posts.find((p) => p.id === 14)!.content).not.toContain("alt=");

      // Same slug, different parent: no post has this address, so nothing is written.
      const before = plain.writes.length;
      const wrong = await c.read!({ url: `${plain.baseUrl}/elsewhere/team/`, field: "img.alt", selector: team }).catch((e: Error & { code?: string }) => e.code);
      expect(wrong).toBe("media_not_found");
      expect(plain.writes.length).toBe(before);
    } finally {
      await plain.close();
    }
  });

  it("without the bridge, does not advertise title rewrites (they would change the visible post title)", async () => {
    const plain = await startFakeWordPress({ bridge: false });
    try {
      const caps = await wordpress({ siteUrl: plain.baseUrl, ...FAKE_WP_CREDENTIALS }).capabilities();
      expect(caps.supportedActions).toEqual(["ALT_TEXT"]);
    } finally {
      await plain.close();
    }
  });

  it("treats an outdated bridge as absent", async () => {
    const old = await startFakeWordPress({ bridge: true, bridgeVersion: "0.4.0" });
    try {
      const caps = await wordpress({ siteUrl: old.baseUrl, ...FAKE_WP_CREDENTIALS }).capabilities();
      expect(caps.supportedActions).not.toContain("META_REWRITE");
      expect(caps.supportedActions).not.toContain("REDIRECT");
      expect(caps.notes.join(" ")).toMatch(/outdated/);
    } finally {
      await old.close();
    }
  });
});

describe("image alt text", () => {
  const client = () => wordpress({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS });
  const uploads = () => `${wp.baseUrl}/wp-content/uploads`;

  it("matches a resized file exactly, never by substring or first result", async () => {
    const res = await client().write!({
      url: `${wp.baseUrl}/no-such-page/`,
      field: "img.alt",
      before: null,
      after: "resized",
      selector: `${uploads()}/1204-300x200.webp`,
    });
    expect(res.ok).toBe(true);
    expect(wp.media.get(501)?.alt_text).toBe("resized");
    expect(wp.media.get(503)?.alt_text).toBe("");

    const before = wp.writes.length;
    const miss = await client().write!({
      url: `${wp.baseUrl}/no-such-page/`,
      field: "img.alt",
      before: null,
      after: "x",
      selector: `${uploads()}/1204-999x999.webp`,
    });
    expect(miss.code).toBe("media_not_found");
    expect(wp.writes.length).toBe(before);
    wp.media.get(501)!.alt_text = "";
  });

  it("changes the alt in the post content, where the page renders it", async () => {
    const gallery = wp.posts.find((p) => p.id === 41)!;
    const original = gallery.content;
    const req = { url: `${wp.baseUrl}/gallery/`, field: "img.alt", selector: `${uploads()}/hero-1024x768.jpg` };

    expect(await client().read!(req)).toBeNull();
    const res = await client().write!({ ...req, before: null, after: 'Hero "shot" & more' });
    expect(res.ok).toBe(true);
    expect(gallery.content).toContain('alt="Hero &quot;shot&quot; &amp; more"');
    expect(gallery.content).toContain('alt="keep me"');
    expect(await client().read!(req)).toBe('Hero "shot" & more');
    // The media library item is not what the page shows, so it is untouched.
    expect(wp.media.get(601)?.alt_text).toBe("media library alt");

    // Deleting restores the tag byte for byte.
    await client().write!({ ...req, before: null, after: null });
    expect(gallery.content).toBe(original);
  });
});

describe("connector transport", () => {
  it("reports a redirected REST API instead of following it", async () => {
    const moved = await startFakeWordPress({ bridge: true, mode: "moved" });
    try {
      const res = await wordpress({ siteUrl: moved.baseUrl, ...FAKE_WP_CREDENTIALS }).check();
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("redirected");
      expect(res.message).toMatch(/elsewhere\.example/);
    } finally {
      await moved.close();
    }
  });

  it("refuses a private address", async () => {
    const saved = process.env.ALLOW_PRIVATE_NETWORK;
    process.env.ALLOW_PRIVATE_NETWORK = "0";
    try {
      const res = await wordpress({ siteUrl: wp.baseUrl, ...FAKE_WP_CREDENTIALS }).check();
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("blocked_address");
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = saved;
    }
  });

  it("keys cached Google tokens by the whole credential", () => {
    const a = { type: "oauth_refresh" as const, client_id: "c", client_secret: "s", refresh_token: "user-a" };
    const b = { ...a, refresh_token: "user-b" };
    expect(cacheKey(a, ["x"])).not.toBe(cacheKey(b, ["x"]));
    expect(cacheKey(a, ["x"])).toBe(cacheKey({ ...a }, ["x"]));
    expect(cacheKey(a, ["x"])).not.toContain("user-a");
    const sa = { type: "service_account" as const, client_email: "e", private_key: "k" };
    expect(cacheKey(sa, ["x"])).not.toBe(cacheKey({ ...sa, subject: "boss@example.com" }, ["x"]));
  });
});

// ---------------------------------------------------------------------------

describe("apply", () => {
  it("two simultaneous applies write once", async () => {
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/about/`, field: "meta_description", before: null, after: "about us" },
    ]);
    await execute({ proposalId: p.id, dryRun: true, actor: USER });
    wp.knobs.writeDelayMs = 200;
    const before = wp.writes.length;

    const [a, b] = await Promise.allSettled([
      execute({ proposalId: p.id, dryRun: false, actor: USER }),
      execute({ proposalId: p.id, dryRun: false, actor: USER }),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(Conflict);
    expect(wp.writes.length - before).toBe(1);
    expect(await statusOf(p.id)).toBe("APPLIED");
  });

  it("stores the snapshot before the write goes out", async () => {
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/2024/hello/`, field: "meta_description", before: null, after: "hello" },
    ]);
    await execute({ proposalId: p.id, dryRun: true, actor: USER });
    wp.knobs.writeDelayMs = 400;
    const running = execute({ proposalId: p.id, dryRun: false, actor: USER });

    // While the site is still answering the write, the entry is already stored.
    await new Promise((r) => setTimeout(r, 250));
    const live = (await db.select().from(fixExecutions).where(eq(fixExecutions.fixProposalId, p.id))).find((e) => !e.dryRun);
    expect(live?.status).toBe("APPLYING");
    expect(live?.snapshot).toEqual([
      { url: `${wp.baseUrl}/2024/hello/`, field: "meta_description", previous: null, applied: "hello", state: "pending" },
    ]);

    await running;
    const done = (await db.select().from(fixExecutions).where(eq(fixExecutions.id, live!.id)))[0]!;
    expect((done.snapshot as Array<{ state: string }>)[0]?.state).toBe("written");
  });

  it("refuses to write a value it could not read, and stays retryable", async () => {
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/p/1205`, field: "meta_description", before: null, after: "retry me" },
    ]);
    await execute({ proposalId: p.id, dryRun: true, actor: USER });

    wp.knobs.failSeoReads = true;
    const before = wp.writes.length;
    const out = await execute({ proposalId: p.id, dryRun: false, actor: USER });
    expect(out.applied).toBe(0);
    expect(out.results[0]?.code).toBe("unreadable");
    expect(wp.writes.length).toBe(before);
    expect(await statusOf(p.id)).toBe("FAILED");

    wp.knobs.failSeoReads = false;
    const retry = await execute({ proposalId: p.id, dryRun: false, actor: USER });
    expect(retry.status).toBe("APPLIED");
    expect(wp.seo.get(12)?.meta_description).toBe("retry me");
  });

  it("a field scanned as empty must still be empty: drift shows in the dry run and blocks the write", async () => {
    wp.seo.set(21, { meta_description: "written by a person" });
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/2024/hello/`, field: "meta_description", before: null, after: "ours" },
    ]);
    const dry = await execute({ proposalId: p.id, dryRun: true, actor: USER });
    expect(dry.applied).toBe(0);
    expect(dry.results[0]?.code).toBe("changed_since_scan");

    const live = await execute({ proposalId: p.id, dryRun: false, actor: USER });
    expect(live.results[0]?.code).toBe("changed_since_scan");
    expect(wp.seo.get(21)?.meta_description).toBe("written by a person");
    expect(await statusOf(p.id)).toBe("FAILED");
  });

  it("a partial failure is FAILED, and a retry finishes only what is left", async () => {
    wp.seo.set(14, { meta_description: "edited" });
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/careers/team/`, field: "meta_description", before: "careers", after: "join us" },
      { url: `${wp.baseUrl}/about/team/`, field: "meta_description", before: null, after: "meet us" },
    ]);
    await execute({ proposalId: p.id, dryRun: true, actor: USER });
    const first = await execute({ proposalId: p.id, dryRun: false, actor: USER });
    expect([first.applied, first.failed, first.status]).toEqual([1, 1, "FAILED"]);
    expect(await statusOf(p.id)).toBe("FAILED");

    wp.seo.set(14, {});
    const writes = wp.writes.length;
    const second = await execute({ proposalId: p.id, dryRun: false, actor: USER });
    expect(second.status).toBe("APPLIED");
    expect(second.results.map((r) => r.code ?? "written")).toEqual(["already_applied", "written"]);
    expect(wp.writes.length - writes).toBe(1);
  });
});

describe("rollback", () => {
  it("removes a redirect the fix added", async () => {
    const p = await proposal("REDIRECT", [
      { url: `${wp.baseUrl}/old-shoes`, field: "redirect", before: null, after: `${wp.baseUrl}/shop` },
    ]);
    const out = await dryThenApply(p.id);
    expect(out.applied).toBe(1);
    expect(wp.redirects.get("/old-shoes")).toBe(`${wp.baseUrl}/shop`);

    const back = await rollback({ executionId: out.executionId, actor: USER });
    expect(back.status).toBe("ROLLED_BACK");
    expect(wp.redirects.has("/old-shoes")).toBe(false);
    expect(await statusOf(p.id)).toBe("ROLLED_BACK");

    await expect(rollback({ executionId: out.executionId, actor: USER })).rejects.toThrow(/already rolled back/);
  });

  it("removes a meta description the fix added", async () => {
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/product/shoe`, field: "meta_description", before: "shoe", after: "a better shoe" },
    ]);
    wp.seo.set(31, {});
    const out = await dryThenApply(p.id);
    expect(wp.seo.get(31)?.meta_description).toBe("a better shoe");
    await rollback({ executionId: out.executionId, actor: USER });
    expect(wp.seo.get(31)).not.toHaveProperty("meta_description");
  });

  it("leaves a value a person changed after the apply, and does not claim success", async () => {
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/about`, field: "meta_description", before: null, after: "ours" },
    ]);
    wp.seo.set(13, {});
    const out = await dryThenApply(p.id);
    wp.seo.set(13, { meta_description: "a person's edit" });

    const back = await rollback({ executionId: out.executionId, actor: USER });
    expect(back.failed).toBe(1);
    expect(back.results[0]?.code).toBe("changed_since_apply");
    expect(wp.seo.get(13)?.meta_description).toBe("a person's edit");

    const exec = (await db.select().from(fixExecutions).where(eq(fixExecutions.id, out.executionId)))[0]!;
    expect(exec.status).toBe("APPLIED");
    expect(exec.rolledBackAt).toBeNull();
    expect(await statusOf(p.id)).toBe("APPLIED");
  });

  it("two simultaneous rollbacks restore once", async () => {
    const p = await proposal("META_REWRITE", [
      { url: `${wp.baseUrl}/gallery`, field: "meta_description", before: null, after: "pictures" },
    ]);
    const out = await dryThenApply(p.id);
    wp.knobs.writeDelayMs = 200;
    const [a, b] = await Promise.allSettled([
      rollback({ executionId: out.executionId, actor: USER }),
      rollback({ executionId: out.executionId, actor: USER }),
    ]);
    expect([a, b].filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(wp.seo.get(41)).not.toHaveProperty("meta_description");
  });
});
