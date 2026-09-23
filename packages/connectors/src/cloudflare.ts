/**
 * Cloudflare "edge SEO" connector — fixes applied at Cloudflare's edge, with
 * nothing installed on the site.
 *
 * Install puts three things in the customer's Cloudflare account, all named
 * after the zone so several sites in one account never collide:
 *   - a Workers KV namespace `seo-table-<zone8>` holding the rules;
 *   - a Worker `seo-table-edge-<zone8>` (src/edge/worker.js + keys.js) bound
 *     to it as RULES;
 *   - a route `<host>/*` (and the www/apex twin when that is proxied too).
 * Every step is idempotent, and a route that already belongs to another
 * Worker stops the install before anything is changed.
 *
 * Reads and writes follow the WordPress connector's contract, with one
 * addition that makes rollback exact:
 *   - read() returns the value visitors get: the edge rule when one exists,
 *     otherwise the site's own value, read from the live page with the bypass
 *     secret so the worker steps aside. Drift checks therefore compare like
 *     with like — the scan also saw the rendered page.
 *   - readStored() returns only the edge rule (null when the site's own value
 *     is in effect). The executor records it, and rollback writes it back:
 *     undoing a fix removes the override instead of pinning the old text at the
 *     edge, so a later edit in the CMS shows through again.
 *   - write(null) deletes the override; `previous` is the override it replaced.
 *
 * Uninstall removes the routes and, once no route uses it, the script. The KV
 * namespace is kept on purpose: it is the record of what the edge applied,
 * rollback can still remove rules from it, and a reinstall resumes from it.
 */
import { randomBytes } from "node:crypto";
import type { FixAction } from "@seo/db";
import { BlockedAddressError, env, guardedFetch } from "@seo/core";
import {
  BYPASS_HEADER,
  BYPASS_KEY,
  CACHE_BUSTER,
  EDGE_HEADER,
  MANIFEST_KEY,
  fileKey,
  imageKey,
  isFilePath,
  pageKey,
  redirectKey,
} from "./edge/keys.js";
import { WORKER_MODULES, WORKER_VERSION } from "./edge/worker-source.js";
import { fetchLivePage, liveField } from "./live-page.js";
import {
  ConnectorError,
  httpJson,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorHealth,
  type WriteRequest,
  type WriteResult,
} from "./types.js";

export type CloudflareCredentials = {
  /** A Cloudflare API token (never the Global API Key). Stored sealed; never logged. */
  apiToken: string;
  /** The project's site; its host decides the zone and the routes. */
  siteUrl: string;
  /** Test seam for a fake API. Set only by the server, never from a request. */
  apiBase?: string;
};

const API = "https://api.cloudflare.com/client/v4";
const COMPATIBILITY_DATE = "2025-09-01";
const VERSION_KEY = "cfg:version";
const PAGE_FIELDS = ["title", "meta_description", "canonical", "meta_robots", "img.alt", "jsonld", "hreflang"] as const;
/** Whole files the worker serves in place of the origin's (keys.js isFilePath decides which paths). */
const FILE_FIELDS: Record<string, FileRule["kind"]> = { robots_txt: "robots", sitemap_xml: "sitemap" };
const WRITABLE_FIELDS = [...PAGE_FIELDS, "redirect", ...Object.keys(FILE_FIELDS)];
const SUPPORTED_ACTIONS: FixAction[] = [
  "TITLE_REWRITE",
  "META_REWRITE",
  "CANONICAL_FIX",
  "ROBOTS_FIX",
  "ALT_TEXT",
  "REDIRECT",
  "SCHEMA_MARKUP",
  "ROBOTS_TXT",
  "SITEMAP_XML",
];
/** Google reads at most 500 KiB of robots.txt; a larger file is a mistake, not a rule set. */
const MAX_ROBOTS_BYTES = 500 * 1024;
/** Under Workers KV's 25 MiB value limit, with room for the worker to hold it in memory. */
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
/** Rule document property for each page field. */
const RULE_PROP: Record<(typeof PAGE_FIELDS)[number], keyof PageRule> = {
  title: "title",
  meta_description: "description",
  canonical: "canonical",
  meta_robots: "robots",
  "img.alt": "alts",
  jsonld: "jsonld",
  hreflang: "hreflang",
};

/**
 * The token permissions each call needs, as Cloudflare's token editor names
 * them — a 403 names the one to add instead of a generic "not allowed".
 */
export const CLOUDFLARE_PERMISSIONS = {
  zoneRead: "Zone → Zone → Read",
  dnsRead: "Zone → DNS → Read",
  routes: "Zone → Workers Routes → Edit",
  scripts: "Account → Workers Scripts → Edit",
  kv: "Account → Workers KV Storage → Edit",
} as const;
type PermissionName = (typeof CLOUDFLARE_PERMISSIONS)[keyof typeof CLOUDFLARE_PERMISSIONS];

type PageRule = {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  alts?: Record<string, string>;
  jsonld?: string[];
  hreflang?: Array<{ lang: string; href: string }>;
};
type RedirectRule = { to: string; status: number; external?: true };
type FileRule = { kind: "robots" | "sitemap"; body: string };
type Manifest = { v: 1; keys: string[] };

type Envelope<T> = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  result_info?: { page?: number; total_pages?: number; cursor?: string };
};
type Zone = { id: string; name: string; status: string; account: { id: string; name?: string } };
type DnsRecord = { id: string; type: string; name: string; proxied?: boolean };
type Route = { id: string; pattern: string; script?: string | null };
type Namespace = { id: string; title: string };

/** Everything install needs to know about the site's place in Cloudflare. */
export type EdgeSite = {
  zone: { id: string; name: string; accountId: string };
  host: string;
  /** Hosts the worker runs on: the site's host, plus its www/apex twin when that is proxied too. */
  hosts: string[];
  scriptName: string;
  namespaceTitle: string;
};

export type EdgeStatus = {
  installed: boolean;
  /** The deployed worker predates this build; reinstall to update it. */
  outdated: boolean;
  routes: string[];
  /** Routes on these hosts that belong to another Worker. */
  conflicts: Array<{ pattern: string; script: string | null }>;
  /** More specific routes of other Workers that take those paths away from ours. */
  shadowed: string[];
};

export type InstallResult = { scriptName: string; namespaceId: string; routes: string[]; notes: string[] };

// Error codes Cloudflare uses for a token that is malformed, expired or revoked.
const INVALID_TOKEN_CODES = new Set([1000, 1001, 6003, 6111, 9106, 9109]);

export function cloudflare(creds: CloudflareCredentials): Connector & {
  install: () => Promise<InstallResult>;
  uninstall: () => Promise<{ removedRoutes: string[]; scriptDeleted: boolean }>;
  status: () => Promise<EdgeStatus & { site: EdgeSite }>;
  readStored: (req: Pick<WriteRequest, "url" | "field" | "selector">) => Promise<string | null>;
} {
  const base = (creds.apiBase ?? API).replace(/\/+$/, "");
  const siteHost = new URL(creds.siteUrl).hostname.toLowerCase();
  const auth = { authorization: `Bearer ${creds.apiToken}` };

  let siteCache: EdgeSite | null = null;
  let namespaceCache: string | null = null;
  let bypassCache: string | null = null;

  // ---- API plumbing -----------------------------------------------------------

  async function call<T>(
    method: string,
    path: string,
    permission: PermissionName,
    init: { body?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; envelope: Envelope<T> | null; text: string }> {
    const res = await httpJson<Envelope<T>>(`${base}${path}`, {
      method,
      headers: { ...auth, accept: "application/json", ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
      timeoutMs: 30_000,
    });
    const codes = (res.data?.errors ?? []).map((e) => e.code ?? 0);
    // A malformed token comes back as 400, a revoked one as 401 or 403.
    if (res.status >= 400 && res.status < 404 && codes.some((c) => INVALID_TOKEN_CODES.has(c))) {
      throw new ConnectorError("invalid_token", "Cloudflare rejected the API token (invalid, expired or revoked).");
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError("missing_permission", `The API token lacks the "${permission}" permission.`, { permission });
    }
    return { status: res.status, envelope: res.data, text: res.text };
  }

  async function ok<T>(
    method: string,
    path: string,
    permission: PermissionName,
    init: { body?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {},
  ): Promise<Envelope<T>> {
    const res = await call<T>(method, path, permission, init);
    if (res.status >= 400 || !res.envelope?.success) {
      const first = res.envelope?.errors?.[0];
      throw new ConnectorError(
        "cloudflare_error",
        `Cloudflare answered HTTP ${res.status}${first ? ` (${first.code}: ${first.message})` : ""} for ${method} ${path.split("?")[0]}`,
        { status: res.status, code: first?.code ?? null },
      );
    }
    return res.envelope;
  }

  async function all<T>(path: string, permission: PermissionName): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const env = await ok<T[]>("GET", `${path}${sep}page=${page}&per_page=100`, permission);
      out.push(...(env.result ?? []));
      const total = env.result_info?.total_pages ?? 1;
      if (page >= total) break;
    }
    return out;
  }

  // ---- where the site lives ---------------------------------------------------

  /** The zone serving the host: the longest suffix of it that is a zone in this account. */
  async function findZone(): Promise<Zone> {
    const labels = siteHost.split(".");
    for (let i = 0; i <= labels.length - 2; i++) {
      const candidate = labels.slice(i).join(".");
      const env = await ok<Zone[]>("GET", `/zones?name=${encodeURIComponent(candidate)}`, CLOUDFLARE_PERMISSIONS.zoneRead);
      const zone = env.result?.[0];
      if (!zone) continue;
      if (zone.status !== "active") {
        throw new ConnectorError(
          "zone_not_active",
          `The zone ${zone.name} is "${zone.status}" in Cloudflare; it must be active (nameservers pointing to Cloudflare).`,
          { zone: zone.name, status: zone.status },
        );
      }
      return zone;
    }
    throw new ConnectorError(
      "zone_not_found",
      `No Cloudflare zone this token can read serves ${siteHost}. Add the site to this Cloudflare account, or give the token access to its zone.`,
      { host: siteHost },
    );
  }

  async function records(zoneId: string, host: string): Promise<DnsRecord[]> {
    const env = await ok<DnsRecord[]>(
      "GET",
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}&per_page=100`,
      CLOUDFLARE_PERMISSIONS.dnsRead,
    );
    return (env.result ?? []).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type) && r.name.toLowerCase() === host);
  }

  async function site(): Promise<EdgeSite> {
    if (siteCache) return siteCache;
    const zone = await findZone();
    const own = await records(zone.id, siteHost);
    if (own.length === 0) {
      throw new ConnectorError("dns_record_missing", `${siteHost} has no A, AAAA or CNAME record in the ${zone.name} zone.`, {
        host: siteHost,
      });
    }
    if (own.some((r) => !r.proxied)) {
      throw new ConnectorError(
        "not_proxied",
        `${siteHost} is DNS-only (grey cloud) in Cloudflare, so its traffic never reaches Cloudflare's edge. Turn on the proxy (orange cloud) for it.`,
        { host: siteHost },
      );
    }
    const twin = siteHost.startsWith("www.") ? siteHost.slice(4) : `www.${siteHost}`;
    const hosts = [siteHost];
    if (twin.endsWith(zone.name)) {
      const twinRecords = await records(zone.id, twin);
      if (twinRecords.length > 0 && twinRecords.every((r) => r.proxied)) hosts.push(twin);
    }
    const short = zone.id.slice(0, 8);
    siteCache = {
      zone: { id: zone.id, name: zone.name, accountId: zone.account.id },
      host: siteHost,
      hosts,
      scriptName: `seo-table-edge-${short}`,
      namespaceTitle: `seo-table-${short}`,
    };
    return siteCache;
  }

  // ---- KV ---------------------------------------------------------------------

  async function findNamespace(s: EdgeSite): Promise<string | null> {
    if (namespaceCache) return namespaceCache;
    const list = await all<Namespace>(`/accounts/${s.zone.accountId}/storage/kv/namespaces`, CLOUDFLARE_PERMISSIONS.kv);
    namespaceCache = list.find((n) => n.title === s.namespaceTitle)?.id ?? null;
    return namespaceCache;
  }

  async function namespace(): Promise<{ s: EdgeSite; ns: string }> {
    const s = await site();
    const ns = await findNamespace(s);
    if (!ns) throw new ConnectorError("edge_not_installed", "The edge worker is not installed for this site yet.");
    return { s, ns };
  }

  const valuePath = (s: EdgeSite, ns: string, key: string) =>
    `/accounts/${s.zone.accountId}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`;

  async function kvGet(key: string): Promise<string | null> {
    const { s, ns } = await namespace();
    const res = await call<unknown>("GET", valuePath(s, ns, key), CLOUDFLARE_PERMISSIONS.kv);
    if (res.status === 404) return null;
    if (res.status >= 400) throw new ConnectorError("cloudflare_error", `Reading an edge rule failed (HTTP ${res.status}).`);
    return res.text;
  }

  async function kvGetJson<T>(key: string): Promise<T | null> {
    const text = await kvGet(key);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ConnectorError("corrupt_rule", `The edge rule ${key} is not valid JSON; fix or delete it in the KV namespace.`);
    }
  }

  async function kvPut(key: string, value: string): Promise<void> {
    const { s, ns } = await namespace();
    const form = multipart([{ name: "value", body: value }]);
    await ok("PUT", valuePath(s, ns, key), CLOUDFLARE_PERMISSIONS.kv, form);
  }

  async function kvDelete(key: string): Promise<void> {
    const { s, ns } = await namespace();
    const res = await call<unknown>("DELETE", valuePath(s, ns, key), CLOUDFLARE_PERMISSIONS.kv);
    if (res.status >= 400 && res.status !== 404) {
      throw new ConnectorError("cloudflare_error", `Deleting an edge rule failed (HTTP ${res.status}).`);
    }
  }

  async function listRuleKeys(): Promise<string[]> {
    const { s, ns } = await namespace();
    const out: string[] = [];
    for (const prefix of ["p", "r", "f"]) {
      let cursor = "";
      for (let i = 0; i < 1000; i++) {
        const env = await ok<Array<{ name: string }>>(
          "GET",
          `/accounts/${s.zone.accountId}/storage/kv/namespaces/${ns}/keys?prefix=${prefix}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          CLOUDFLARE_PERMISSIONS.kv,
        );
        out.push(...(env.result ?? []).map((k) => k.name).filter(isRuleKey));
        cursor = env.result_info?.cursor ?? "";
        if (!cursor) break;
      }
    }
    return out;
  }

  /**
   * Add or remove one key in the manifest the worker consults before any rule
   * lookup. Read-modify-write, then verified: two writers racing could each
   * drop the other's key, so the change is re-read and retried until it holds.
   */
  async function updateManifest(add: string | null, remove: string | null): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const keys = new Set((await kvGetJson<Manifest>(MANIFEST_KEY))?.keys ?? []);
      if (add) keys.add(add);
      if (remove) keys.delete(remove);
      await kvPut(MANIFEST_KEY, JSON.stringify({ v: 1, keys: [...keys].sort() } satisfies Manifest));
      const check = new Set((await kvGetJson<Manifest>(MANIFEST_KEY))?.keys ?? []);
      if ((!add || check.has(add)) && (!remove || !check.has(remove))) return;
    }
    throw new ConnectorError("manifest_conflict", "The edge rule index kept changing underneath this write; try again.");
  }

  // ---- install state ------------------------------------------------------------

  async function routes(s: EdgeSite): Promise<Route[]> {
    const env = await ok<Route[]>("GET", `/zones/${s.zone.id}/workers/routes`, CLOUDFLARE_PERMISSIONS.routes);
    return env.result ?? [];
  }

  async function status(): Promise<EdgeStatus & { site: EdgeSite }> {
    const s = await site();
    const list = await routes(s);
    const wanted = new Set(s.hosts.map((h) => `${h}/*`));
    const ours = list.filter((r) => r.script === s.scriptName && wanted.has(r.pattern));
    const conflicts = list
      .filter((r) => wanted.has(r.pattern) && r.script !== s.scriptName)
      .map((r) => ({ pattern: r.pattern, script: r.script ?? null }));
    const shadowed = list
      .filter((r) => r.script !== s.scriptName && !wanted.has(r.pattern) && s.hosts.some((h) => r.pattern.startsWith(`${h}/`)))
      .map((r) => r.pattern);
    const ns = await findNamespace(s);
    let outdated = false;
    if (ns && ours.length > 0) outdated = (await kvGet(VERSION_KEY)) !== WORKER_VERSION;
    return { site: s, installed: Boolean(ns) && ours.length === s.hosts.length, outdated, routes: ours.map((r) => r.pattern), conflicts, shadowed };
  }

  // ---- connector contract -------------------------------------------------------

  async function capabilities(): Promise<ConnectorCapabilities> {
    const st = await status();
    if (!st.installed) {
      return {
        writableFields: [],
        supportedActions: [],
        notes: ["Cloudflare edge worker is not installed yet: install it to apply fixes at the edge."],
      };
    }
    const notes = [
      "Cloudflare edge: title, meta description, canonical, robots, image alt text, redirects, JSON-LD, robots.txt and sitemap files are applied at Cloudflare's edge; nothing is installed on the site.",
      "Edge changes reach every Cloudflare location within about a minute.",
    ];
    if (st.outdated) notes.push("The edge worker on Cloudflare is outdated: reinstall it to update.");
    if (st.shadowed.length) notes.push(`Other Workers own these routes, so those paths are not rewritten: ${st.shadowed.join(", ")}`);
    return { writableFields: [...WRITABLE_FIELDS], supportedActions: [...SUPPORTED_ACTIONS], notes };
  }

  async function check(): Promise<ConnectorHealth & { capabilities?: ConnectorCapabilities }> {
    try {
      // Account-owned tokens cannot use the user endpoint and fail it; the zone
      // lookup below then proves (or disproves) the token instead.
      const verify = await call<{ status?: string }>("GET", "/user/tokens/verify", CLOUDFLARE_PERMISSIONS.zoneRead).catch(() => null);
      const tokenStatus = verify?.status === 200 ? verify.envelope?.result?.status : undefined;
      if (tokenStatus && tokenStatus !== "active") {
        return { ok: false, reason: "invalid_token", message: `The API token is ${tokenStatus}.` };
      }
      const s = await site();
      // Read probes for everything install needs, so a missing permission is
      // named now rather than half-way through an install.
      await all<{ id: string }>(`/accounts/${s.zone.accountId}/workers/scripts`, CLOUDFLARE_PERMISSIONS.scripts);
      await findNamespace(s);
      const st = await status();
      const caps = await capabilities();
      const detail = {
        zone: s.zone.name,
        hosts: s.hosts,
        installed: st.installed,
        outdated: st.outdated,
        conflicts: st.conflicts,
      };
      if (st.conflicts.length > 0) {
        caps.notes.push(
          `Another Worker already serves ${st.conflicts.map((c) => c.pattern).join(", ")}; the edge worker cannot be installed until that route is removed.`,
        );
      }
      return { ok: true, message: `Connected to Cloudflare zone ${s.zone.name}.`, capabilities: caps, detail };
    } catch (err) {
      if (err instanceof ConnectorError) return { ok: false, reason: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) };
      return { ok: false, reason: "network_error", message: (err as Error).message };
    }
  }

  async function install(): Promise<InstallResult> {
    const s = await site();
    const before = await status();
    if (before.conflicts.length > 0) {
      throw new ConnectorError(
        "route_conflict",
        `Another Worker already serves ${before.conflicts.map((c) => `${c.pattern} (${c.script ?? "disabled route"})`).join(", ")}. Nothing was changed.`,
        { conflicts: before.conflicts },
      );
    }

    // 1. Rules store. The bypass secret is written before any route exists, so
    //    no edge location can have cached its absence.
    let ns = await findNamespace(s);
    if (!ns) {
      const created = await ok<Namespace>("POST", `/accounts/${s.zone.accountId}/storage/kv/namespaces`, CLOUDFLARE_PERMISSIONS.kv, {
        body: JSON.stringify({ title: s.namespaceTitle }),
        headers: { "content-type": "application/json" },
      });
      ns = created.result?.id ?? null;
      if (!ns) throw new ConnectorError("cloudflare_error", "Cloudflare did not return the new KV namespace.");
      namespaceCache = ns;
    }
    if (!(await kvGet(BYPASS_KEY))) await kvPut(BYPASS_KEY, randomBytes(32).toString("hex"));
    // Heal a manifest that lost keys (or never existed) from what is actually stored.
    const stored = new Set([...((await kvGetJson<Manifest>(MANIFEST_KEY))?.keys ?? []), ...(await listRuleKeys())]);
    await kvPut(MANIFEST_KEY, JSON.stringify({ v: 1, keys: [...stored].sort() } satisfies Manifest));

    // 2. The worker, bound to the store. PUT replaces, so a reinstall updates it.
    const metadata = {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [{ type: "kv_namespace", name: "RULES", namespace_id: ns }],
    };
    await ok("PUT", `/accounts/${s.zone.accountId}/workers/scripts/${s.scriptName}`, CLOUDFLARE_PERMISSIONS.scripts, multipart([
      { name: "metadata", body: JSON.stringify(metadata), type: "application/json", filename: "blob" },
      { name: "worker.js", body: WORKER_MODULES["worker.js"], type: "application/javascript+module", filename: "worker.js" },
      { name: "keys.js", body: WORKER_MODULES["keys.js"], type: "application/javascript+module", filename: "keys.js" },
    ]));
    // The worker only makes sense on the site's own hostnames; a workers.dev
    // address would just proxy to nowhere. Best effort: older accounts reject it.
    await call("POST", `/accounts/${s.zone.accountId}/workers/scripts/${s.scriptName}/subdomain`, CLOUDFLARE_PERMISSIONS.scripts, {
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    }).catch(() => undefined);
    await kvPut(VERSION_KEY, WORKER_VERSION);

    // 3. Routes last: the worker starts serving only once everything it reads exists.
    const existing = await routes(s);
    const created: string[] = [];
    for (const host of s.hosts) {
      const pattern = `${host}/*`;
      if (existing.some((r) => r.pattern === pattern && r.script === s.scriptName)) continue;
      await ok("POST", `/zones/${s.zone.id}/workers/routes`, CLOUDFLARE_PERMISSIONS.routes, {
        body: JSON.stringify({ pattern, script: s.scriptName }),
        headers: { "content-type": "application/json" },
      });
      created.push(pattern);
    }

    const after = await status();
    const notes = after.shadowed.length ? [`Other Workers own these routes, so those paths are not rewritten: ${after.shadowed.join(", ")}`] : [];
    return { scriptName: s.scriptName, namespaceId: ns, routes: after.routes, notes };
  }

  async function uninstall(): Promise<{ removedRoutes: string[]; scriptDeleted: boolean }> {
    const s = await site();
    const list = await routes(s);
    const wanted = new Set(s.hosts.map((h) => `${h}/*`));
    const removed: string[] = [];
    for (const r of list) {
      if (r.script !== s.scriptName || !wanted.has(r.pattern)) continue;
      await ok("DELETE", `/zones/${s.zone.id}/workers/routes/${r.id}`, CLOUDFLARE_PERMISSIONS.routes);
      removed.push(r.pattern);
    }
    // Another site of the same zone may still use the script.
    const stillUsed = list.some((r) => r.script === s.scriptName && !removed.includes(r.pattern));
    let scriptDeleted = false;
    if (!stillUsed) {
      const res = await call("DELETE", `/accounts/${s.zone.accountId}/workers/scripts/${s.scriptName}?force=true`, CLOUDFLARE_PERMISSIONS.scripts);
      if (res.status >= 400 && res.status !== 404) {
        throw new ConnectorError("cloudflare_error", `Deleting the edge worker failed (HTTP ${res.status}).`);
      }
      scriptDeleted = res.status < 400;
    }
    return { removedRoutes: removed, scriptDeleted };
  }

  // ---- read / write -------------------------------------------------------------

  function assertOnSite(url: string): void {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new ConnectorError("url_outside_site", `${url} is not a valid address`);
    }
    if (!siteCache?.hosts.includes(host) && host !== siteHost) {
      throw new ConnectorError("url_outside_site", `${url} is not an address on ${siteHost}`);
    }
  }

  async function readStored(req: Pick<WriteRequest, "url" | "field" | "selector">): Promise<string | null> {
    await site();
    assertOnSite(req.url);
    if (req.field === "redirect") return (await kvGetJson<RedirectRule>(await redirectKey(req.url)))?.to ?? null;
    if (FILE_FIELDS[req.field]) {
      assertFilePath(req.url, req.field);
      return (await kvGetJson<FileRule>(await fileKey(req.url)))?.body ?? null;
    }
    const rule = (await kvGetJson<PageRule>(await pageKey(req.url))) ?? {};
    return ruleValue(rule, req.field, req.url, req.selector);
  }

  async function bypassSecret(): Promise<string> {
    if (bypassCache) return bypassCache;
    const secret = await kvGet(BYPASS_KEY);
    if (!secret) throw new ConnectorError("edge_not_installed", "The edge worker is not installed for this site yet.");
    bypassCache = secret;
    return secret;
  }

  async function read(req: Pick<WriteRequest, "url" | "field" | "selector">): Promise<string | null> {
    const override = await readStored(req);
    if (override !== null || req.field === "redirect" || req.field === "jsonld" || req.field === "hreflang") return override;
    if (FILE_FIELDS[req.field]) return readOriginFile(req.url, await bypassSecret());
    const page = await fetchLivePage(req.url, { [BYPASS_HEADER]: await bypassSecret() });
    // A rewritten response means the worker did not recognise the secret (still
    // propagating, or tampered with): the site's own value is not what we got.
    if (page.headers.get(EDGE_HEADER) === "1") {
      throw new ConnectorError(
        "bypass_failed",
        "The edge worker did not step aside for the panel's read; the edge may still be updating. Try again in a minute.",
      );
    }
    return liveField(page, req.field, req.selector);
  }

  async function write(req: WriteRequest): Promise<WriteResult> {
    const fail = (code: string, error: string): WriteResult => ({ url: req.url, field: req.field, ok: false, code, error });
    try {
      await site();
      assertOnSite(req.url);
      if (!WRITABLE_FIELDS.includes(req.field)) {
        return fail("unsupported_field", `The Cloudflare edge cannot write "${req.field}".`);
      }

      const fileKind = FILE_FIELDS[req.field];
      if (fileKind) {
        assertFilePath(req.url, req.field);
        const key = await fileKey(req.url);
        const previous = (await kvGetJson<FileRule>(key))?.body ?? null;
        if (req.after === null) {
          await kvDelete(key);
          await updateManifest(null, key);
          return { url: req.url, field: req.field, ok: true, applied: null, previous };
        }
        const body = fileBody(fileKind, req.after);
        await kvPut(key, JSON.stringify({ kind: fileKind, body } satisfies FileRule));
        await updateManifest(key, null);
        return { url: req.url, field: req.field, ok: true, applied: body, previous };
      }

      if (req.field === "redirect") {
        const key = await redirectKey(req.url);
        const previous = (await kvGetJson<RedirectRule>(key))?.to ?? null;
        if (req.after === null) {
          await kvDelete(key);
          await updateManifest(null, key);
          return { url: req.url, field: req.field, ok: true, applied: null, previous };
        }
        const rule = await redirectRule(req.url, req.after);
        await kvPut(key, JSON.stringify(rule));
        await updateManifest(key, null);
        return { url: req.url, field: req.field, ok: true, applied: rule.to, previous };
      }

      const key = await pageKey(req.url);
      const rule = (await kvGetJson<PageRule>(key)) ?? {};
      const previous = ruleValue(rule, req.field, req.url, req.selector);
      const next = withValue(rule, req.field, req.after, req.url, req.selector);
      if (Object.keys(next).length === 0) {
        await kvDelete(key);
        await updateManifest(null, key);
      } else {
        await kvPut(key, JSON.stringify(next));
        await updateManifest(key, null);
      }
      return { url: req.url, field: req.field, ok: true, applied: ruleValue(next, req.field, req.url, req.selector), previous };
    } catch (err) {
      if (err instanceof ConnectorError) return fail(err.code, err.message);
      return fail("network_error", (err as Error).message);
    }
  }

  /** A redirect rule the worker will honour: absolute, http(s), never to itself or back again. */
  async function redirectRule(from: string, to: string): Promise<RedirectRule> {
    let target: URL;
    try {
      target = new URL(to, from);
    } catch {
      throw new ConnectorError("invalid_value", `${to} is not a valid redirect target`);
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new ConnectorError("invalid_value", "A redirect target must be an http or https address");
    }
    if ((await redirectKey(target.href)) === (await redirectKey(from))) {
      throw new ConnectorError("redirect_loop", `${from} cannot redirect to itself`);
    }
    const onward = await kvGetJson<RedirectRule>(await redirectKey(target.href));
    if (onward && (await redirectKey(new URL(onward.to, target).href)) === (await redirectKey(from))) {
      throw new ConnectorError("redirect_loop", `${target.href} already redirects back to ${from}`);
    }
    const s = await site();
    const sameSite = s.hosts.includes(target.hostname.toLowerCase()) || target.hostname.toLowerCase() === siteHost;
    return { to: target.href, status: 301, ...(sameSite ? {} : { external: true as const }) };
  }

  return { kind: "CLOUDFLARE", check, capabilities, read, readStored, write, install, uninstall, status };
}

// ---- rule documents -------------------------------------------------------------

function isRuleKey(name: string): boolean {
  return /^[prf][:#]/.test(name);
}

/** robots_txt lives only at /robots.txt, sitemap_xml only at a root sitemap path. */
function assertFilePath(url: string, field: string): void {
  const path = new URL(url).pathname;
  const ok = field === "robots_txt" ? path === "/robots.txt" : field === "sitemap_xml" && path !== "/robots.txt" && isFilePath(path);
  if (!ok) throw new ConnectorError("invalid_value", `${url} is not where a ${field === "robots_txt" ? "robots.txt" : "sitemap"} file can be served.`);
}

/** The stored file, refused when it cannot be what its kind claims. */
function fileBody(kind: FileRule["kind"], value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (kind === "robots") {
    if (bytes > MAX_ROBOTS_BYTES) throw new ConnectorError("invalid_value", "robots.txt is larger than the 500 KiB search engines read.");
    if (/<\s*(html|body|head)\b/i.test(value)) throw new ConnectorError("invalid_value", "That is an HTML page, not a robots.txt file.");
    return value;
  }
  if (bytes > MAX_SITEMAP_BYTES) throw new ConnectorError("invalid_value", "The sitemap file is larger than 10 MB; split it.");
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<(urlset|sitemapindex)\b/i.test(value)) {
    throw new ConnectorError("invalid_value", "A sitemap must be an XML <urlset> or <sitemapindex> document.");
  }
  return value;
}

/**
 * The origin's own file behind the edge (the bypass header makes the worker
 * step aside). 404/410 means the site has none; anything else unreadable throws,
 * because "unknown" must never be mistaken for "empty".
 */
async function readOriginFile(url: string, bypass: string): Promise<string | null> {
  const busted = new URL(url);
  busted.searchParams.set(CACHE_BUSTER, randomBytes(6).toString("hex"));
  let res;
  try {
    res = await guardedFetch(busted.toString(), {
      headers: { "user-agent": env().CRAWLER_USER_AGENT, "cache-control": "no-cache", pragma: "no-cache", [BYPASS_HEADER]: bypass },
      timeoutMs: 20_000,
      maxBytes: MAX_SITEMAP_BYTES,
    });
  } catch (err) {
    if (err instanceof BlockedAddressError) throw new ConnectorError("blocked_address", err.message);
    throw new ConnectorError("page_unreachable", `Could not load ${url}: ${(err as Error).message}`);
  }
  if (res.headers.get(EDGE_HEADER) === "file") {
    throw new ConnectorError("bypass_failed", "The edge worker did not step aside for the panel's read; try again in a minute.");
  }
  if (res.status === 404 || res.status === 410) return null;
  if (res.status !== 200) throw new ConnectorError("page_unavailable", `${url} answered HTTP ${res.status}; its content cannot be read.`);
  if (res.truncated) throw new ConnectorError("response_too_large", `${url} is too large to read.`);
  return res.body.toString("utf8");
}

function ruleValue(rule: PageRule, field: string, url: string, selector?: string): string | null {
  switch (field) {
    case "img.alt": {
      if (!selector) throw new ConnectorError("missing_selector", "An alt-text change must name the image.");
      return rule.alts?.[imageKey(selector, url)] ?? null;
    }
    case "jsonld":
      return rule.jsonld?.length ? JSON.stringify(rule.jsonld.map((b) => JSON.parse(b) as unknown)) : null;
    case "hreflang":
      return rule.hreflang?.length ? JSON.stringify(rule.hreflang) : null;
    default: {
      const prop = RULE_PROP[field as keyof typeof RULE_PROP];
      const value = prop ? rule[prop] : undefined;
      return typeof value === "string" ? value : null;
    }
  }
}

/** The rule with one field set (or, with null, removed); invalid values are refused, never stored. */
function withValue(rule: PageRule, field: string, value: string | null, url: string, selector?: string): PageRule {
  const next: PageRule = { ...rule, ...(rule.alts ? { alts: { ...rule.alts } } : {}) };
  if (field === "img.alt") {
    if (!selector) throw new ConnectorError("missing_selector", "An alt-text change must name the image.");
    const alts = next.alts ?? {};
    if (value === null) delete alts[imageKey(selector, url)];
    else alts[imageKey(selector, url)] = text(value, 1000);
    if (Object.keys(alts).length) next.alts = alts;
    else delete next.alts;
    return next;
  }
  const prop = RULE_PROP[field as keyof typeof RULE_PROP];
  if (value === null) {
    delete next[prop];
    return next;
  }
  switch (field) {
    case "title":
      next.title = text(value, 600);
      break;
    case "meta_description":
      next.description = text(value, 1000);
      break;
    case "canonical":
      next.canonical = absoluteHttp(value, url);
      break;
    case "meta_robots":
      if (!/^[a-z0-9\-_:, ]{1,200}$/i.test(value.trim())) {
        throw new ConnectorError("invalid_value", `"${value}" is not a robots directive list`);
      }
      next.robots = value.trim();
      break;
    case "jsonld":
      next.jsonld = jsonLdBlocks(value);
      break;
    case "hreflang":
      next.hreflang = hreflangSet(value, url);
      break;
  }
  return next;
}

function text(value: string, max: number): string {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) throw new ConnectorError("invalid_value", "An empty value cannot be written; remove the field instead.");
  if ([...v].length > max) throw new ConnectorError("invalid_value", `The value is longer than ${max} characters.`);
  return v;
}

function absoluteHttp(value: string, base: string): string {
  let u: URL;
  try {
    u = new URL(value, base);
  } catch {
    throw new ConnectorError("invalid_value", `${value} is not a valid address`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConnectorError("invalid_value", "Only http and https addresses are allowed");
  return u.href;
}

function jsonLdBlocks(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConnectorError("invalid_value", "JSON-LD must be valid JSON");
  }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  if (blocks.some((b) => !b || typeof b !== "object")) throw new ConnectorError("invalid_value", "Each JSON-LD block must be an object");
  return blocks.map((b) => JSON.stringify(b));
}

function hreflangSet(value: string, base: string): Array<{ lang: string; href: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConnectorError("invalid_value", "hreflang must be a JSON array of {lang, href}");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ConnectorError("invalid_value", "hreflang must be a non-empty array");
  return parsed.map((h: unknown) => {
    const item = h as { lang?: unknown; href?: unknown };
    if (typeof item.lang !== "string" || !/^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*|x-default)$/i.test(item.lang) || typeof item.href !== "string") {
      throw new ConnectorError("invalid_value", "Each hreflang entry needs a language code and an address");
    }
    return { lang: item.lang, href: absoluteHttp(item.href, base) };
  });
}

// ---- multipart ------------------------------------------------------------------

/**
 * multipart/form-data built by hand: the SSRF-guarded fetch runs on undici's
 * own fetch, which does not recognise Node's global FormData.
 */
function multipart(parts: Array<{ name: string; body: string; type?: string; filename?: string }>): {
  body: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>;
} {
  const boundary = `----seotable${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ""}\r\n`,
      ),
      Buffer.from(part.body, "utf8"),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: new Uint8Array(Buffer.concat(chunks)), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
