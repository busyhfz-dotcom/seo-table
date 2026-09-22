/**
 * API routes against real Postgres and Redis, called as Next route handlers.
 * `next/headers` is replaced by a per-test cookie jar and header set, which is
 * all the auth code reads from the request scope.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  and,
  apiKeys,
  auditLog,
  auditRuns,
  closeDb,
  contentOpportunities,
  db,
  eq,
  inArray,
  memberships,
  organizations,
  projects,
  purgeOrganization,
  sessions,
  users,
} from "@seo/db";
import { closeQueues, closeRedis, hashPassword, redisCommand, hashToken } from "@seo/core";

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

const { login, currentSession, newApiKey } = await import("./auth");
const { listOpportunities, listProjects } = await import("./queries");
const orgRoute = await import("../app/api/auth/org/route");
const orgsRoute = await import("../app/api/auth/orgs/route");
const keysRoute = await import("../app/api/keys/route");
const keyRoute = await import("../app/api/keys/[id]/route");
const projectsRoute = await import("../app/api/projects/route");
const connectorRoute = await import("../app/api/connectors/[kind]/route");
const scansRoute = await import("../app/api/projects/[id]/scans/route");
const issuesRoute = await import("../app/api/issues/route");
const logoutRoute = await import("../app/api/auth/logout/route");

const stamp = Date.now();
const email = `d-${stamp}@example.test`;
const password = "correct horse battery staple";
let userId: string;
let orgA: string;
let orgB: string;
let orgC: string;
let projectA: string;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(
  fn: Handler,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; params?: Record<string, string>; raw?: string } = {},
) {
  const headers = new Headers({ host: "app.example", "sec-fetch-site": "same-origin", ...opts.headers });
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const req = new NextRequest(new URL(path, "http://app.example"), { method, headers, body });
  return fn(req, { params: Promise.resolve(opts.params ?? {}) });
}

async function signIn(ip = "203.0.113.1") {
  jar.clear();
  requestHeaders = new Headers({ "x-real-ip": ip });
  return login(email, password);
}

/** Per-IP login buckets and per-account failure logs this file writes, so a re-run starts clean. */
async function clearLimiterKeys() {
  const redis = redisCommand();
  for (const pattern of ["rls:auth:203.0.113.*", "rls:auth:198.51.100.*", "rls:auth:192.0.2.*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }
  const emails = [email, ...Array.from({ length: 12 }, (_, i) => `nobody-${stamp}-${i}@example.test`)];
  await redis.del(...emails.map((e) => `loginfail:${hashToken(e)}`));
}

beforeAll(async () => {
  await clearLimiterKeys();
  const [a, b, c] = await db
    .insert(organizations)
    .values([
      { name: "Org A", slug: `d-a-${stamp}` },
      { name: "Org B", slug: `d-b-${stamp}` },
      { name: "Org C", slug: `d-c-${stamp}` },
    ])
    .returning();
  [orgA, orgB, orgC] = [a!.id, b!.id, c!.id];
  userId = (await db.insert(users).values({ email, passwordHash: await hashPassword(password) }).returning())[0]!.id;
  // B is inserted first but with a later created_at: order must follow created_at.
  await db.insert(memberships).values({ userId, orgId: orgB, role: "ADMIN", createdAt: new Date(Date.now() + 1000) });
  await db.insert(memberships).values({ userId, orgId: orgA, role: "OWNER", createdAt: new Date() });
  projectA = (await db.insert(projects).values({ orgId: orgA, name: "A", baseUrl: "https://a.example/" }).returning())[0]!.id;
});

beforeEach(async () => {
  await redisCommand().del(`loginfail:${hashToken(email)}`);
});

afterAll(async () => {
  await clearLimiterKeys();
  await db.delete(users).where(eq(users.id, userId));
  for (const id of [orgA, orgB, orgC]) await purgeOrganization(id).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("sessions and organizations (C6)", () => {
  it("login stores the earliest membership's org on the session", async () => {
    const res = await signIn();
    expect(res.ok && res.session.orgId).toBe(orgA);
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(jar.get("seo_session")!)));
    expect(row!.orgId).toBe(orgA);
  });

  it("a pre-0004 session without an org falls back deterministically", async () => {
    await signIn();
    await db.update(sessions).set({ orgId: null }).where(eq(sessions.tokenHash, hashToken(jar.get("seo_session")!)));
    for (let i = 0; i < 3; i++) expect((await currentSession())!.orgId).toBe(orgA);
  });

  it("switches org for members only, and lists memberships", async () => {
    await signIn();
    const denied = await call(orgRoute.POST, "POST", "/api/auth/org", { body: { orgId: orgC } });
    expect(denied.status).toBe(404);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");

    const ok = await call(orgRoute.POST, "POST", "/api/auth/org", { body: { orgId: orgB } });
    expect(ok.status).toBe(200);
    expect((await currentSession())!.orgId).toBe(orgB);
    expect((await currentSession())!.role).toBe("ADMIN");

    const list = (await (await call(orgsRoute.GET, "GET", "/api/auth/orgs")).json()) as {
      orgs: Array<{ orgId: string; current: boolean; role: string; name: string }>;
    };
    expect(list.orgs.map((o) => [o.orgId, o.current])).toEqual([
      [orgA, false],
      [orgB, true],
    ]);

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgB), eq(auditLog.action, "auth.org_switch")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe("USER");
  });

  it("a plain HTML form switch answers with a same-site redirect", async () => {
    await signIn();
    const res = await call(orgRoute.POST, "POST", "/api/auth/org", {
      raw: new URLSearchParams({ orgId: orgB, next: "//evil.example" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://app.example" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect((await currentSession())!.orgId).toBe(orgB);
  });
});

describe("login hardening", () => {
  it("locks an account after 10 failures from any number of addresses", async () => {
    for (let i = 0; i < 10; i++) {
      requestHeaders = new Headers({ "x-real-ip": `198.51.100.${i + 10}` });
      expect((await login(email, "wrong")).ok).toBe(false);
    }
    requestHeaders = new Headers({ "x-real-ip": "198.51.100.99" });
    await expect(login(` ${email.toUpperCase()} `, password)).rejects.toMatchObject({ status: 429 });
  });

  it("a forged X-Forwarded-For does not choose the rate-limit bucket", async () => {
    // Twelve attempts, each claiming a new first hop; the proxy's hop is constant.
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      requestHeaders = new Headers({ "x-forwarded-for": `10.9.${i}.1, 192.0.2.77` });
      await login(`nobody-${stamp}-${i}@example.test`, "x").catch((e: { status?: number }) => {
        if (e.status === 429) limited++;
      });
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("an unknown account and a wrong password look the same", async () => {
    requestHeaders = new Headers({ "x-real-ip": "192.0.2.200" });
    expect(await login(`missing-${stamp}@example.test`, password)).toEqual({ ok: false });
    expect(await login(email, "wrong")).toEqual({ ok: false });
  });
});

describe("request hardening", () => {
  beforeEach(async () => {
    await signIn("203.0.113.50");
  });

  it("refuses cookie-authenticated cross-site writes", async () => {
    const byOrigin = await call(keysRoute.POST, "POST", "/api/keys", {
      body: { name: "x" },
      headers: { "sec-fetch-site": "", origin: "https://evil.example" },
    });
    expect(byOrigin.status).toBe(403);
    const byFetchSite = await call(keysRoute.POST, "POST", "/api/keys", {
      body: { name: "x" },
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(byFetchSite.status).toBe(403);
    const logout = await call(logoutRoute.POST as Handler, "POST", "/api/auth/logout", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(logout.status).toBe(403);
    expect(jar.has("seo_session")).toBe(true);
  });

  it("requires a JSON content type for a JSON body", async () => {
    const res = await call(keysRoute.POST, "POST", "/api/keys", {
      raw: JSON.stringify({ name: "x" }),
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects a malformed Idempotency-Key and a caller-chosen SCHEDULE trigger", async () => {
    const badKey = await call(scansRoute.POST, "POST", `/api/projects/${projectA}/scans`, {
      headers: { "idempotency-key": "has space" },
      params: { id: projectA },
    });
    expect(badKey.status).toBe(400);
    const schedule = await call(scansRoute.POST, "POST", `/api/projects/${projectA}/scans`, {
      body: { trigger: "SCHEDULE" },
      params: { id: projectA },
    });
    expect(schedule.status).toBe(400);
  });

  it("clamps absurd pagination instead of failing", async () => {
    const res = await call(issuesRoute.GET, "GET", `/api/issues?projectId=${projectA}&page=1e20&perPage=-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page: 1_000_000, perPage: 1, issues: [] });
  });

  it("stores a project's base URL as typed and refuses internal addresses", async () => {
    const created = await call(projectsRoute.POST, "POST", "/api/projects", {
      body: { name: "Blog", baseUrl: "https://Blog.Example/fa/#top" },
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { project: { baseUrl: string } }).project.baseUrl).toBe("https://blog.example/fa/");

    process.env.ALLOW_PRIVATE_NETWORK = "0";
    try {
      const blocked = await call(projectsRoute.POST, "POST", "/api/projects", {
        body: { name: "Meta", baseUrl: "http://169.254.169.254/latest/" },
      });
      expect(blocked.status).toBe(400);
      expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("BLOCKED_ADDRESS");

      const wp = await call(connectorRoute.POST, "POST", `/api/connectors/wordpress?projectId=${projectA}`, {
        body: { kind: "WORDPRESS", siteUrl: "http://127.0.0.1:8080", username: "u", applicationPassword: "abcd efgh ijkl" },
        params: { kind: "wordpress" },
      });
      expect(wp.status).toBe(400);
      expect(((await wp.json()) as { error: { code: string } }).error.code).toBe("BLOCKED_ADDRESS");
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "1";
    }
  });

  it("answers 400 for an unknown connector kind", async () => {
    const res = await call(connectorRoute.DELETE, "DELETE", "/api/connectors/bogus", { params: { kind: "bogus" } });
    expect(res.status).toBe(400);
  });
});

describe("API keys", () => {
  it("revokes a key in the caller's org only, and a revoked key stops working", async () => {
    const key = newApiKey();
    const [row] = await db.insert(apiKeys).values({ orgId: orgA, name: "ci", prefix: key.prefix, hash: key.hash }).returning();

    // Works before revocation, and its audit actor is API_KEY.
    const bearer = { authorization: `Bearer ${key.display}`, "sec-fetch-site": "cross-site" };
    const before = await call(issuesRoute.GET, "GET", `/api/issues?projectId=${projectA}`, { headers: bearer });
    expect(before.status).toBe(200);

    await signIn();
    await call(orgRoute.POST, "POST", "/api/auth/org", { body: { orgId: orgB } });
    const wrongOrg = await call(keyRoute.DELETE, "DELETE", `/api/keys/${row!.id}`, { params: { id: row!.id } });
    expect(wrongOrg.status).toBe(404);

    await call(orgRoute.POST, "POST", "/api/auth/org", { body: { orgId: orgA } });
    const revoked = await call(keyRoute.DELETE, "DELETE", `/api/keys/${row!.id}`, { params: { id: row!.id } });
    expect(revoked.status).toBe(200);
    const first = (await revoked.json()) as { revokedAt: string };
    const again = await call(keyRoute.DELETE, "DELETE", `/api/keys/${row!.id}`, { params: { id: row!.id } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { revokedAt: string }).revokedAt).toBe(first.revokedAt);

    const list = (await (await call(keysRoute.GET, "GET", "/api/keys")).json()) as {
      keys: Array<{ id: string; revokedAt: string | null; lastUsedAt: string | null }>;
    };
    const listed = list.keys.find((k) => k.id === row!.id)!;
    expect(listed.revokedAt).not.toBeNull();
    expect(listed.lastUsedAt).not.toBeNull();

    const after = await call(issuesRoute.GET, "GET", `/api/issues?projectId=${projectA}`, { headers: bearer });
    expect(after.status).toBe(401);

    const audit = await db.select().from(auditLog).where(and(eq(auditLog.orgId, orgA), eq(auditLog.action, "apikey.revoke")));
    expect(audit).toHaveLength(1);
  });
});

describe("queries", () => {
  it("lists only the latest opportunity period", async () => {
    const base = { projectId: projectA, clicks: 1, ctr: 0.01, position: 9, gap: "WARNING" as const, suggestedAction: "x" };
    await db.insert(contentOpportunities).values([
      { ...base, query: "old", impressions: 900, periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-29T00:00:00Z") },
      { ...base, query: "new", impressions: 100, periodStart: new Date("2026-08-23T00:00:00Z"), periodEnd: new Date("2026-09-20T00:00:00Z") },
    ]);
    expect((await listOpportunities(projectA)).map((o) => o.query)).toEqual(["new"]);
  });

  it("returns each project's newest run", async () => {
    const t = Date.now();
    await db.insert(auditRuns).values([
      { projectId: projectA, status: "SUCCEEDED", idempotencyKey: `d1-${t}`, queuedAt: new Date(t - 60_000) },
      { projectId: projectA, status: "FAILED", idempotencyKey: `d2-${t}`, queuedAt: new Date(t) },
    ]);
    const rows = await listProjects(orgA);
    const a = rows.find((p) => p.id === projectA)!;
    expect(a.lastRun?.idempotencyKey).toBe(`d2-${t}`);
    const runs = await db.select().from(auditRuns).where(inArray(auditRuns.projectId, [projectA]));
    expect(runs.length).toBe(2);
  });
});
