/**
 * The content, schema, internal-link, robots, sitemap and report routes as
 * Next handlers, against real Postgres and Redis: permissions per role,
 * organization scoping, validation, the approval boundary for publishing,
 * and honest answers without a scan or a write target. Nothing here reaches a
 * third party (the project's site is an unroutable test domain).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDb, db, eq, memberships, organizations, projects, purgeOrganization, reports, users } from "@seo/db";
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

const { login } = await import("../../../../../lib/auth");
const contentRoute = await import("./route");
const docRoute = await import("./[docId]/route");
const exportRoute = await import("./[docId]/export/route");
const publishRoute = await import("./[docId]/publish/route");
const decisionRoute = await import("./[docId]/publish/decision/route");
const analyzeRoute = await import("./analyze/route");
const schemaRoute = await import("../schema/route");
const previewRoute = await import("../schema/preview/route");
const schemaApplyRoute = await import("../schema/apply/route");
const linksRoute = await import("../internal-links/route");
const robotsTestRoute = await import("../robots/test/route");
const sitemapRoute = await import("../sitemap/route");
const reportsRoute = await import("../reports/route");
const reportDownloadRoute = await import("../reports/[reportId]/download/route");
const reportRoute = await import("../reports/[reportId]/route");
const brandRoute = await import("../reports/brand/route");

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(fn: Handler, method: string, path: string, opts: { body?: unknown; params?: Record<string, string> } = {}) {
  const headers = new Headers({ host: "app.example", "sec-fetch-site": "same-origin" });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const req = new NextRequest(new URL(path, "http://app.example"), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return fn(req, { params: Promise.resolve(opts.params ?? {}) });
}

const stamp = Date.now();
const password = "correct horse battery staple";
const who = { admin: `q2-admin-${stamp}@example.test`, editor: `q2-editor-${stamp}@example.test`, viewer: `q2-viewer-${stamp}@example.test` };
let orgId: string;
let otherOrgId: string;
let projectId: string;
let foreignProjectId: string;
const userIds: string[] = [];
let logins = 0;

async function as(role: keyof typeof who) {
  jar.clear();
  requestHeaders = new Headers({ "x-real-ip": `198.51.100.${100 + (logins++ % 150)}` });
  const res = await login(who[role], password);
  if (!res.ok) throw new Error(`login failed for ${role}`);
}

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

beforeAll(async () => {
  orgId = (await db.insert(organizations).values({ name: "Q2", slug: `q2-${stamp}` }).returning())[0]!.id;
  otherOrgId = (await db.insert(organizations).values({ name: "Q2 other", slug: `q2-o-${stamp}` }).returning())[0]!.id;
  const hash = await hashPassword(password);
  for (const [role, email] of [["ADMIN", who.admin], ["EDITOR", who.editor], ["VIEWER", who.viewer]] as const) {
    const id = (await db.insert(users).values({ email, passwordHash: hash }).returning())[0]!.id;
    userIds.push(id);
    await db.insert(memberships).values({ userId: id, orgId, role });
  }
  projectId = (await db.insert(projects).values({ orgId, name: "P", baseUrl: "https://q2.example.invalid/", locale: "en" }).returning())[0]!.id;
  foreignProjectId = (await db.insert(projects).values({ orgId: otherOrgId, name: "F", baseUrl: "https://f.example.invalid/" }).returning())[0]!.id;
});

afterAll(async () => {
  const keys = await redisCommand().keys("rls:auth:198.51.100.*");
  if (keys.length) await redisCommand().del(...keys);
  await dataQueue("report").obliterate({ force: true }).catch(() => {});
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await purgeOrganization(orgId).catch(() => {});
  await purgeOrganization(otherOrgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("content routes", () => {
  let docId: string;

  it("viewers read, editors write, other organizations get 404", async () => {
    await as("viewer");
    expect((await call(contentRoute.POST, "POST", "/x", { params: { id: projectId }, body: { title: "T" } })).status).toBe(403);
    await as("editor");
    const created = await call(contentRoute.POST, "POST", "/x", { params: { id: projectId }, body: { title: "Guide", targetKeyword: "guide", body: "<p>A guide.</p><script>x</script>" } });
    expect(created.status).toBe(201);
    const { document } = await json<{ document: { id: string; body: string; score: number; analysis: { checks: unknown[] } } }>(created);
    docId = document.id;
    expect(document.body).toBe("<p>A guide.</p>");
    expect(document.analysis.checks.length).toBeGreaterThan(5);
    expect((await call(contentRoute.POST, "POST", "/x", { params: { id: projectId }, body: { title: "" } })).status).toBe(400);
    await as("viewer");
    expect((await json<{ documents: unknown[] }>(await call(contentRoute.GET, "GET", "/x", { params: { id: projectId } }))).documents).toHaveLength(1);
    expect((await call(docRoute.GET, "GET", "/x", { params: { id: foreignProjectId, docId } })).status).toBe(404);
    const exported = await call(exportRoute.GET, "GET", "/x", { params: { id: projectId, docId } });
    expect(exported.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(await exported.text()).toContain("<h1>Guide</h1>");
  });

  it("analyses a draft without saving it", async () => {
    await as("editor");
    const res = await call(analyzeRoute.POST, "POST", "/x", { params: { id: projectId }, body: { title: "Draft", body: "<p>Text</p>" } });
    expect(res.status).toBe(200);
    expect((await json<{ analysis: { score: number } }>(res)).analysis.score).toEqual(expect.any(Number));
  });

  it("publishing: editors ask (needs WordPress), only admins decide", async () => {
    await as("editor");
    const ask = await call(publishRoute.POST, "POST", "/x", { params: { id: projectId, docId }, body: { mode: "draft" } });
    expect(ask.status).toBe(409);
    expect((await json<{ error: { code: string } }>(ask)).error.code).toBe("CONNECTOR_NOT_CONNECTED");
    expect((await call(decisionRoute.POST, "POST", "/x", { params: { id: projectId, docId }, body: { decision: "approve" } })).status).toBe(403);
    await as("admin");
    const nothing = await call(decisionRoute.POST, "POST", "/x", { params: { id: projectId, docId }, body: { decision: "approve" } });
    expect(nothing.status).toBe(409);
  });
});

describe("site tool routes", () => {
  it("answer honestly before the first scan", async () => {
    await as("viewer");
    expect(await json(await call(linksRoute.GET, "GET", "/x", { params: { id: projectId } }))).toEqual({ status: "no_scan" });
    const schema = await json<{ types: string[]; existing: { status: string } }>(await call(schemaRoute.GET, "GET", "/x?url=https://q2.example.invalid/", { params: { id: projectId } }));
    expect(schema.types).toContain("Product");
    expect(schema.existing).toEqual({ status: "no_scan" });
    const sitemap = await json<{ status: string; apply: { connected: boolean } }>(await call(sitemapRoute.GET, "GET", "/x", { params: { id: projectId } }));
    expect(sitemap).toMatchObject({ status: "no_scan", apply: { connected: false } });
  });

  it("preview validates; applying is fix:propose and refuses without a write target", async () => {
    await as("viewer");
    const preview = await json<{ jsonld: Record<string, unknown>; issues: Array<{ code: string }> }>(
      await call(previewRoute.POST, "POST", "/x", { params: { id: projectId }, body: { type: "Product", data: { name: "Shoe" } } }),
    );
    expect(preview.issues.map((i) => i.code)).toContain("missing_required");
    expect((await call(schemaApplyRoute.POST, "POST", "/x", { params: { id: projectId }, body: { url: "https://q2.example.invalid/", jsonld: { "@context": "https://schema.org", "@type": "Organization", name: "Q2" } } })).status).toBe(403);
    await as("editor");
    const res = await call(schemaApplyRoute.POST, "POST", "/x", { params: { id: projectId }, body: { url: "https://q2.example.invalid/", jsonld: { "@context": "https://schema.org", "@type": "Organization", name: "Q2" } } });
    expect(res.status).toBe(409);
    expect((await json<{ error: { details: { manual: boolean } } }>(res)).error.details.manual).toBe(true);
  });

  it("robots tester explains each verdict for an edited file", async () => {
    await as("viewer");
    const res = await json<{ results: Array<{ url: string; userAgent: string; allowed: boolean; rule: { line: number } | null }> }>(
      await call(robotsTestRoute.POST, "POST", "/x", { params: { id: projectId }, body: { urls: ["/private/a", "/"], userAgents: ["Googlebot"], robotsTxt: "User-agent: *\nDisallow: /private/\n" } }),
    );
    expect(res.results).toEqual([
      { url: "https://q2.example.invalid/private/a", userAgent: "Googlebot", allowed: false, group: "*", rule: { allow: false, pattern: "/private/", line: 2, text: "Disallow: /private/" } },
      { url: "https://q2.example.invalid/", userAgent: "Googlebot", allowed: true, group: "*", rule: null },
    ]);
  });
});

describe("report routes", () => {
  it("editors queue a report (deduplicated), viewers cannot; downloads are scoped", async () => {
    await as("viewer");
    expect((await call(reportsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { kind: "audit" } })).status).toBe(403);
    await as("editor");
    const a = await call(reportsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { kind: "audit", locale: "en" } });
    expect(a.status).toBe(202);
    const first = await json<{ jobId: string }>(a);
    expect(await json(await call(reportsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { kind: "audit" } }))).toEqual({ jobId: first.jobId, deduplicated: true });
    expect((await call(reportsRoute.POST, "POST", "/x", { params: { id: projectId }, body: { kind: "weekly" } })).status).toBe(400);
    const list = await json<{ reports: unknown[]; pending: Array<{ jobId: string; kind: string }> }>(await call(reportsRoute.GET, "GET", "/x", { params: { id: projectId } }));
    expect(list.pending).toEqual([expect.objectContaining({ jobId: first.jobId, kind: "audit" })]);

    const pdf = Buffer.from("%PDF-1.7 test");
    const row = (await db.insert(reports).values({ projectId, kind: "audit", fileKey: "p-audit.pdf", bytes: pdf.length, content: pdf }).returning({ id: reports.id }))[0]!;
    await as("viewer");
    const dl = await call(reportDownloadRoute.GET, "GET", "/x", { params: { id: projectId, reportId: row.id } });
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("%PDF-1.7 test");
    expect((await call(reportDownloadRoute.GET, "GET", "/x", { params: { id: foreignProjectId, reportId: row.id } })).status).toBe(404);
    expect((await call(reportRoute.DELETE, "DELETE", "/x", { params: { id: projectId, reportId: row.id } })).status).toBe(403);
    await as("editor");
    expect((await call(reportRoute.DELETE, "DELETE", "/x", { params: { id: projectId, reportId: row.id } })).status).toBe(200);
  });

  it("the white-label brand is an admin setting", async () => {
    await as("editor");
    expect((await call(brandRoute.PUT, "PUT", "/x", { params: { id: projectId }, body: { name: "Agency" } })).status).toBe(403);
    await as("admin");
    expect((await call(brandRoute.PUT, "PUT", "/x", { params: { id: projectId }, body: { color: "blue" } })).status).toBe(400);
    const saved = await json<{ brand: Record<string, string> }>(await call(brandRoute.PUT, "PUT", "/x", { params: { id: projectId }, body: { name: "Agency", color: "#112233" } }));
    expect(saved.brand).toEqual({ name: "Agency", color: "#112233" });
    await as("viewer");
    expect((await json<{ brand: unknown }>(await call(brandRoute.GET, "GET", "/x", { params: { id: projectId } }))).brand).toEqual({ name: "Agency", color: "#112233", defaults: { name: "Q2" } });
  });
});
