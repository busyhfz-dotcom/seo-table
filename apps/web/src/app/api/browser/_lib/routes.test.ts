/**
 * /api/browser/* end to end in one process: the Next route handlers (session
 * auth, permissions, limits) → the real worker internal API → real Chromium →
 * a local page. `next/headers` is replaced by a cookie jar, as in lib/api.test.ts.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDb, db, eq, memberships, organizations, purgeOrganization, users } from "@seo/db";
import { closeQueues, closeRedis, hashPassword, redisCommand, resetEnvCache } from "@seo/core";
import { BrowserManager, internalToken as workerSideToken } from "@seo/browser";
import { browserApi } from "../../../../../../worker/src/browser-api";

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

const { login } = await import("../../../../lib/auth");
const { internalToken } = await import("./worker");
const sessionsRoute = await import("../sessions/route");
const sessionRoute = await import("../sessions/[id]/route");
const frameRoute = await import("../sessions/[id]/frame/route");
const actionRoute = await import("../sessions/[id]/action/route");
const renderRoute = await import("../render/route");

const stamp = Date.now();
const password = "correct horse battery staple";
const people = {
  owner: `b-owner-${stamp}@example.test`,
  colleague: `b-colleague-${stamp}@example.test`,
  viewer: `b-viewer-${stamp}@example.test`,
};
const userIds: string[] = [];
let orgId: string;

const manager = new BrowserManager({ maxSessions: 2, maxSessionsPerOrg: 1 });
let worker: http.Server;
let site: http.Server;
let siteBase: string;
let workerSecret = process.env.SESSION_SECRET!;
const savedWorkerUrl = process.env.WORKER_INTERNAL_URL;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(
  fn: Handler,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; params?: Record<string, string> } = {},
) {
  const headers = new Headers({ host: "app.example", "sec-fetch-site": "same-origin", ...opts.headers });
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set("content-type", "application/json");
  }
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.set("cookie", cookie);
  const req = new NextRequest(new URL(path, "http://app.example"), { method, headers, body });
  return fn(req, { params: Promise.resolve(opts.params ?? {}) });
}

async function signIn(email: string) {
  jar.clear();
  requestHeaders = new Headers({ "x-real-ip": "203.0.113.50" });
  const res = await login(email, password);
  expect(res.ok).toBe(true);
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function clearLimits() {
  const redis = redisCommand();
  const keys = [
    ...(await redis.keys("rls:auth:203.0.113.50")),
    ...userIds.flatMap((id) => [`rls:browser:open:${id}`, `rls:browser:render:${id}`, `rls:api:${id}`]),
  ];
  if (keys.length) await redis.del(...keys);
}

beforeAll(async () => {
  site = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Fixture</title><meta name=description content=Hi><h1>Hello</h1>");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteBase = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  // The secret is read per request, so a test can make web and worker disagree.
  worker = http.createServer(async (req, res) => {
    const handle = browserApi({ manager: () => manager, sessionSecret: workerSecret });
    if (!(await handle(req, res))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => worker.listen(0, "127.0.0.1", r));
  process.env.WORKER_INTERNAL_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
  resetEnvCache();

  orgId = (await db.insert(organizations).values({ name: "Browser org", slug: `b-${stamp}` }).returning())[0]!.id;
  for (const [key, role] of [
    ["owner", "OWNER"],
    ["colleague", "ADMIN"],
    ["viewer", "VIEWER"],
  ] as const) {
    const [u] = await db
      .insert(users)
      .values({ email: people[key], passwordHash: await hashPassword(password) })
      .returning();
    userIds.push(u!.id);
    await db.insert(memberships).values({ userId: u!.id, orgId, role });
  }
  await clearLimits();
});

afterAll(async () => {
  await clearLimits();
  await manager.close();
  await new Promise((r) => worker.close(r));
  await new Promise((r) => site.close(r));
  if (savedWorkerUrl === undefined) delete process.env.WORKER_INTERNAL_URL;
  else process.env.WORKER_INTERNAL_URL = savedWorkerUrl;
  resetEnvCache();
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await purgeOrganization(orgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("contract K3 token", () => {
  it("web and worker derive the same internal token", () => {
    expect(internalToken("s".repeat(40))).toBe(workerSideToken("s".repeat(40)));
  });
});

describe("/api/browser", () => {
  it("needs a signed-in person with scan:run for sessions", async () => {
    jar.clear();
    const anon = await call(sessionsRoute.POST, "POST", "/api/browser/sessions", { body: { url: siteBase } });
    expect(anon.status).toBe(401);

    await signIn(people.viewer);
    const viewer = await call(sessionsRoute.POST, "POST", "/api/browser/sessions", { body: { url: siteBase } });
    expect(viewer.status).toBe(403);
  });

  it("opens a session, streams frames with 304s, forwards actions, and closes it", async () => {
    await signIn(people.owner);
    const created = await call(sessionsRoute.POST, "POST", "/api/browser/sessions", {
      body: { url: siteBase, device: "desktop" },
    });
    expect(created.status).toBe(201);
    const info = (await created.json()) as { id: string; width: number; height: number };
    expect(info).toMatchObject({ width: 1366, height: 850 });
    const params = { id: info.id };

    let frame = await call(frameRoute.GET, "GET", `/api/browser/sessions/${info.id}/frame`, { params });
    for (let i = 0; i < 20 && frame.headers.get("x-browser-title") !== "Fixture"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      frame = await call(frameRoute.GET, "GET", `/api/browser/sessions/${info.id}/frame`, { params });
    }
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect(frame.headers.get("cache-control")).toContain("no-store");
    expect(decodeURIComponent(frame.headers.get("x-browser-url")!)).toBe(`${siteBase}/`);
    let etag = frame.headers.get("etag")!;
    expect(Buffer.from(await frame.arrayBuffer()).subarray(0, 2).toString("hex")).toBe("ffd8");

    // Once the page stops painting, the same ETag gets an empty 304.
    const poll = () =>
      call(frameRoute.GET, "GET", `/api/browser/sessions/${info.id}/frame`, { params, headers: { "if-none-match": etag } });
    let same = await poll();
    for (let i = 0; i < 20 && same.status !== 304; i++) {
      etag = same.headers.get("etag")!;
      await new Promise((r) => setTimeout(r, 300));
      same = await poll();
    }
    expect(same.status).toBe(304);

    const act = await call(actionRoute.POST, "POST", `/api/browser/sessions/${info.id}/action`, {
      params,
      body: { type: "scroll", dy: 300 },
    });
    expect(act.status).toBe(200);
    expect(await act.json()).toMatchObject({ url: `${siteBase}/`, title: "Fixture" });

    const badKey = await call(actionRoute.POST, "POST", `/api/browser/sessions/${info.id}/action`, {
      params,
      body: { type: "key", key: "Control+W" },
    });
    expect(badKey.status).toBe(400);
    const unknown = await call(actionRoute.POST, "POST", `/api/browser/sessions/${info.id}/action`, {
      params,
      body: { type: "evaluate", code: "1" },
    });
    expect(unknown.status).toBe(400);

    // Someone else in the same organization cannot see or drive it.
    await signIn(people.colleague);
    const foreign = await call(frameRoute.GET, "GET", `/api/browser/sessions/${info.id}/frame`, { params });
    expect(foreign.status).toBe(404);
    expect(await errorCode(foreign)).toBe("NOT_FOUND");
    // …and the organization's one slot is taken.
    const busy = await call(sessionsRoute.POST, "POST", "/api/browser/sessions", { body: { url: siteBase } });
    expect(busy.status).toBe(429);
    expect(await errorCode(busy)).toBe("BROWSER_BUSY");

    await signIn(people.owner);
    const closed = await call(sessionRoute.DELETE, "DELETE", `/api/browser/sessions/${info.id}`, { params });
    expect(closed.status).toBe(200);
    const gone = await call(frameRoute.GET, "GET", `/api/browser/sessions/${info.id}/frame`, { params });
    expect(gone.status).toBe(404);
    const junk = await call(frameRoute.GET, "GET", "/api/browser/sessions/../frame", { params: { id: "../x" } });
    expect(junk.status).toBe(404);
  });

  it("refuses private addresses with BLOCKED_ADDRESS", async () => {
    await signIn(people.owner);
    delete process.env.ALLOW_PRIVATE_NETWORK;
    try {
      const res = await call(sessionsRoute.POST, "POST", "/api/browser/sessions", {
        body: { url: "http://169.254.169.254/latest/meta-data/" },
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("BLOCKED_ADDRESS");
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "1";
    }
  });

  it("renders for anyone who can read projects", async () => {
    await signIn(people.viewer);
    const res = await call(renderRoute.POST, "POST", "/api/browser/render", {
      body: { url: siteBase, device: "mobile", changes: [{ field: "h1", value: "Better" }] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seo: { title: string; h1: string[] }; changesApplied: number; width: number };
    expect(body.seo).toMatchObject({ title: "Fixture", h1: ["Hello"] });
    expect(body.changesApplied).toBe(1);
    expect(body.width).toBe(390);

    const invalid = await call(renderRoute.POST, "POST", "/api/browser/render", {
      body: { url: siteBase, changes: [{ field: "body_html", value: "<script>" }] },
    });
    expect(invalid.status).toBe(400);
  });

  it("validates the project it is opened for", async () => {
    await signIn(people.owner);
    const res = await call(sessionsRoute.POST, "POST", "/api/browser/sessions", {
      body: { url: siteBase, projectId: "not-a-uuid" },
    });
    expect(res.status).toBe(400);
  });

  it("answers BROWSER_UNAVAILABLE when the worker is unreachable or disagrees on the secret", async () => {
    await signIn(people.owner);
    workerSecret = "a-different-secret-that-the-web-does-not-know";
    try {
      const res = await call(renderRoute.POST, "POST", "/api/browser/render", { body: { url: siteBase } });
      expect(res.status).toBe(503);
      expect(await errorCode(res)).toBe("BROWSER_UNAVAILABLE");
    } finally {
      workerSecret = process.env.SESSION_SECRET!;
    }

    const saved = process.env.WORKER_INTERNAL_URL;
    process.env.WORKER_INTERNAL_URL = "http://127.0.0.1:9";
    resetEnvCache();
    try {
      const res = await call(renderRoute.POST, "POST", "/api/browser/render", { body: { url: siteBase } });
      expect(res.status).toBe(503);
      expect(await errorCode(res)).toBe("BROWSER_UNAVAILABLE");
    } finally {
      process.env.WORKER_INTERNAL_URL = saved;
      resetEnvCache();
    }
  });
});
