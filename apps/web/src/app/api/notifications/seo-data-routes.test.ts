/**
 * The SEO data API routes as Next handlers, against real Postgres and Redis:
 * permissions per role, organization scoping, honest {configured:false}
 * answers without credentials, validation errors, and queue deduplication.
 * Nothing here reaches a third party.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDb, db, eq, memberships, organizations, projects, purgeOrganization, users } from "@seo/db";
import { closeQueues, closeRedis, dataQueue, hashPassword, redisCommand } from "@seo/core";

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

const { login } = await import("../../../lib/auth");
const keywordsRoute = await import("../projects/[id]/keywords/route");
const ideasRoute = await import("../projects/[id]/keywords/ideas/route");
const opportunitiesRoute = await import("../projects/[id]/keywords/opportunities/route");
const syncRoute = await import("../projects/[id]/rank/sync/route");
const schedulesRoute = await import("../projects/[id]/schedules/route");
const scheduleRoute = await import("../projects/[id]/schedules/[kind]/route");
const alertsRoute = await import("../projects/[id]/alerts/route");
const competitorsRoute = await import("../projects/[id]/competitors/route");
const gapRoute = await import("../projects/[id]/competitors/[competitorId]/keyword-gap/route");
const pagespeedRoute = await import("../projects/[id]/pagespeed/route");
const integrationsRoute = await import("../integrations/route");
const integrationRoute = await import("../integrations/[kind]/route");
const notificationsRoute = await import("./route");
const readAllRoute = await import("./read-all/route");

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(fn: Handler, method: string, path: string, opts: { body?: unknown; params?: Record<string, string> } = {}) {
  const headers = new Headers({ host: "app.example", "sec-fetch-site": "same-origin" });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const req = new NextRequest(new URL(path, "http://app.example"), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return fn(req, { params: Promise.resolve(opts.params ?? {}) });
}

const stamp = Date.now();
const password = "correct horse battery staple";
const who = { admin: `sd-admin-${stamp}@example.test`, editor: `sd-editor-${stamp}@example.test`, viewer: `sd-viewer-${stamp}@example.test` };
let orgId: string;
let otherOrgId: string;
let projectId: string;
let foreignProjectId: string;
const userIds: string[] = [];

let logins = 0;
/** Each sign-in from its own address, so the per-IP login limit never interferes. */
async function as(role: keyof typeof who) {
  jar.clear();
  requestHeaders = new Headers({ "x-real-ip": `198.51.100.${100 + (logins++ % 150)}` });
  const res = await login(who[role], password);
  if (!res.ok) throw new Error(`login failed for ${role}`);
}

beforeAll(async () => {
  orgId = (await db.insert(organizations).values({ name: "SD", slug: `sd-${stamp}` }).returning())[0]!.id;
  otherOrgId = (await db.insert(organizations).values({ name: "SD other", slug: `sd-o-${stamp}` }).returning())[0]!.id;
  const hash = await hashPassword(password);
  for (const [role, email] of [
    ["ADMIN", who.admin],
    ["EDITOR", who.editor],
    ["VIEWER", who.viewer],
  ] as const) {
    const id = (await db.insert(users).values({ email, passwordHash: hash }).returning())[0]!.id;
    userIds.push(id);
    await db.insert(memberships).values({ userId: id, orgId, role });
  }
  projectId = (await db.insert(projects).values({ orgId, name: "P", baseUrl: "https://sd.example/" }).returning())[0]!.id;
  foreignProjectId = (await db.insert(projects).values({ orgId: otherOrgId, name: "F", baseUrl: "https://f.example/" }).returning())[0]!.id;
});

afterAll(async () => {
  const keys = await redisCommand().keys("rls:auth:198.51.100.*");
  if (keys.length) await redisCommand().del(...keys);
  await dataQueue("rank").obliterate({ force: true }).catch(() => {});
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await purgeOrganization(orgId).catch(() => {});
  await purgeOrganization(otherOrgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

describe("keywords and research", () => {
  it("viewers read, editors write", async () => {
    await as("viewer");
    const denied = await call(keywordsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { phrases: "seo" } });
    expect(denied.status).toBe(403);
    await as("editor");
    const created = await call(keywordsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { phrases: "seo\nخرید کتاب", country: "ir" } });
    expect(created.status).toBe(201);
    expect((await json<{ added: unknown[] }>(created)).added).toHaveLength(2);
    await as("viewer");
    const list = await json<{ keywords: Array<{ phrase: string; gsc: unknown; serp: unknown }>; sources: unknown }>(
      await call(keywordsRoute.GET, "GET", "/x", { params: { id: projectId } }),
    );
    expect(list.keywords.map((k) => k.phrase).sort()).toEqual(["seo", "خرید کتاب"]);
    expect(list.keywords.every((k) => k.gsc === null && k.serp === null)).toBe(true);
    expect(list.sources).toEqual({ gsc: false, dataforseo: false, pagespeedKey: expect.any(String) });
  });

  it("answers {configured:false} without Search Console or DataForSEO", async () => {
    await as("editor");
    expect(await json(await call(ideasRoute.POST, "POST", "/x", { params: { id: projectId }, body: { seeds: ["seo"] } }))).toEqual({ configured: false });
    expect(await json(await call(opportunitiesRoute.GET, "GET", "/x", { params: { id: projectId } }))).toEqual({ configured: false });
  });

  it("another organization's project is a 404", async () => {
    await as("admin");
    expect((await call(keywordsRoute.GET, "GET", "/x", { params: { id: foreignProjectId } })).status).toBe(404);
    expect((await call(alertsRoute.GET, "GET", "/x", { params: { id: foreignProjectId } })).status).toBe(404);
  });
});

describe("jobs", () => {
  it("a manual rank sync is queued once while one is waiting", async () => {
    await as("editor");
    const a = await call(syncRoute.POST, "POST", "/x", { params: { id: projectId } });
    expect(a.status).toBe(202);
    const first = await json<{ jobId: string; deduplicated: boolean }>(a);
    const second = await json<{ jobId: string; deduplicated: boolean }>(await call(syncRoute.POST, "POST", "/x", { params: { id: projectId } }));
    expect(second).toEqual({ jobId: first.jobId, deduplicated: true });
  });

  it("PageSpeed refuses URLs of other sites", async () => {
    await as("editor");
    const res = await call(pagespeedRoute.POST, "POST", "/x", { params: { id: projectId }, body: { urls: ["https://evil.example/"] } });
    expect(res.status).toBe(400);
    const summary = await json<{ pages: unknown[]; source: string }>(await call(pagespeedRoute.GET, "GET", "/x", { params: { id: projectId } }));
    expect(summary).toMatchObject({ pages: [], source: "pagespeed_insights" });
  });
});

describe("schedules and alerts", () => {
  it("lists defaults with next runs, validates cron, admins only may change", async () => {
    await as("viewer");
    const list = await json<{ schedules: Array<{ kind: string; nextRunAt: string | null }> }>(
      await call(schedulesRoute.GET, "GET", "/x", { params: { id: projectId } }),
    );
    expect(list.schedules.map((s) => s.kind)).toEqual(["scan", "rank", "pagespeed", "competitors", "report"]);
    expect(list.schedules[1]!.nextRunAt).toBeTruthy();
    await as("editor");
    expect((await call(scheduleRoute.PUT, "PUT", "/x", { params: { id: projectId, kind: "rank" }, body: { enabled: false } })).status).toBe(403);
    await as("admin");
    const bad = await call(scheduleRoute.PUT, "PUT", "/x", { params: { id: projectId, kind: "rank" }, body: { cron: "* * * * *" } });
    expect(bad.status).toBe(400);
    expect((await json<{ error: { details: { field: string } } }>(bad)).error.details.field).toBe("cron");
    const ok = await json<{ schedule: { cron: string; timezone: string } }>(
      await call(scheduleRoute.PUT, "PUT", "/x", { params: { id: projectId, kind: "rank" }, body: { cron: "0 6 * * *", timezone: "Asia/Tehran" } }),
    );
    expect(ok.schedule).toMatchObject({ cron: "0 6 * * *", timezone: "Asia/Tehran" });
    expect((await call(scheduleRoute.PUT, "PUT", "/x", { params: { id: projectId, kind: "backup" }, body: {} })).status).toBe(400);
  });

  it("every project has default alert rules; a webhook rule returns its secret once", async () => {
    await as("admin");
    const list = await json<{ rules: Array<{ kind: string; channels: string[] }> }>(await call(alertsRoute.GET, "GET", "/x", { params: { id: projectId } }));
    expect(list.rules).toHaveLength(6);
    expect(list.rules.every((r) => r.channels.join() === "in_app")).toBe(true);
    const created = await call(alertsRoute.POST, "POST", "/x", {
      params: { id: projectId },
      body: { kind: "rank_drop", threshold: 3, channels: ["webhook"], webhookUrl: "http://127.0.0.1:9/seo" },
    });
    expect(created.status).toBe(201);
    const { webhookSecret, rule } = await json<{ webhookSecret: string; rule: { id: string; hasWebhookSecret: boolean } }>(created);
    expect(webhookSecret).toMatch(/^whsec_/);
    expect(rule.hasWebhookSecret).toBe(true);
    const again = await call(alertsRoute.GET, "GET", "/x", { params: { id: projectId } });
    expect(await again.text()).not.toContain(webhookSecret);
  });
});

describe("integrations and notifications", () => {
  it("only owners and admins manage integrations; nothing secret in the list", async () => {
    await as("editor");
    expect((await call(integrationsRoute.GET, "GET", "/x")).status).toBe(403);
    await as("admin");
    const list = await json<{ integrations: Array<{ kind: string; configured: boolean }> }>(await call(integrationsRoute.GET, "GET", "/x"));
    expect(list.integrations.map((i) => [i.kind, i.configured])).toEqual([
      ["DATAFORSEO", false],
      ["PAGESPEED", false],
      ["TELEGRAM_ALERTS", false],
    ]);
    const bad = await call(integrationRoute.PUT, "PUT", "/x", { params: { kind: "telegram_alerts" }, body: { botToken: "x", chatId: "y" } });
    expect(bad.status).toBe(400);
    expect((await call(integrationRoute.GET, "GET", "/x", { params: { kind: "stripe" } })).status).toBe(400);
  });

  it("keyword gap is {configured:false} without DataForSEO", async () => {
    await as("editor");
    const c = await json<{ competitor: { id: string } }>(
      await call(competitorsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { domain: "https://1.1.1.1/" } }),
    );
    const gap = await call(gapRoute.POST, "POST", "/x", { params: { id: projectId, competitorId: c.competitor.id }, body: {} });
    expect(await json(gap)).toEqual({ configured: false });
    expect((await call(competitorsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { domain: "sd.example" } })).status).toBe(400);
  });

  it("the inbox answers with an unread count and marks all read", async () => {
    await as("viewer");
    const inbox = await json<{ unread: number; total: number; items: unknown[] }>(await call(notificationsRoute.GET, "GET", "/api/notifications?perPage=5"));
    expect(inbox).toMatchObject({ unread: 0, total: 0, items: [] });
    expect(await json(await call(readAllRoute.POST, "POST", "/x", { body: { projectId } }))).toEqual({ updated: 0 });
    expect((await call(readAllRoute.POST, "POST", "/x", { body: { projectId: foreignProjectId } })).status).toBe(404);
  });
});
