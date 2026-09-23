/**
 * A Cloudflare API v4 double, over real HTTP.
 *
 * It implements the endpoints the edge connector calls, with Cloudflare's
 * envelope ({success, errors, result, result_info}), status codes and error
 * codes, and it enforces the API token and its permissions — so token
 * verification, zone discovery, the proxied check, install, uninstall and
 * rule reads and writes all run against a server, not a stubbed function.
 *
 * KV values live in a pluggable store: the in-memory default, or a Miniflare
 * KV namespace so the real worker serves what the connector wrote.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export type CfPermission = "zone" | "dns" | "routes" | "scripts" | "kv";
export const ALL_PERMISSIONS: CfPermission[] = ["zone", "dns", "routes", "scripts", "kv"];

export type KvStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
};

export type FakeZone = { id: string; name: string; status: string; accountId: string };
export type FakeRecord = { id: string; zoneId: string; type: string; name: string; proxied: boolean };
export type FakeRoute = { id: string; zoneId: string; pattern: string; script: string | null };
export type FakeScript = { metadata: Record<string, unknown>; modules: Record<string, { type: string; body: string }> };

export type FakeCf = {
  apiBase: string;
  token: string;
  /** Tokens the server accepts, with what each may do. */
  tokens: Map<string, { status: "active" | "disabled" | "expired"; permissions: Set<CfPermission>; accountOwned?: boolean }>;
  zones: FakeZone[];
  records: FakeRecord[];
  routes: FakeRoute[];
  scripts: Map<string, FakeScript>;
  subdomainCalls: Array<{ script: string; enabled: unknown }>;
  namespaces: Map<string, { title: string; accountId: string }>;
  calls: Array<{ method: string; path: string }>;
  kv: KvStore;
  close: () => Promise<void>;
};

export const FAKE_CF_TOKEN = "cf-token-0123456789abcdef";

export function memoryKv(): KvStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
    list: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(8, "0")}${"0".repeat(24)}`.slice(0, 32);

export async function startFakeCloudflare(opts: { kv?: KvStore; zoneName?: string } = {}): Promise<FakeCf> {
  const accountId = "acc0000000000000000000000000000a";
  const zoneName = opts.zoneName ?? "example.test";
  const zone: FakeZone = { id: "7a0e1c2b3d4e5f60718293a4b5c6d7e8", name: zoneName, status: "active", accountId };
  const state: Omit<FakeCf, "apiBase" | "close"> = {
    token: FAKE_CF_TOKEN,
    tokens: new Map([[FAKE_CF_TOKEN, { status: "active", permissions: new Set(ALL_PERMISSIONS) }]]),
    zones: [zone],
    records: [
      { id: "r1", zoneId: zone.id, type: "A", name: `shop.${zoneName}`, proxied: true },
      { id: "r2", zoneId: zone.id, type: "CNAME", name: `www.shop.${zoneName}`, proxied: true },
      { id: "r3", zoneId: zone.id, type: "A", name: `grey.${zoneName}`, proxied: false },
      { id: "r4", zoneId: zone.id, type: "MX", name: `mail.${zoneName}`, proxied: false },
    ],
    routes: [],
    scripts: new Map(),
    subdomainCalls: [],
    namespaces: new Map(),
    calls: [],
    kv: opts.kv ?? memoryKv(),
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/^\/client\/v4/, "");
    state.calls.push({ method, path });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const okResult = (result: unknown, info?: Record<string, unknown>) =>
      send(200, { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
    const fail = (status: number, code: number, message: string) => send(status, { success: false, errors: [{ code, message }], messages: [], result: null });

    // ---- authentication, as Cloudflare does it
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return fail(400, 6003, "Invalid request headers");
    const token = state.tokens.get(header.slice(7));
    if (!token) return fail(403, 9109, "Invalid access token");
    if (path === "/user/tokens/verify") {
      if (token.accountOwned) return fail(401, 1000, "Invalid API Token");
      return okResult({ id: "tok1", status: token.status });
    }
    if (token.status !== "active") return fail(403, 9109, "Invalid access token");
    const need = (p: CfPermission) => {
      if (token.permissions.has(p)) return true;
      fail(403, 10000, "Authentication error");
      return false;
    };

    // ---- zones and DNS
    if (path === "/zones" && method === "GET") {
      if (!need("zone")) return;
      const name = url.searchParams.get("name");
      return okResult(
        state.zones.filter((z) => !name || z.name === name).map((z) => ({ id: z.id, name: z.name, status: z.status, account: { id: z.accountId, name: "Acme" } })),
        { page: 1, per_page: 20, total_pages: 1 },
      );
    }
    let m = path.match(/^\/zones\/([^/]+)\/dns_records$/);
    if (m && method === "GET") {
      if (!need("dns")) return;
      const name = url.searchParams.get("name");
      return okResult(
        state.records.filter((r) => r.zoneId === m![1] && (!name || r.name === name)).map((r) => ({ id: r.id, type: r.type, name: r.name, proxied: r.proxied })),
        { page: 1, total_pages: 1 },
      );
    }

    // ---- worker routes (zone level)
    m = path.match(/^\/zones\/([^/]+)\/workers\/routes(?:\/([^/]+))?$/);
    if (m) {
      if (!need("routes")) return;
      const zoneId = m[1]!;
      if (method === "GET" && !m[2]) {
        return okResult(state.routes.filter((r) => r.zoneId === zoneId).map(({ id, pattern, script }) => ({ id, pattern, script })));
      }
      if (method === "POST" && !m[2]) {
        const body = JSON.parse(await text(req)) as { pattern: string; script?: string };
        if (state.routes.some((r) => r.zoneId === zoneId && r.pattern === body.pattern)) {
          return fail(409, 10020, "A route with the same pattern already exists");
        }
        if (body.script && !state.scripts.has(body.script)) return fail(400, 10007, "workers.api.error.script_not_found");
        const route = { id: nextId("rt"), zoneId, pattern: body.pattern, script: body.script ?? null };
        state.routes.push(route);
        return okResult({ id: route.id, pattern: route.pattern, script: route.script });
      }
      if (method === "DELETE" && m[2]) {
        const i = state.routes.findIndex((r) => r.id === m![2]);
        if (i < 0) return fail(404, 10005, "Route not found");
        state.routes.splice(i, 1);
        return okResult({ id: m[2] });
      }
    }

    // ---- scripts (account level)
    m = path.match(/^\/accounts\/([^/]+)\/workers\/scripts(?:\/([^/]+)(\/subdomain)?)?$/);
    if (m) {
      if (!need("scripts")) return;
      if (method === "GET" && !m[2]) return okResult([...state.scripts.keys()].map((id) => ({ id })));
      const name = m[2]!;
      if (m[3] && method === "POST") {
        state.subdomainCalls.push({ script: name, enabled: (JSON.parse(await text(req)) as { enabled?: unknown }).enabled });
        return okResult({ enabled: false });
      }
      if (method === "PUT") {
        const parts = parseMultipart(req.headers["content-type"] ?? "", await raw(req));
        const metaPart = parts.find((p) => p.name === "metadata");
        if (!metaPart) return fail(400, 10021, "metadata part required");
        const metadata = JSON.parse(metaPart.body) as { main_module?: string; bindings?: Array<{ type: string; namespace_id?: string }> };
        const modules = Object.fromEntries(parts.filter((p) => p.name !== "metadata").map((p) => [p.name, { type: p.type, body: p.body }]));
        if (!metadata.main_module || !modules[metadata.main_module]) return fail(400, 10021, "main_module part missing");
        for (const b of metadata.bindings ?? []) {
          if (b.type === "kv_namespace" && !state.namespaces.has(b.namespace_id ?? "")) return fail(400, 10041, "KV namespace not found");
        }
        state.scripts.set(name, { metadata, modules });
        return okResult({ id: name });
      }
      if (method === "DELETE") {
        if (!state.scripts.has(name)) return fail(404, 10007, "workers.api.error.script_not_found");
        if (url.searchParams.get("force") !== "true" && state.routes.some((r) => r.script === name)) {
          return fail(400, 10064, "Script is still referenced by routes");
        }
        state.scripts.delete(name);
        for (let i = state.routes.length - 1; i >= 0; i--) if (state.routes[i]!.script === name) state.routes.splice(i, 1);
        return okResult(null);
      }
    }

    // ---- KV
    m = path.match(/^\/accounts\/([^/]+)\/storage\/kv\/namespaces(?:\/([^/]+)(?:\/(values|keys)(?:\/(.+))?)?)?$/);
    if (m) {
      if (!need("kv")) return;
      const [, acct, ns, sub, rawKey] = m;
      if (!ns && method === "GET") {
        const list = [...state.namespaces].filter(([, n]) => n.accountId === acct).map(([id, n]) => ({ id, title: n.title }));
        return okResult(list, { page: 1, per_page: 100, total_pages: 1 });
      }
      if (!ns && method === "POST") {
        const body = JSON.parse(await text(req)) as { title: string };
        if ([...state.namespaces.values()].some((n) => n.title === body.title)) return fail(400, 10014, "a namespace with this account ID and title already exists");
        const id = nextId("ns");
        state.namespaces.set(id, { title: body.title, accountId: acct! });
        return okResult({ id, title: body.title });
      }
      if (!ns || !state.namespaces.has(ns)) return fail(404, 10013, "namespace not found");
      if (sub === "keys" && method === "GET") {
        const names = await state.kv.list(url.searchParams.get("prefix") ?? "");
        return okResult(names.map((name) => ({ name })), { count: names.length, cursor: "" });
      }
      if (sub === "values" && rawKey) {
        const key = decodeURIComponent(rawKey);
        if (method === "GET") {
          const value = await state.kv.get(key);
          if (value === null) return fail(404, 10009, "get: 'key not found'");
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return res.end(value);
        }
        if (method === "PUT") {
          const parts = parseMultipart(req.headers["content-type"] ?? "", await raw(req));
          const value = parts.find((p) => p.name === "value");
          if (!value) return fail(400, 10001, "value part required");
          await state.kv.put(key, value.body);
          return okResult(null);
        }
        if (method === "DELETE") {
          await state.kv.delete(key);
          return okResult(null);
        }
      }
    }

    fail(404, 7003, `Could not route to ${path}, perhaps your object identifier is invalid?`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    ...state,
    apiBase: `http://127.0.0.1:${port}/client/v4`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function raw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function text(req: IncomingMessage): Promise<string> {
  return (await raw(req)).toString("utf8");
}

function parseMultipart(contentType: string, body: Buffer): Array<{ name: string; type: string; body: string }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return [];
  const delimiter = `--${boundary[1] ?? boundary[2]}`;
  return body
    .toString("utf8")
    .split(delimiter)
    .slice(1, -1)
    .map((chunk) => {
      const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
      const content = rest.join("\r\n\r\n").replace(/\r\n$/, "");
      return {
        name: /name="([^"]+)"/.exec(head ?? "")?.[1] ?? "",
        type: /content-type:\s*([^\r\n]+)/i.exec(head ?? "")?.[1] ?? "text/plain",
        body: content,
      };
    });
}
