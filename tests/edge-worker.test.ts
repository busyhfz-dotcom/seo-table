/**
 * The edge worker, run in workerd through Miniflare against a scripted origin.
 *
 * What must hold:
 *   - rules rewrite title, description, canonical, robots (meta and header),
 *     image alt (exact and at any WordPress size), JSON-LD and hreflang, and
 *     add what the page lacks;
 *   - redirects are same-site unless marked external, never to the page itself;
 *   - anything that is not a plain anonymous GET/HEAD of a public page passes
 *     through untouched;
 *   - any failure serves the origin response as it came (fail open);
 *   - the bypass secret returns the origin untouched and never reaches the origin;
 *   - the worker and @seo/core agree on what identifies a URL.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { miniflareKv, type TestKv } from "./miniflare-kv.js";
import { normalizeUrl } from "@seo/core";
import {
  BYPASS_KEY,
  MANIFEST_KEY,
  imageKey,
  pageKey,
  pathKey,
  redirectKey,
} from "../packages/connectors/src/edge/keys.js";
import { WORKER_MODULES } from "../packages/connectors/src/edge/worker-source.js";

const EDGE_DIR = new URL("../packages/connectors/src/edge/", import.meta.url);
const SITE = "https://shop.example";

type Seen = { url: string; method: string; headers: Record<string, string> };
const seen: Seen[] = [];

const PAGE = `<!doctype html><html><head>
<title>Old title</title>
<meta name="Description" content="old description">
<link rel="canonical" href="https://shop.example/old">
<meta name="robots" content="noindex, nofollow">
<meta name="googlebot" content="noindex">
<link rel="alternate" hreflang="en" href="https://shop.example/en/old">
</head><body>
<svg><title>icon title stays</title></svg>
<img src="/wp-content/uploads/shoe-300x200.webp">
<img src="https://shop.example/wp-content/uploads/hat.jpg" alt="kept">
<img data-src="/wp-content/uploads/lazy.png">
</body></html>`;

const BARE = `<html><head><meta charset="utf-8"></head><body><p>no head tags</p></body></html>`;

/** The scripted origin: what the site would answer without the worker. */
function origin(request: Request): Response {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => (headers[name] = value));
  seen.push({ url: request.url, method: request.method, headers });
  const html = { "content-type": "text/html; charset=utf-8", etag: '"abc"' };
  switch (url.pathname) {
    case "/bare":
      return new Response(BARE, { headers: html });
    case "/data.json":
      return new Response('{"a":1}', { headers: { "content-type": "application/json" } });
    case "/login-set":
      return new Response(PAGE, { headers: { ...html, "set-cookie": "wordpress_logged_in_abc=1; path=/" } });
    case "/cart":
      return new Response(PAGE, { headers: { ...html, "set-cookie": "woocommerce_cart_hash=1; path=/" } });
    case "/missing":
      return new Response(PAGE, { status: 404, headers: html });
    default:
      return new Response(PAGE, { headers: html });
  }
}

let mf: Miniflare;
let kv: TestKv;

async function start(): Promise<void> {
  mf = new Miniflare({
    // Exactly what the connector uploads, main module first.
    modules: (["worker.js", "keys.js"] as const).map((name) => ({
      type: "ESModule" as const,
      path: new URL(name, EDGE_DIR).pathname,
      contents: WORKER_MODULES[name],
    })),
    compatibilityDate: "2025-09-01",
    kvNamespaces: ["RULES"],
    outboundService: origin,
  });
  kv = await miniflareKv(mf);
}

/** Write rules and the manifest the way the connector does. */
async function rules(pages: Record<string, unknown>, redirects: Record<string, unknown> = {}): Promise<void> {
  const keys: string[] = [];
  for (const [url, rule] of Object.entries(pages)) {
    const key = await pageKey(url);
    keys.push(key);
    await kv.put(key, JSON.stringify(rule));
  }
  for (const [url, rule] of Object.entries(redirects)) {
    const key = await redirectKey(url);
    keys.push(key);
    await kv.put(key, JSON.stringify(rule));
  }
  await kv.put(MANIFEST_KEY, JSON.stringify({ v: 1, keys }));
}

/** A fresh isolate: module state (the rule cache) starts empty. */
async function restart(): Promise<void> {
  await mf.dispose();
  await start();
}

const get = (path: string, init?: RequestInit) =>
  mf.dispatchFetch(`${SITE}${path}`, { redirect: "manual", ...(init as object) } as never);

beforeAll(start);
afterAll(() => mf.dispose());
beforeEach(async () => {
  seen.length = 0;
  await restart();
});

describe("embedding", () => {
  it("the uploaded modules are exactly the files on disk (run embed-assets after editing)", () => {
    for (const name of ["worker.js", "keys.js"] as const) {
      expect(WORKER_MODULES[name], name).toBe(readFileSync(new URL(name, EDGE_DIR), "utf8"));
    }
  });
});

describe("page rules", () => {
  it("rewrites what exists and tags the response", async () => {
    await rules({
      [`${SITE}/product/shoe`]: {
        title: "Running shoe — Shop",
        description: 'Light & fast "trail" shoe',
        canonical: `${SITE}/product/shoe`,
        robots: "index, follow",
        alts: { [imageKey("/wp-content/uploads/shoe.webp", SITE)]: "A red running shoe" },
      },
    });
    const res = await get("/product/shoe?utm_source=news");
    const html = await res.text();
    expect(res.headers.get("x-seo-table-edge")).toBe("1");
    expect(res.headers.get("x-robots-tag")).toBe("index, follow");
    expect(res.headers.get("etag")).toBeNull();
    expect(html).toContain("<title>Running shoe — Shop</title>");
    // setAttribute escapes quotes; a bare "& " is valid in an HTML attribute.
    expect(html).toContain('<meta name="Description" content="Light & fast &quot;trail&quot; shoe">');
    expect(html).toContain(`<link rel="canonical" href="${SITE}/product/shoe">`);
    expect(html).toContain('<meta name="robots" content="index, follow">');
    expect(html).not.toContain("googlebot");
    // Size-suffix-insensitive: the rule names the original, the page shows -300x200.
    expect(html).toContain('<img src="/wp-content/uploads/shoe-300x200.webp" alt="A red running shoe">');
    // Untouched: other images, SVG titles.
    expect(html).toContain('alt="kept"');
    expect(html).toContain("<svg><title>icon title stays</title></svg>");
    expect(html).not.toContain("Old title");
  });

  it("adds what the page lacks before </head>", async () => {
    await rules({
      [`${SITE}/bare`]: {
        title: "Bare page",
        description: "Now described",
        canonical: `${SITE}/bare`,
        robots: "index, follow",
        hreflang: [{ lang: "fa", href: `${SITE}/bare` }, { lang: "en", href: `${SITE}/en/bare` }],
        jsonld: [JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "</script><script>alert(1)</script>" }), "{not json"],
      },
    });
    const html = await (await get("/bare")).text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain("<title>Bare page</title>");
    expect(head).toContain('<meta name="description" content="Now described">');
    expect(head).toContain(`<link rel="canonical" href="${SITE}/bare">`);
    expect(head).toContain('<meta name="robots" content="index, follow">');
    expect(head).toContain(`<link rel="alternate" hreflang="en" href="${SITE}/en/bare">`);
    // One valid block injected, with </script> neutralised; the malformed one skipped.
    expect(head.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(head).not.toContain("</script><script>alert");
    expect(head).toContain("\\u003c/script>");
  });

  it("replaces the hreflang set rather than adding to it", async () => {
    await rules({ [`${SITE}/p`]: { hreflang: [{ lang: "fa", href: `${SITE}/p` }] } });
    const html = await (await get("/p")).text();
    expect(html).not.toContain(`${SITE}/en/old`);
    expect(html).toContain(`hreflang="fa" href="${SITE}/p"`);
  });

  it("matches lazy images by data-src", async () => {
    await rules({ [`${SITE}/lazy`]: { alts: { [imageKey("/wp-content/uploads/lazy.png", SITE)]: "Lazy" } } });
    expect(await (await get("/lazy")).text()).toContain('<img data-src="/wp-content/uploads/lazy.png" alt="Lazy">');
  });

  it("a query that is not tracking is a different page", async () => {
    await rules({ [`${SITE}/list`]: { title: "List" } });
    expect(await (await get("/list?page=2")).text()).toContain("Old title");
    expect(await (await get("/list?gclid=x")).text()).toContain("<title>List</title>");
  });

  it("www and apex share rules", async () => {
    await rules({ [`${SITE}/same`]: { title: "Same" } });
    const res = await mf.dispatchFetch("https://www.shop.example/same");
    expect(await res.text()).toContain("<title>Same</title>");
  });

  it("HEAD gets the robots header without a body", async () => {
    await rules({ [`${SITE}/h`]: { robots: "index, follow" } });
    const res = await get("/h", { method: "HEAD" });
    expect(res.headers.get("x-robots-tag")).toBe("index, follow");
  });
});

describe("redirects", () => {
  it("answers with the rule's status and keeps campaign parameters", async () => {
    await rules({}, { [`${SITE}/old`]: { to: `${SITE}/new`, status: 301 } });
    const res = await get("/old?utm_source=mail");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${SITE}/new?utm_source=mail`);
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    expect(seen).toHaveLength(0);
  });

  it("ignores a rule pointing at the page itself", async () => {
    await rules({}, { [`${SITE}/loop`]: { to: `https://www.shop.example/loop`, status: 301 } });
    expect((await get("/loop")).status).toBe(200);
  });

  it("goes off-site only when the rule says so", async () => {
    await rules({}, {
      [`${SITE}/away`]: { to: "https://other.example/x", status: 302 },
      [`${SITE}/partner`]: { to: "https://other.example/y", status: 302, external: true },
    });
    expect((await get("/away")).status).toBe(200);
    const res = await get("/partner");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://other.example/y");
  });

  it("falls back to 301 for an unknown status and refuses non-http targets", async () => {
    await rules({}, {
      [`${SITE}/odd`]: { to: `${SITE}/target`, status: 200 },
      [`${SITE}/js`]: { to: "javascript:alert(1)", status: 301, external: true },
    });
    expect((await get("/odd")).status).toBe(301);
    expect((await get("/js")).status).toBe(200);
  });
});

describe("what is never touched", () => {
  beforeEach(() => rules({ [`${SITE}/wp-admin/edit.php`]: { title: "X" }, [`${SITE}/any`]: { title: "Rewritten" }, [`${SITE}/login-set`]: { title: "X" }, [`${SITE}/cart`]: { title: "Cart" }, [`${SITE}/data.json`]: { title: "X" }, [`${SITE}/missing`]: { title: "X" } }));

  it("non-GET requests", async () => {
    const res = await get("/any", { method: "POST", body: "a=1" });
    expect(res.headers.get("x-seo-table-edge")).toBeNull();
    expect(await res.text()).toContain("Old title");
  });

  it("admin, login, REST and Cloudflare paths", async () => {
    for (const path of ["/wp-admin/edit.php", "/wp-login.php?action=lostpassword", "/wp-json/wp/v2/posts", "/?rest_route=/wp/v2/posts", "/cdn-cgi/trace"]) {
      const res = await get(path);
      expect(res.headers.get("x-seo-table-edge"), path).toBeNull();
    }
  });

  it("logged-in visitors and responses that start a session", async () => {
    const res = await get("/any", { headers: { cookie: "a=1; wordpress_logged_in_123=admin" } });
    expect(await res.text()).toContain("Old title");
    expect(res.headers.get("x-seo-table-edge")).toBeNull();
    expect(await (await get("/login-set")).text()).toContain("Old title");
  });

  it("other cookies do not stop the rewrite, and Set-Cookie is forwarded", async () => {
    const res = await get("/cart", { headers: { cookie: "_ga=1" } });
    expect(await res.text()).toContain("<title>Cart</title>");
    expect(res.headers.get("set-cookie")).toContain("woocommerce_cart_hash=1");
  });

  it("non-HTML and non-200 responses", async () => {
    const json = await get("/data.json");
    expect(await json.text()).toBe('{"a":1}');
    expect(json.headers.get("x-seo-table-edge")).toBe("1");
    expect(await (await get("/missing")).text()).toContain("Old title");
  });
});

describe("failing open", () => {
  it("a corrupt rule serves the origin response", async () => {
    const key = await pageKey(`${SITE}/corrupt`);
    await kv.put(key, "{not json");
    await kv.put(MANIFEST_KEY, JSON.stringify({ v: 1, keys: [key] }));
    const res = await get("/corrupt");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Old title");
  });

  it("a corrupt manifest serves the origin response", async () => {
    await kv.put(MANIFEST_KEY, "{");
    const res = await get("/any");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Old title");
  });

  it("no manifest means no rules and no KV lookups per page", async () => {
    await kv.put(await pageKey(`${SITE}/orphan`), JSON.stringify({ title: "Orphan" }));
    expect(await (await get("/orphan")).text()).toContain("Old title");
  });
});

describe("the bypass secret", () => {
  it("returns the origin untouched and is not forwarded", async () => {
    await rules({ [`${SITE}/any`]: { title: "Rewritten" } });
    await kv.put(BYPASS_KEY, "s3cret-value");
    const res = await get("/any", { headers: { "x-seo-table-bypass": "s3cret-value" } });
    expect(res.headers.get("x-seo-table-edge")).toBe("bypass");
    expect(await res.text()).toContain("Old title");
    expect(seen.at(-1)!.headers["x-seo-table-bypass"]).toBeUndefined();
  });

  it("a wrong secret is ignored and stripped", async () => {
    await rules({ [`${SITE}/any`]: { title: "Rewritten" } });
    await kv.put(BYPASS_KEY, "s3cret-value");
    const res = await get("/any", { headers: { "x-seo-table-bypass": "guess" } });
    expect(await res.text()).toContain("<title>Rewritten</title>");
    expect(seen.at(-1)!.headers["x-seo-table-bypass"]).toBeUndefined();
  });
});

describe("the in-isolate cache", () => {
  it("serves a rule for its lifetime, and a new isolate reads the new one", async () => {
    await rules({ [`${SITE}/c`]: { title: "First" } });
    expect(await (await get("/c")).text()).toContain("<title>First</title>");
    await kv.put(await pageKey(`${SITE}/c`), JSON.stringify({ title: "Second" }));
    expect(await (await get("/c")).text()).toContain("<title>First</title>");
    await restart();
    await kv.put(await pageKey(`${SITE}/c`), JSON.stringify({ title: "Second" }));
    await kv.put(MANIFEST_KEY, JSON.stringify({ v: 1, keys: [await pageKey(`${SITE}/c`)] }));
    expect(await (await get("/c")).text()).toContain("<title>Second</title>");
  });
});

describe("keys", () => {
  it("agree with the crawler's URL identity", () => {
    for (const url of [
      "https://shop.example/a/b/",
      "https://shop.example/a/b",
      "https://shop.example/%7euser/%d9%be",
      "https://shop.example/کفش-دویدن/",
      "https://shop.example/list?b=2&a=1&utm_source=x&fbclid=1",
      "https://shop.example/?flag",
      "https://shop.example/x?_seotable=123",
    ]) {
      const normalized = new URL(normalizeUrl(url)!);
      expect(pathKey(url), url).toBe(normalized.pathname + normalized.search.replace(/[?&]_seotable=[^&]*/, ""));
    }
  });

  it("hash keys that would exceed KV's limit", async () => {
    const long = `${SITE}/${"a".repeat(600)}`;
    const key = await pageKey(long);
    expect(key).toMatch(/^p#[0-9a-f]{64}$/);
    expect(await pageKey(`${SITE}/short`)).toBe("p:shop.example/short");
  });
});
