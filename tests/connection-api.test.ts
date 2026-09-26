/**
 * The connection, edge, platform, fix-pack and Search Console API routes,
 * called as Next route handlers against real Postgres and Redis and the
 * Cloudflare API double.
 *
 * What must hold: the overview recommends from the detected platform and
 * speaks the viewer's language; the write target cannot be pointed at
 * something unconnected; every new action is permission-checked and audited;
 * downloads are real zips; token material never comes back.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { strFromU8, unzipSync } from "fflate";
import { and, auditLog, closeDb, connectors, db, eq, memberships, organizations, projects, purgeOrganization, users } from "@seo/db";
import { closeQueues, closeRedis, hashPassword, hashToken, redisCommand, seal } from "@seo/core";
import { FAKE_CF_TOKEN, startFakeCloudflare, type FakeCf } from "./fake-cloudflare.js";

const jar = new Map<string, string>();
let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => requestHeaders,
}));

const { login } = await import("../apps/web/src/lib/auth");
const connectionRoute = await import("../apps/web/src/app/api/projects/[id]/connection/route");
const edgeRoute = await import("../apps/web/src/app/api/projects/[id]/connection/edge/route");
const checkRoute = await import("../apps/web/src/app/api/projects/[id]/connection/check/route");
const pluginRoute = await import("../apps/web/src/app/api/projects/[id]/connection/bridge-plugin/route");
const platformRoute = await import("../apps/web/src/app/api/projects/[id]/platform/route");
const fixPackRoute = await import("../apps/web/src/app/api/projects/[id]/fix-pack/route");
const sitemapRoute = await import("../apps/web/src/app/api/projects/[id]/search-console/sitemaps/route");
const connectorRoute = await import("../apps/web/src/app/api/connectors/[kind]/route");

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
function call(fn: Handler, method: string, path: string, opts: { body?: unknown; params?: Record<string, string>; locale?: string } = {}) {
  const headers = new Headers({ host: "app.example", "sec-fetch-site": "same-origin" });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`);
  if (opts.locale) cookie.push(`locale=${opts.locale}`);
  if (cookie.length) headers.set("cookie", cookie.join("; "));
  const req = new NextRequest(new URL(path, "http://app.example"), {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return fn(req, { params: Promise.resolve(opts.params ?? {}) });
}

const stamp = Date.now();
const password = "correct horse battery staple";
const admin = `p1-admin-${stamp}@example.test`;
const viewer = `p1-viewer-${stamp}@example.test`;
let orgId: string;
let projectId: string;
let cf: FakeCf;
let site: Server;
const userIds: string[] = [];

async function signIn(email: string) {
  jar.clear();
  requestHeaders = new Headers({ "x-real-ip": "203.0.113.50" });
  const res = await login(email, password);
  expect(res.ok).toBe(true);
}

const p = () => ({ params: { id: projectId } });
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const audits = (action: string) => db.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action)));

beforeAll(async () => {
  cf = await startFakeCloudflare();
  site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "cf-ray": "1-FRA", server: "cloudflare" });
    res.end('<html><head><meta name="generator" content="WordPress 6.6"></head></html>');
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

  orgId = (await db.insert(organizations).values({ name: "P1 org", slug: `p1-${stamp}` }).returning())[0]!.id;
  for (const [email, role] of [[admin, "ADMIN"], [viewer, "VIEWER"]] as const) {
    const id = (await db.insert(users).values({ email, passwordHash: await hashPassword(password) }).returning())[0]!.id;
    userIds.push(id);
    await db.insert(memberships).values({ userId: id, orgId, role });
  }
  projectId = (await db.insert(projects).values({ orgId, name: "Shop", baseUrl: "https://shop.example.test/" }).returning())[0]!.id;
});

beforeEach(async () => {
  const redis = redisCommand();
  await redis.del(...[admin, viewer].map((e) => `loginfail:${hashToken(e)}`));
  const keys = await redis.keys("rls:auth:203.0.113.50*");
  if (keys.length) await redis.del(...keys);
});

afterAll(async () => {
  await new Promise<void>((r) => site.close(() => r()));
  await cf.close();
  await purgeOrganization(orgId);
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("connection overview", () => {
  it("says the platform is unknown and recommends nothing until it is detected", async () => {
    await signIn(admin);
    const body = await json(await call(connectionRoute.GET, "GET", "/x", { ...p(), locale: "en" }));
    expect(body.platform).toBeNull();
    expect(body.writeTarget).toEqual({ configured: null, effective: "WORDPRESS", source: "default" });
    expect(body.methods.map((m: { kind: string }) => m.kind)).toEqual(["CLOUDFLARE", "WORDPRESS", "WORDPRESS_BRIDGE", "FIX_PACK"]);
    expect(body.methods.some((m: { recommended: boolean }) => m.recommended)).toBe(false);
    expect(body.notes[0]).toMatch(/not been detected/);
  });

  it.each([
    [{ cms: "wordpress", seoPlugin: "rankmath", cdn: null }, "WORDPRESS"],
    [{ cms: "wordpress", seoPlugin: "yoast", cdn: null }, "WORDPRESS_BRIDGE"],
    [{ cms: "shopify", seoPlugin: null, cdn: null }, "FIX_PACK"],
    [{ cms: "wordpress", seoPlugin: "yoast", cdn: "cloudflare" }, "CLOUDFLARE"],
  ] as const)("recommends from the platform %j → %s", async (platform, kind) => {
    await db.update(projects).set({ platform: { ...platform, cmsVersion: null, server: null, detectedAt: new Date().toISOString() } }).where(eq(projects.id, projectId));
    await signIn(admin);
    const body = await json(await call(connectionRoute.GET, "GET", "/x", p()));
    expect(body.methods.filter((m: { recommended: boolean }) => m.recommended).map((m: { kind: string }) => m.kind)).toEqual([kind]);
    // Persian by default, with no English sentence leaking in.
    const recommended = body.methods.find((m: { recommended: boolean }) => m.recommended);
    expect(recommended.notes[0]).toMatch(/^پیشنهاد ما/);
    if (platform.cms === "shopify") expect(body.methods.find((m: { kind: string }) => m.kind === "WORDPRESS").status).toBe("not_applicable");
  });

  it("platform detection runs on demand and is stored", async () => {
    await db.update(projects).set({ baseUrl: `http://127.0.0.1:${(site.address() as { port: number }).port}/` }).where(eq(projects.id, projectId));
    try {
      await signIn(admin);
      const body = await json(await call(platformRoute.POST, "POST", "/x", p()));
      expect(body).toMatchObject({ ok: true, platform: { cms: "wordpress", cdn: "cloudflare" } });
      expect((await json(await call(platformRoute.GET, "GET", "/x", p()))).platform.cms).toBe("wordpress");
    } finally {
      await db.update(projects).set({ baseUrl: "https://shop.example.test/" }).where(eq(projects.id, projectId));
    }
  });
});

describe("write target", () => {
  it("refuses a target that is not connected, and a viewer cannot change it", async () => {
    await signIn(admin);
    const refused = await call(connectionRoute.PATCH, "PATCH", "/x", { ...p(), body: { writeTarget: "CLOUDFLARE" } });
    expect(refused.status).toBe(409);
    await signIn(viewer);
    expect((await call(connectionRoute.PATCH, "PATCH", "/x", { ...p(), body: { writeTarget: null } })).status).toBe(403);
  });

  it("is set once connected, and audited", async () => {
    const sealed = seal(JSON.stringify({ apiToken: FAKE_CF_TOKEN, siteUrl: "https://shop.example.test/", apiBase: cf.apiBase }));
    await db.insert(connectors).values({ projectId, kind: "CLOUDFLARE", status: "CONNECTED", secretCipher: sealed.cipher, secretIv: sealed.iv, secretTag: sealed.tag });
    await signIn(admin);
    const res = await call(connectionRoute.PATCH, "PATCH", "/x", { ...p(), body: { writeTarget: "CLOUDFLARE" } });
    expect(res.status).toBe(200);
    expect((await json(res)).writeTarget).toEqual({ configured: "CLOUDFLARE", effective: "CLOUDFLARE", source: "configured" });
    const [row] = await audits("project.write_target");
    expect(row!.metadata).toEqual({ from: null, to: "CLOUDFLARE" });
  });
});

describe("the edge worker", () => {
  it("installs, reports its status, shows up in the overview, and uninstalls — all audited", async () => {
    await signIn(admin);
    const installed = await json(await call(edgeRoute.POST, "POST", "/x", p()));
    expect(installed).toMatchObject({ ok: true, routes: expect.arrayContaining(["shop.example.test/*", "www.shop.example.test/*"]) });
    expect((await audits("connector.install_edge"))[0]!.metadata).toMatchObject({ ok: true });

    const status = await json(await call(edgeRoute.GET, "GET", "/x", p()));
    expect(status).toMatchObject({ ok: true, zone: "example.test", installed: true, outdated: false });

    const overview = await json(await call(connectionRoute.GET, "GET", "/x", { ...p(), locale: "en" }));
    const edge = overview.methods.find((m: { kind: string }) => m.kind === "CLOUDFLARE");
    expect(edge.status).toBe("connected");
    expect(edge.capabilities.supportedActions).toContain("REDIRECT");
    expect(JSON.stringify(overview)).not.toContain(FAKE_CF_TOKEN);

    const removed = await json(await call(edgeRoute.DELETE, "DELETE", "/x", p()));
    expect(removed).toMatchObject({ ok: true, scriptDeleted: true });
    const after = await json(await call(connectionRoute.GET, "GET", "/x", p()));
    expect(after.methods.find((m: { kind: string }) => m.kind === "CLOUDFLARE").status).toBe("needs_install");
    expect(await audits("connector.uninstall_edge")).toHaveLength(1);
  });

  it("an install Cloudflare refuses answers ok:false with the reason, in Persian", async () => {
    cf.scripts.set("someone-elses", { metadata: {}, modules: {} });
    cf.routes.push({ id: "theirs", zoneId: cf.zones[0]!.id, pattern: "shop.example.test/*", script: "someone-elses" });
    try {
      await signIn(admin);
      const body = await json(await call(edgeRoute.POST, "POST", "/x", p()));
      expect(body).toMatchObject({ ok: false, reason: "route_conflict" });
      expect(body.message).toMatch(/Worker دیگری/);
    } finally {
      cf.routes.splice(cf.routes.findIndex((r) => r.id === "theirs"), 1);
    }
  });

  it("re-checks a connector on demand and names a missing permission", async () => {
    await signIn(admin);
    cf.tokens.get(FAKE_CF_TOKEN)!.permissions.delete("kv");
    try {
      const body = await json(await call(checkRoute.POST, "POST", "/x", { ...p(), body: { kind: "CLOUDFLARE" }, locale: "en" }));
      expect(body).toMatchObject({ status: "ERROR", reason: "missing_permission", detail: { permission: "Account → Workers KV Storage → Edit" } });
      // The permission is marked as code (the panel sets it in a code span; Cloudflare's name is never translated).
      expect(body.message).toBe("The API token lacks this permission: `Account → Workers KV Storage → Edit`");
    } finally {
      cf.tokens.get(FAKE_CF_TOKEN)!.permissions.add("kv");
    }
    const ok = await json(await call(checkRoute.POST, "POST", "/x", { ...p(), body: { kind: "CLOUDFLARE" } }));
    expect(ok.status).toBe("CONNECTED");
  });
});

describe("downloads", () => {
  it("the fix pack lists and zips, and the download is audited", async () => {
    await signIn(viewer);
    const list = await json(await call(fixPackRoute.GET, "GET", "/x?list=1", p()));
    expect(list.files.map((f: { path: string }) => f.path)).toEqual(["README.md"]);
    const res = await call(fixPackRoute.GET, "GET", "/x", p());
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="seo-fix-pack-shop\.example\.test-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())))).toEqual(["README.md"]);
    expect(await audits("fixpack.download")).toHaveLength(1);
  });

  it("the bridge plugin is a zip WordPress can upload", async () => {
    await signIn(viewer);
    const res = await call(pluginRoute.GET, "GET", "/x", p());
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(strFromU8(entries["seo-table-bridge/seo-table-bridge.php"]!)).toMatch(/Plugin Name: SEO Table Bridge/);
  });
});

describe("guards", () => {
  it("a malformed Cloudflare token is refused before anything is called", async () => {
    await signIn(admin);
    const res = await call(connectorRoute.POST, "POST", `/api/connectors/CLOUDFLARE?projectId=${projectId}`, {
      params: { kind: "CLOUDFLARE" },
      body: { kind: "CLOUDFLARE", apiToken: "not a token!" },
    });
    expect(res.status).toBe(400);
  });

  it("Search Console actions need Search Console connected", async () => {
    await signIn(admin);
    const res = await call(sitemapRoute.POST, "POST", "/x", { ...p(), body: { sitemapUrl: "https://shop.example.test/sitemap.xml" } });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("CONNECTOR_NOT_CONNECTED");
  });
});

describe("audit sentences for the new actions", () => {
  it("every new action reads as a sentence in both languages", async () => {
    const { describeConnectionAction, connectorResultMessage, CONNECTOR_RESULT_CODES } = await import("../apps/web/src/lib/connector-messages");
    for (const action of ["connector.install_edge", "connector.uninstall_edge", "search_console.submit_sitemap", "project.write_target", "fixpack.download"]) {
      for (const meta of [{ ok: true, to: "CLOUDFLARE" }, { ok: false, to: null }]) {
        const fa = describeConnectionAction(action, meta, "fa")!;
        const en = describeConnectionAction(action, meta, "en")!;
        expect(fa, action).toMatch(/[؀-ۿ]/);
        expect(fa).not.toMatch(/[0-9]|\b[A-Z]{2,}(_[A-Z]+)+\b/);
        expect(en, action).not.toMatch(/[؀-ۿ]/);
      }
    }
    expect(describeConnectionAction("scan.enqueue", {}, "fa")).toBeNull();
    for (const code of Object.keys(CONNECTOR_RESULT_CODES)) {
      expect(connectorResultMessage(code, "fa")).toMatch(/[؀-ۿ]/);
      expect(connectorResultMessage(code, "en")).not.toMatch(/[؀-ۿ]/);
    }
  });
});
