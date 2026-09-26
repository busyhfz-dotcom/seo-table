/**
 * The Cloudflare edge connector against the Cloudflare API double.
 *
 * What must hold:
 *   - check() names exactly what is wrong: the token, the zone, the proxy
 *     setting, or the one permission the token lacks;
 *   - install is idempotent, refuses to take over another Worker's route, and
 *     uploads a worker the runtime can actually run; uninstall removes only
 *     what it installed;
 *   - rules written through the connector are what the real worker (in
 *     Miniflare) serves, and reads see through the worker with the bypass secret.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { cloudflare, type CloudflareCredentials } from "@seo/connectors";
import { MANIFEST_KEY, pageKey, redirectKey } from "../packages/connectors/src/edge/keys.js";
import { routeTestHostsToLocalhost } from "./dns-stub.js";
import { miniflareKv } from "./miniflare-kv.js";
import { ALL_PERMISSIONS, FAKE_CF_TOKEN, memoryKv, startFakeCloudflare, type CfPermission, type FakeCf, type KvStore } from "./fake-cloudflare.js";

const HOST = "shop.example.test";

function withToken(cf: FakeCf, permissions: CfPermission[], extra: Partial<{ status: "active" | "disabled"; accountOwned: boolean }> = {}): string {
  const token = `tok-${permissions.join("-")}-${extra.status ?? "active"}-${extra.accountOwned ? "acct" : "user"}`;
  cf.tokens.set(token, { status: extra.status ?? "active", permissions: new Set(permissions), ...(extra.accountOwned ? { accountOwned: true } : {}) });
  return token;
}

// ---------------------------------------------------------------------------

describe("check()", () => {
  let cf: FakeCf;
  const client = (over: Partial<CloudflareCredentials> = {}) =>
    cloudflare({ apiToken: FAKE_CF_TOKEN, siteUrl: `https://${HOST}/`, apiBase: cf.apiBase, ...over });

  beforeAll(async () => {
    cf = await startFakeCloudflare();
  });
  afterAll(() => cf.close());

  it("accepts a token that can do everything, and says the worker is not installed yet", async () => {
    const res = await client().check();
    expect(res.ok).toBe(true);
    expect(res.detail).toMatchObject({ zone: "example.test", hosts: [HOST, `www.${HOST}`], installed: false });
    expect(res.capabilities?.supportedActions).toEqual([]);
    expect(res.capabilities?.notes.join(" ")).toMatch(/not installed/);
  });

  it("works with an account-owned token that cannot use the user verify endpoint", async () => {
    const res = await client({ apiToken: withToken(cf, ALL_PERMISSIONS, { accountOwned: true }) }).check();
    expect(res.ok).toBe(true);
  });

  it("rejects an unknown or disabled token as invalid_token", async () => {
    expect((await client({ apiToken: "nope" }).check()).reason).toBe("invalid_token");
    expect((await client({ apiToken: withToken(cf, ALL_PERMISSIONS, { status: "disabled" }) }).check()).reason).toBe("invalid_token");
  });

  it.each([
    ["zone", "Zone → Zone → Read"],
    ["dns", "Zone → DNS → Read"],
    ["scripts", "Account → Workers Scripts → Edit"],
    ["kv", "Account → Workers KV Storage → Edit"],
    ["routes", "Zone → Workers Routes → Edit"],
  ] as const)("names the missing %s permission", async (missing, name) => {
    const token = withToken(cf, ALL_PERMISSIONS.filter((p) => p !== missing));
    const res = await client({ apiToken: token }).check();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("missing_permission");
    expect(res.detail).toEqual({ permission: name });
    // The token itself never appears in what is reported.
    expect(JSON.stringify(res)).not.toContain(token);
  });

  it("finds the zone by walking up the host's labels", async () => {
    cf.records.push({ id: "deep", zoneId: cf.zones[0]!.id, type: "A", name: `a.b.${HOST}`, proxied: true });
    expect((await client({ siteUrl: `https://a.b.${HOST}/` }).check()).detail).toMatchObject({ zone: "example.test", hosts: [`a.b.${HOST}`] });
  });

  it("reports a host outside every zone, a DNS-only host and a missing record", async () => {
    expect((await client({ siteUrl: "https://shop.elsewhere.test/" }).check()).reason).toBe("zone_not_found");
    expect((await client({ siteUrl: "https://grey.example.test/" }).check()).reason).toBe("not_proxied");
    expect((await client({ siteUrl: "https://nothing.example.test/" }).check()).reason).toBe("dns_record_missing");
  });

  it("reports a zone that is not active yet", async () => {
    const other = await startFakeCloudflare({ zoneName: "pending.test" });
    other.zones[0]!.status = "pending";
    const res = await cloudflare({ apiToken: FAKE_CF_TOKEN, siteUrl: "https://shop.pending.test/", apiBase: other.apiBase }).check();
    expect(res.reason).toBe("zone_not_active");
    await other.close();
  });
});

// ---------------------------------------------------------------------------

describe("install and uninstall", () => {
  let cf: FakeCf;
  const client = () => cloudflare({ apiToken: FAKE_CF_TOKEN, siteUrl: `https://${HOST}/`, apiBase: cf.apiBase });
  const posts = (path: RegExp) => cf.calls.filter((c) => c.method === "POST" && path.test(c.path)).length;

  beforeEach(async () => {
    cf = await startFakeCloudflare();
  });
  afterEach(() => cf.close());

  it("creates the store, the worker and both routes, and a second install changes nothing", async () => {
    const first = await client().install();
    expect(first.scriptName).toBe("seo-table-edge-7a0e1c2b");
    expect(first.routes.sort()).toEqual([`${HOST}/*`, `www.${HOST}/*`]);
    expect([...cf.namespaces.values()].map((n) => n.title)).toEqual(["seo-table-7a0e1c2b"]);

    const script = cf.scripts.get("seo-table-edge-7a0e1c2b")!;
    expect(script.metadata).toMatchObject({
      main_module: "worker.js",
      bindings: [{ type: "kv_namespace", name: "RULES", namespace_id: first.namespaceId }],
    });
    expect(Object.keys(script.modules).sort()).toEqual(["keys.js", "worker.js"]);
    expect(script.modules["worker.js"]!.type).toBe("application/javascript+module");
    expect(cf.subdomainCalls).toEqual([{ script: "seo-table-edge-7a0e1c2b", enabled: false }]);
    expect(await cf.kv.get("cfg:bypass")).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse((await cf.kv.get(MANIFEST_KEY))!)).toEqual({ v: 1, keys: [] });

    const bypass = await cf.kv.get("cfg:bypass");
    const routesBefore = posts(/workers\/routes$/);
    const second = await client().install();
    expect(second.routes.sort()).toEqual(first.routes.sort());
    expect(posts(/workers\/routes$/)).toBe(routesBefore);
    expect(posts(/kv\/namespaces$/)).toBe(1);
    expect(await cf.kv.get("cfg:bypass")).toBe(bypass);
    expect((await client().check()).detail).toMatchObject({ installed: true, outdated: false });
    expect((await client().capabilities()).supportedActions).toEqual(
      expect.arrayContaining(["TITLE_REWRITE", "META_REWRITE", "CANONICAL_FIX", "ROBOTS_FIX", "ALT_TEXT", "REDIRECT"]),
    );
  });

  it("routes only the twin that is proxied", async () => {
    cf.records.find((r) => r.name === `www.${HOST}`)!.proxied = false;
    expect((await client().install()).routes).toEqual([`${HOST}/*`]);
  });

  it("refuses to take over another Worker's route and changes nothing", async () => {
    cf.scripts.set("someone-elses", { metadata: {}, modules: {} });
    cf.routes.push({ id: "theirs", zoneId: cf.zones[0]!.id, pattern: `www.${HOST}/*`, script: "someone-elses" });
    await expect(client().install()).rejects.toMatchObject({ code: "route_conflict" });
    expect(cf.namespaces.size).toBe(0);
    expect(cf.scripts.has("seo-table-edge-7a0e1c2b")).toBe(false);
    const check = await client().check();
    expect(check.ok).toBe(true);
    expect(check.detail).toMatchObject({ conflicts: [{ pattern: `www.${HOST}/*`, script: "someone-elses" }] });
  });

  it("heals a manifest from the rules actually stored", async () => {
    await client().install();
    await cf.kv.put("p:shop.example.test/lost", JSON.stringify({ title: "Lost" }));
    await client().install();
    expect(JSON.parse((await cf.kv.get(MANIFEST_KEY))!).keys).toEqual(["p:shop.example.test/lost"]);
  });

  it("uninstall removes its routes and script, keeps the rules, and is repeatable", async () => {
    await client().install();
    await cf.kv.put("p:shop.example.test/x", "{}");
    cf.routes.push({ id: "other", zoneId: cf.zones[0]!.id, pattern: "blog.example.test/*", script: "someone-elses" });
    const res = await client().uninstall();
    expect(res.removedRoutes.sort()).toEqual([`${HOST}/*`, `www.${HOST}/*`]);
    expect(res.scriptDeleted).toBe(true);
    expect(cf.routes.map((r) => r.id)).toEqual(["other"]);
    expect(await cf.kv.get("p:shop.example.test/x")).toBe("{}");
    expect(await client().uninstall()).toEqual({ removedRoutes: [], scriptDeleted: false });
    expect((await client().capabilities()).supportedActions).toEqual([]);
  });

  it("keeps the script while another site of the zone still routes to it", async () => {
    await client().install();
    cf.routes.push({ id: "blog", zoneId: cf.zones[0]!.id, pattern: "blog.example.test/*", script: "seo-table-edge-7a0e1c2b" });
    const res = await client().uninstall();
    expect(res.scriptDeleted).toBe(false);
    expect(cf.scripts.has("seo-table-edge-7a0e1c2b")).toBe(true);
  });

  it("a permission missing at install time is named", async () => {
    const token = withToken(cf, ["zone", "dns", "routes", "scripts"]);
    await expect(cloudflare({ apiToken: token, siteUrl: `https://${HOST}/`, apiBase: cf.apiBase }).install()).rejects.toMatchObject({
      code: "missing_permission",
      detail: { permission: "Account → Workers KV Storage → Edit" },
    });
  });
});

// ---------------------------------------------------------------------------

describe("rules", () => {
  let cf: FakeCf;
  let kv: ReturnType<typeof memoryKv>;
  const url = `https://${HOST}/product/shoe`;
  const client = () => cloudflare({ apiToken: FAKE_CF_TOKEN, siteUrl: `https://${HOST}/`, apiBase: cf.apiBase });
  const manifest = async () => JSON.parse((await kv.get(MANIFEST_KEY))!).keys as string[];

  beforeAll(async () => {
    kv = memoryKv();
    cf = await startFakeCloudflare({ kv });
    await client().install();
  });
  afterAll(() => cf.close());

  it("writes a field, reports what it replaced, and removes the rule when the last field goes", async () => {
    const c = client();
    const key = await pageKey(url);
    expect(await c.write!({ url, field: "title", before: null, after: "Shoe  —  Shop" })).toMatchObject({ ok: true, previous: null, applied: "Shoe — Shop" });
    expect(await c.write!({ url, field: "meta_description", before: null, after: "Light shoe" })).toMatchObject({ ok: true });
    expect(JSON.parse((await kv.get(key))!)).toEqual({ title: "Shoe — Shop", description: "Light shoe" });
    expect(await manifest()).toContain(key);
    expect(await c.readStored({ url: `${url}?utm_source=x`, field: "title" })).toBe("Shoe — Shop");

    expect(await c.write!({ url, field: "title", before: "Shoe — Shop", after: "Better" })).toMatchObject({ previous: "Shoe — Shop" });
    await c.write!({ url, field: "title", before: null, after: null });
    await c.write!({ url, field: "meta_description", before: null, after: null });
    expect(await kv.get(key)).toBeNull();
    expect(await manifest()).not.toContain(key);
  });

  it("keeps image alts per image and matches them by address", async () => {
    const c = client();
    await c.write!({ url, field: "img.alt", before: null, after: "Red shoe", selector: "/wp-content/uploads/shoe.jpg" });
    await c.write!({ url, field: "img.alt", before: null, after: "Blue hat", selector: `https://${HOST}/wp-content/uploads/hat.jpg` });
    expect(await c.readStored({ url, field: "img.alt", selector: `http://${HOST}/wp-content/uploads/shoe.jpg` })).toBe("Red shoe");
    const rule = JSON.parse((await kv.get(await pageKey(url)))!);
    expect(Object.keys(rule.alts)).toHaveLength(2);
    await c.write!({ url, field: "img.alt", before: null, after: null, selector: "/wp-content/uploads/shoe.jpg" });
    await c.write!({ url, field: "img.alt", before: null, after: null, selector: "/wp-content/uploads/hat.jpg" });
    expect(await kv.get(await pageKey(url))).toBeNull();
  });

  it("redirects: same-site, off-site marked external, never to itself or back", async () => {
    const c = client();
    const from = `https://${HOST}/old`;
    expect(await c.write!({ url: from, field: "redirect", before: null, after: `https://www.${HOST}/new` })).toMatchObject({ ok: true, applied: `https://www.${HOST}/new` });
    expect(JSON.parse((await kv.get(await redirectKey(from)))!)).toEqual({ to: `https://www.${HOST}/new`, status: 301 });
    expect(await c.read!({ url: from, field: "redirect" })).toBe(`https://www.${HOST}/new`);

    expect(await c.write!({ url: `https://${HOST}/new`, field: "redirect", before: null, after: from })).toMatchObject({ ok: false, code: "redirect_loop" });
    expect(await c.write!({ url: from, field: "redirect", before: null, after: `${from}?utm_source=x` })).toMatchObject({ ok: false, code: "redirect_loop" });
    await c.write!({ url: `https://${HOST}/partner`, field: "redirect", before: null, after: "https://partner.test/x" });
    expect(JSON.parse((await kv.get(await redirectKey(`https://${HOST}/partner`)))!)).toMatchObject({ external: true });
    expect(await c.write!({ url: from, field: "redirect", before: null, after: null })).toMatchObject({ ok: true, previous: `https://www.${HOST}/new` });
    expect(await c.read!({ url: from, field: "redirect" })).toBeNull();
  });

  it("refuses invalid values and other sites' addresses without writing", async () => {
    const c = client();
    const before = kv.data.size;
    expect(await c.write!({ url, field: "canonical", before: null, after: "javascript:alert(1)" })).toMatchObject({ ok: false, code: "invalid_value" });
    expect(await c.write!({ url, field: "meta_robots", before: null, after: '"><script>' })).toMatchObject({ ok: false, code: "invalid_value" });
    expect(await c.write!({ url, field: "jsonld", before: null, after: "{bad" })).toMatchObject({ ok: false, code: "invalid_value" });
    expect(await c.write!({ url, field: "title", before: null, after: "   " })).toMatchObject({ ok: false, code: "invalid_value" });
    expect(await c.write!({ url, field: "headings", before: null, after: "x" })).toMatchObject({ ok: false, code: "unsupported_field" });
    expect(await c.write!({ url: "https://evil.test/x", field: "title", before: null, after: "x" })).toMatchObject({ ok: false, code: "url_outside_site" });
    expect(kv.data.size).toBe(before);
  });

  it("stores JSON-LD and hreflang as validated JSON", async () => {
    const c = client();
    await c.write!({ url, field: "jsonld", before: null, after: JSON.stringify({ "@type": "Product", name: "Shoe" }) });
    await c.write!({ url, field: "hreflang", before: null, after: JSON.stringify([{ lang: "fa", href: "/product/shoe" }]) });
    expect(JSON.parse((await c.readStored({ url, field: "hreflang" }))!)).toEqual([{ lang: "fa", href: url }]);
    expect(JSON.parse((await c.read!({ url, field: "jsonld" }))!)).toEqual([{ "@type": "Product", name: "Shoe" }]);
    await c.write!({ url, field: "jsonld", before: null, after: null });
    await c.write!({ url, field: "hreflang", before: null, after: null });
  });
});

// ---------------------------------------------------------------------------

describe("end to end through the real worker", () => {
  let cf: FakeCf;
  let mf: Miniflare;
  let edge: Server;
  let siteUrl: string;
  let persist: string;
  const origin = new Map<string, string>();

  const page = (title: string, extra = "") =>
    `<html><head><title>${title}</title><meta name="description" content="origin description">${extra}</head><body><img src="/img/shoe-300x200.jpg"></body></html>`;

  // Re-fetched per call: setOptions replaces the runtime the binding lives in.
  const kvAdapter = (): KvStore => ({
    get: async (k) => (await miniflareKv(mf)).get(k),
    put: async (k, v) => (await miniflareKv(mf)).put(k, v),
    delete: async (k) => (await miniflareKv(mf)).delete(k),
    list: async (prefix) => (await (await miniflareKv(mf)).list({ prefix })).keys.map((k) => k.name),
  });

  const baseOptions = () => ({
    kvNamespaces: ["RULES"],
    kvPersist: persist,
    compatibilityDate: "2025-09-01",
    outboundService: (request: Request) => {
      const body = origin.get(new URL(request.url).pathname);
      return body ? new Response(body, { headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 });
    },
  });

  /** Load what the connector uploaded, in a fresh isolate (an empty rule cache). */
  async function deployUploadedWorker(): Promise<void> {
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
  const client = () => cloudflare({ apiToken: FAKE_CF_TOKEN, siteUrl: `${siteUrl}/`, apiBase: cf.apiBase });

  beforeAll(async () => {
    routeTestHostsToLocalhost();
    persist = mkdtempSync(join(tmpdir(), "seo-edge-"));
    mf = new Miniflare({ ...baseOptions(), modules: true, script: "export default { fetch: () => new Response('placeholder') }" });
    cf = await startFakeCloudflare({ kv: kvAdapter() });
    // The "edge": every request for the site goes through the worker.
    edge = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      const out = await mf.dispatchFetch(`http://${req.headers.host}${req.url}`, { method: req.method, headers, redirect: "manual" } as never);
      const outHeaders: Record<string, string> = {};
      out.headers.forEach((value, name) => (outHeaders[name] = value));
      res.writeHead(out.status, outHeaders);
      res.end(Buffer.from(await out.arrayBuffer()));
    });
    await new Promise<void>((r) => edge.listen(0, "127.0.0.1", r));
    const port = (edge.address() as { port: number }).port;
    siteUrl = `http://${HOST}:${port}`;
    origin.set("/product/shoe", page("Origin title"));
    origin.set("/other", page("Other"));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((r) => edge.close(() => r()));
    await cf.close();
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  });

  it("serves what the connector wrote, and reads see the site's own value", async () => {
    await client().install();
    await deployUploadedWorker();
    const res = await fetch(`${siteUrl}/product/shoe`);
    expect(res.headers.get("x-seo-table-edge")).toBe("1");
    expect(await res.text()).toContain("<title>Origin title</title>");

    const c = client();
    const url = `${siteUrl}/product/shoe`;
    expect(await c.read!({ url, field: "title" })).toBe("Origin title");
    expect(await c.read!({ url, field: "img.alt", selector: "/img/shoe-300x200.jpg" })).toBeNull();
    await c.write!({ url, field: "title", before: "Origin title", after: "Edge title" });
    await c.write!({ url, field: "img.alt", before: null, after: "A shoe", selector: "/img/shoe-300x200.jpg" });
    await deployUploadedWorker();

    const html = await live("/product/shoe?utm_campaign=x");
    expect(html).toContain("<title>Edge title</title>");
    expect(html).toContain('alt="A shoe"');
    // What visitors get vs. what the edge holds vs. what the site itself says.
    expect(await c.read!({ url, field: "title" })).toBe("Edge title");
    expect(await c.readStored({ url, field: "title" })).toBe("Edge title");
    expect(await c.read!({ url, field: "meta_description" })).toBe("origin description");
    expect(await c.readStored({ url, field: "meta_description" })).toBeNull();
  });

  it("redirects at the edge", async () => {
    const c = client();
    await c.write!({ url: `${siteUrl}/gone`, field: "redirect", before: null, after: `${siteUrl}/other` });
    await deployUploadedWorker();
    const res = await fetch(`${siteUrl}/gone`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${siteUrl}/other`);
  });

  it("refuses to read the site's value when the worker does not honour the bypass", async () => {
    const c = client();
    expect(await c.read!({ url: `${siteUrl}/other`, field: "title" })).toBe("Other");
    // The secret changes under a client that already holds the old one.
    await (await miniflareKv(mf)).put("cfg:bypass", "rotated-elsewhere");
    await deployUploadedWorker();
    await expect(c.read!({ url: `${siteUrl}/other`, field: "title" })).rejects.toMatchObject({ code: "bypass_failed" });
  });
});
