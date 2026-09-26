/**
 * robots.txt, sitemap and JSON-LD at the Cloudflare edge: the worker in
 * workerd (Miniflare), the connector against the Cloudflare API double, and
 * the whole path from the panel's proposal through approval, dry run, apply
 * and rollback.
 *
 * What must hold:
 *   - a file override is served only for robots.txt and root sitemap paths,
 *     with the right type, for GET and HEAD, and never for anything else;
 *   - a broken or unreadable override serves the origin's file (fail open);
 *   - the bypass secret still reaches the origin's own file (how the panel
 *     reads what the site itself serves);
 *   - the proposals need approval, apply through the executor, and rollback
 *     removes the override so the origin's file shows again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { closeDb, connectors, db, eq, fixExecutions, fixProposals, organizations, projects, purgeOrganization } from "@seo/db";
import { closeQueues, closeRedis, proposalService, seal } from "@seo/core";
import { execute, rollback } from "@seo/pipeline";
import { cloudflare } from "@seo/connectors";
import { robotsService, schemaMarkup, sitemapService } from "@seo/seo-data";
import { BYPASS_KEY, MANIFEST_KEY, fileKey } from "../packages/connectors/src/edge/keys.js";
import { WORKER_MODULES } from "../packages/connectors/src/edge/worker-source.js";
import { routeTestHostsToLocalhost } from "./dns-stub.js";
import { FAKE_CF_TOKEN, startFakeCloudflare, type FakeCf, type KvStore } from "./fake-cloudflare.js";
import { miniflareKv, type TestKv } from "./miniflare-kv.js";
import { seedCrawl } from "./site-seed.js";

const EDGE_DIR = new URL("../packages/connectors/src/edge/", import.meta.url);
const ORIGIN_ROBOTS = "User-agent: *\nDisallow: /origin-rule/\n";

function originResponse(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/robots.txt") return new Response(ORIGIN_ROBOTS, { headers: { "content-type": "text/plain" } });
  if (path === "/sitemap.xml") return new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', { headers: { "content-type": "application/xml" } });
  if (path === "/private/sitemap.xml") return new Response("origin nested", { headers: { "content-type": "text/plain" } });
  if (path === "/robots.txt.html") return new Response("<html><head><title>x</title></head></html>", { headers: { "content-type": "text/html" } });
  return new Response('<html><head><title>Origin</title></head><body><h1>Page</h1></body></html>', { headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------- the worker alone

describe("edge worker file overrides", () => {
  const SITE = "https://shop.example";
  let mf: Miniflare;
  let kv: TestKv;

  async function start() {
    mf = new Miniflare({
      modules: (["worker.js", "keys.js"] as const).map((name) => ({ type: "ESModule" as const, path: new URL(name, EDGE_DIR).pathname, contents: WORKER_MODULES[name] })),
      compatibilityDate: "2025-09-01",
      kvNamespaces: ["RULES"],
      outboundService: originResponse,
    });
    kv = await miniflareKv(mf);
  }
  async function files(docs: Record<string, string>) {
    const keys: string[] = [];
    for (const [url, raw] of Object.entries(docs)) {
      const k = await fileKey(url);
      keys.push(k);
      await kv.put(k, raw);
    }
    await kv.put(MANIFEST_KEY, JSON.stringify({ v: 1, keys }));
  }
  const get = (path: string, init?: RequestInit) => mf.dispatchFetch(`${SITE}${path}`, { redirect: "manual", ...(init as object) } as never);

  beforeAll(start);
  afterAll(() => mf.dispose());
  beforeEach(async () => {
    await mf.dispose();
    await start();
  });

  it("serves robots.txt and root sitemaps from KV, for GET and HEAD", async () => {
    await files({
      [`${SITE}/robots.txt`]: JSON.stringify({ kind: "robots", body: "User-agent: *\nAllow: /\n" }),
      [`${SITE}/sitemap-2.xml`]: JSON.stringify({ kind: "sitemap", body: "<urlset/>" }),
    });
    const res = await get("/robots.txt?utm_source=x");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-seo-table-edge")).toBe("file");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toBe("User-agent: *\nAllow: /\n");
    const head = await get("/robots.txt", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const sm = await get("/sitemap-2.xml");
    expect(sm.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await sm.text()).toBe("<urlset/>");
    // No override for this one: the origin answers.
    expect(await (await get("/sitemap.xml")).text()).toContain("<urlset xmlns");
  });

  it("never serves a file override on another path, even under a matching key", async () => {
    // A key for a path isFilePath refuses is ignored by the worker.
    const nested = `${SITE}/private/sitemap.xml`;
    await files({ [nested]: JSON.stringify({ kind: "sitemap", body: "<urlset/>" }) });
    expect(await (await get("/private/sitemap.xml")).text()).toBe("origin nested");
  });

  it("fails open: a malformed or unusable override serves the origin's file", async () => {
    await files({ [`${SITE}/robots.txt`]: "{not json" });
    expect(await (await get("/robots.txt")).text()).toBe(ORIGIN_ROBOTS);
    await files({ [`${SITE}/robots.txt`]: JSON.stringify({ kind: "executable", body: "x" }) });
    expect(await (await get("/robots.txt")).text()).toBe(ORIGIN_ROBOTS);
  });

  it("the bypass secret reads the origin's own file", async () => {
    await kv.put(BYPASS_KEY, "s3cret");
    await files({ [`${SITE}/robots.txt`]: JSON.stringify({ kind: "robots", body: "edge\n" }) });
    const res = await get("/robots.txt", { headers: { "x-seo-table-bypass": "s3cret" } });
    expect(res.headers.get("x-seo-table-edge")).toBe("bypass");
    expect(await res.text()).toBe(ORIGIN_ROBOTS);
    expect(await (await get("/robots.txt", { headers: { "x-seo-table-bypass": "wrong" } })).text()).toBe("edge\n");
  });
});

// ---------------------------------------------------------------- panel → approval → edge

describe("from proposal to the edge and back", () => {
  const HOST = "files.example.test";
  const USER = { type: "USER" as const, id: "u-admin" };
  let cf: FakeCf;
  let mf: Miniflare;
  let edge: Server;
  let persist: string;
  let siteUrl: string;
  let orgId: string;
  let projectId: string;

  const kvAdapter = (): KvStore => ({
    get: async (k) => (await miniflareKv(mf)).get(k),
    put: async (k, v) => (await miniflareKv(mf)).put(k, v),
    delete: async (k) => (await miniflareKv(mf)).delete(k),
    list: async (prefix) => (await (await miniflareKv(mf)).list({ prefix })).keys.map((k) => k.name),
  });
  const baseOptions = () => ({ kvNamespaces: ["RULES"], kvPersist: persist, compatibilityDate: "2025-09-01", outboundService: originResponse });
  async function deploy() {
    const script = [...cf.scripts.values()][0]!;
    await mf.setOptions({
      ...baseOptions(),
      modules: Object.entries(script.modules)
        .sort(([a], [b]) => (a === script.metadata.main_module ? -1 : b === script.metadata.main_module ? 1 : 0))
        .map(([name, m]) => ({ type: "ESModule" as const, path: join(process.cwd(), "uploaded-edge", name), contents: m.body })),
      compatibilityDate: String(script.metadata.compatibility_date),
    });
  }
  const live = async (path: string) => (await fetch(`${siteUrl}${path}`)).text();

  async function approveAndApply(proposalId: string) {
    await execute({ proposalId, dryRun: true, actor: USER });
    await proposalService.decide({ proposalId, orgId, actor: USER, approve: true });
    const out = await execute({ proposalId, dryRun: false, actor: USER });
    await deploy(); // a fresh isolate: no cached manifest
    return out;
  }

  beforeAll(async () => {
    routeTestHostsToLocalhost();
    persist = mkdtempSync(join(tmpdir(), "seo-edge-files-"));
    mf = new Miniflare({ ...baseOptions(), modules: true, script: "export default { fetch: () => new Response('placeholder') }" });
    cf = await startFakeCloudflare({ kv: kvAdapter(), zoneName: "example.test" });
    edge = createServer(async (req, res) => {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      const out = await mf.dispatchFetch(`http://${req.headers.host}${req.url}`, { method: req.method, headers, redirect: "manual" } as never);
      const outHeaders: Record<string, string> = {};
      out.headers.forEach((value, name) => (outHeaders[name] = value));
      res.writeHead(out.status, outHeaders);
      res.end(Buffer.from(await out.arrayBuffer()));
    });
    await new Promise<void>((r) => edge.listen(0, "127.0.0.1", r));
    siteUrl = `http://${HOST}:${(edge.address() as { port: number }).port}`;
    cf.zones.length = 0;
    cf.records.length = 0;
    cf.zones.push({ id: "zone000000000000000000000000files", name: "example.test", status: "active", accountId: "acct0000000000000000000000000001" });
    cf.records.push({ id: "rec1", zoneId: "zone000000000000000000000000files", type: "A", name: HOST, proxied: true });

    orgId = (await db.insert(organizations).values({ name: "Edge files", slug: `edge-files-${Date.now()}` }).returning())[0]!.id;
    projectId = (await db.insert(projects).values({ orgId, name: "Files", baseUrl: `${siteUrl}/`, writeTarget: "CLOUDFLARE" }).returning())[0]!.id;
    const creds = seal(JSON.stringify({ apiToken: FAKE_CF_TOKEN, siteUrl: `${siteUrl}/`, apiBase: cf.apiBase }));
    await db.insert(connectors).values({ projectId, kind: "CLOUDFLARE", status: "CONNECTED", secretCipher: creds.cipher, secretIv: creds.iv, secretTag: creds.tag });
    await cloudflare({ apiToken: FAKE_CF_TOKEN, siteUrl: `${siteUrl}/`, apiBase: cf.apiBase }).install();
    await deploy();
    await seedCrawl(projectId, [
      { url: `${siteUrl}/`, title: "Home", h1: ["Home"], depth: 0, links: [[`${siteUrl}/a`, "A"]] },
      { url: `${siteUrl}/a`, title: "A page", h1: ["A page"], links: [[`${siteUrl}/`, "Home"]] },
    ]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((r) => edge.close(() => r()));
    await cf.close();
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
    await purgeOrganization(orgId).catch(() => {});
    await closeQueues();
    await closeRedis();
    await closeDb();
  });

  it("robots.txt: needs approval, applies at the edge, and rolls back to the origin's file", async () => {
    expect(await live("/robots.txt")).toBe(ORIGIN_ROBOTS);
    const edited = "User-agent: *\nDisallow: /origin-rule/\nDisallow: /tmp/\n\nSitemap: " + `${siteUrl}/sitemap.xml\n`;
    const { proposal, target } = await robotsService.proposeRobots({ projectId, orgId, actor: USER, content: edited });
    expect(target).toMatchObject({ target: "CLOUDFLARE", supported: true });
    expect(proposal).toMatchObject({ action: "ROBOTS_TXT", status: "AWAITING_APPROVAL", risk: "SENSITIVE", needsApproval: true });
    // `before` is what crawlers get today (the origin's file), which the executor checks for drift.
    expect(proposal.changes).toEqual([{ url: `${siteUrl}/robots.txt`, field: "robots_txt", before: ORIGIN_ROBOTS, after: edited }]);
    // Without approval the executor refuses a live run.
    await execute({ proposalId: proposal.id, dryRun: true, actor: USER });
    await expect(execute({ proposalId: proposal.id, dryRun: false, actor: USER })).rejects.toMatchObject({ status: 403 });

    await proposalService.decide({ proposalId: proposal.id, orgId, actor: USER, approve: true });
    const out = await execute({ proposalId: proposal.id, dryRun: false, actor: USER });
    await deploy();
    expect(out).toMatchObject({ status: "APPLIED", applied: 1, failed: 0 });
    expect(await live("/robots.txt")).toBe(edited);
    // The panel still reads the site's own file behind the edge.
    expect((await robotsService.liveRobots(projectId)).body).toBe(edited);

    const exec = (await db.select().from(fixExecutions).where(eq(fixExecutions.fixProposalId, proposal.id))).find((e) => !e.dryRun);
    const back = await rollback({ executionId: exec!.id, actor: USER });
    await deploy();
    expect(back.status).toBe("ROLLED_BACK");
    expect(await live("/robots.txt")).toBe(ORIGIN_ROBOTS);
  });

  it("a robots.txt that blocks crawled pages is raised to RESTRICTED", async () => {
    const { proposal, review } = await robotsService.proposeRobots({ projectId, orgId, actor: USER, content: "User-agent: *\nDisallow: /a\n" });
    expect(review.newlyBlocked.map((b) => b.url)).toEqual([`${siteUrl}/a`]);
    expect(proposal.risk).toBe("RESTRICTED");
    await db.delete(fixProposals).where(eq(fixProposals.id, proposal.id));
  });

  it("sitemap: the generated file is served at /sitemap.xml once approved", async () => {
    const { proposal, sitemap } = await sitemapService.proposeSitemap({ projectId, orgId, actor: USER });
    expect(proposal).toMatchObject({ action: "SITEMAP_XML", status: "AWAITING_APPROVAL" });
    expect(sitemap.urls).toBe(2);
    expect(proposal.changes).toEqual([{ url: `${siteUrl}/sitemap.xml`, field: "sitemap_xml", before: expect.stringContaining("<urlset"), after: sitemap.files[0]!.body }]);
    expect(await approveAndApply(proposal.id)).toMatchObject({ status: "APPLIED" });
    const res = await fetch(`${siteUrl}/sitemap.xml`);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await res.text()).toContain(`<loc>${siteUrl}/a</loc>`);
  });

  it("JSON-LD: injected into the page, merged with what the edge already injects", async () => {
    const org = schemaMarkup.buildJsonLd("Organization", { name: "Files Inc", url: `${siteUrl}/` });
    const first = await schemaMarkup.proposeSchema({ projectId, orgId, actor: USER, url: `${siteUrl}/a`, jsonld: org });
    expect(first.proposal).toMatchObject({ action: "SCHEMA_MARKUP", status: "AWAITING_APPROVAL" });
    await approveAndApply(first.proposal.id);
    expect(await live("/a")).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Files Inc"');

    const crumbs = schemaMarkup.buildJsonLd("BreadcrumbList", { items: [{ name: "Home", url: `${siteUrl}/` }, { name: "A page", url: `${siteUrl}/a` }] });
    const second = await schemaMarkup.proposeSchema({ projectId, orgId, actor: USER, url: `${siteUrl}/a`, jsonld: crumbs });
    expect(JSON.parse((second.proposal.changes as Array<{ after: string }>)[0]!.after).map((b: { "@type": string }) => b["@type"])).toEqual(["Organization", "BreadcrumbList"]);
    await approveAndApply(second.proposal.id);
    const html = await live("/a");
    expect(html.match(/application\/ld\+json/g)).toHaveLength(2);

    // A newer Organization replaces the old one instead of adding a second.
    const third = await schemaMarkup.proposeSchema({ projectId, orgId, actor: USER, url: `${siteUrl}/a`, jsonld: { ...org, name: "Files Ltd" } });
    expect(JSON.parse((third.proposal.changes as Array<{ after: string }>)[0]!.after).map((b: { "@type": string; name?: string }) => b.name ?? b["@type"])).toEqual(["BreadcrumbList", "Files Ltd"]);
  });
});
