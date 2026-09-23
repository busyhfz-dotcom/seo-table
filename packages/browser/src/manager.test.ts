/**
 * The browser manager against real Chromium and a local fixture site.
 *
 * vitest sets ALLOW_PRIVATE_NETWORK=1 so the fixture on 127.0.0.1 can be
 * opened; the SSRF tests switch it off after the page has loaded, which is
 * exactly the situation that matters: a public page that tries to reach inside.
 */
import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeRedis } from "@seo/core";
import { BrowserManager } from "./manager.js";
import { startGuardedProxy } from "./proxy.js";
import { actionSchema, type Owner } from "./types.js";

const hits: string[] = [];
let wsConnections = 0;
let base: string;
let site: http.Server;
let wsServer: net.Server;
let wsPort: number;

function page(body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;
}

beforeAll(async () => {
  wsServer = net.createServer((socket) => {
    wsConnections++;
    socket.destroy();
  });
  await new Promise<void>((r) => wsServer.listen(0, "127.0.0.1", r));
  wsPort = (wsServer.address() as net.AddressInfo).port;

  site = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const html = (s: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(s);
    switch (req.url) {
      case "/":
        return html(
          page(
            `<h1 id="h">Raw heading</h1>
             <input id="field" style="position:absolute;left:20px;top:120px;width:300px;height:40px">
             <button id="grow" style="position:absolute;left:20px;top:200px;width:200px;height:60px"
               onclick="document.body.style.background='rgb(200,30,30)'">grow</button>
             <a id="pop" href="/page2" target="_blank" style="position:absolute;left:20px;top:300px;font-size:30px">popup</a>
             <a href="/static">static link</a>
             <img src="/pixel.png">
             <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>
             <script>
               document.title = "Rendered title";
               var a = document.createElement("a"); a.href = "/only-in-js"; a.textContent = "js link"; document.body.appendChild(a);
               console.error("fixture console error");
             </script>`,
            `<title>Raw title</title><meta name="description" content="Raw description"><link rel="canonical" href="/">`,
          ),
        );
      case "/page2":
        return html(page(`<h1>Second page</h1>`, "<title>Page two</title>"));
      case "/static":
        return html(page(`<p>static</p>`, "<title>Static</title>"));
      case "/ssrf":
        return html(
          page(
            `<button id="go" style="position:absolute;left:0;top:0;width:300px;height:100px" onclick="
               var i = new Image(); i.src = 'http://169.254.169.254/latest/meta-data/';
               document.body.appendChild(i);
               fetch('${base}/secret').catch(function(){});
               try { new WebSocket('ws://127.0.0.1:${wsPort}/'); } catch (e) {}
             ">go</button>`,
            "<title>SSRF probe</title>",
          ),
        );
      case "/secret":
        return html("secret");
      case "/pixel.png":
        return res.writeHead(404).end();
      default:
        return res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  process.env.ALLOW_PRIVATE_NETWORK = "1";
  await new Promise((r) => site.close(r));
  await new Promise((r) => wsServer.close(r));
  await closeRedis();
});

const alice: Owner = { orgId: "org-a", userId: "user-alice" };
const bob: Owner = { orgId: "org-a", userId: "user-bob" };
const carol: Owner = { orgId: "org-c", userId: "user-carol" };

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Width and height from a JPEG's SOF0/SOF2 marker. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("no SOF marker");
}

describe("remote sessions", () => {
  const manager = new BrowserManager();
  afterAll(() => manager.close());

  it("opens a desktop session and serves JPEG frames with a stable ETag", async () => {
    const info = await manager.createSession(alice, { url: `${base}/`, device: "desktop" });
    expect(info).toMatchObject({ width: 1366, height: 850, device: "desktop" });
    expect(info.url).toBe(`${base}/`);

    const first = await until(
      () => manager.frame(alice, info.id),
      (f) => f.state.title === "Rendered title",
    );
    expect(first.notModified).toBe(false);
    if (first.notModified) return;
    expect(first.body.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(jpegSize(first.body)).toEqual({ width: 1366, height: 850 });
    expect(first.state).toMatchObject({ url: `${base}/`, loading: false });

    // Once the page stops painting, asking again with the ETag costs a 304.
    let etag = first.etag;
    const same = await until(
      async () => {
        const f = await manager.frame(alice, info.id, etag);
        etag = f.etag;
        return f;
      },
      (f) => f.notModified,
    );
    expect(same.notModified).toBe(true);

    // A click that repaints the page moves the version.
    await manager.action(alice, info.id, actionSchema.parse({ type: "click", x: 100, y: 230 }));
    const changed = await until(
      () => manager.frame(alice, info.id, etag),
      (f) => !f.notModified,
    );
    expect(changed.notModified).toBe(false);
    expect(changed.etag).not.toBe(etag);
    await manager.closeSession(alice, info.id);
  });

  it("types, copies to its own clipboard, follows popups back into the tab, and goes back", async () => {
    const { id } = await manager.createSession(alice, { url: `${base}/`, device: "desktop" });
    await until(() => manager.frame(alice, id), (f) => f.state.title === "Rendered title");

    await manager.action(alice, id, actionSchema.parse({ type: "click", x: 60, y: 140 }));
    await manager.action(alice, id, actionSchema.parse({ type: "type", text: "hello" }));
    await manager.action(alice, id, actionSchema.parse({ type: "key", key: "Control+A" }));
    const copy = await manager.action(alice, id, actionSchema.parse({ type: "key", key: "Control+C" }));
    expect(copy.copied).toBe("hello");

    await manager.action(alice, id, actionSchema.parse({ type: "click", x: 40, y: 318 }));
    const moved = await until(
      () => manager.frame(alice, id),
      (f) => f.state.url.endsWith("/page2") && f.state.title === "Page two",
    );
    expect(moved.state.url).toBe(`${base}/page2`);
    expect(moved.state.canGoBack).toBe(true);

    await manager.action(alice, id, actionSchema.parse({ type: "back" }));
    const back = await until(() => manager.frame(alice, id), (f) => f.state.url === `${base}/`);
    expect(back.state.url).toBe(`${base}/`);
    expect(back.state.canGoForward).toBe(true);
    await manager.closeSession(alice, id);
  });

  it("only lets the safe keys through", () => {
    expect(actionSchema.safeParse({ type: "key", key: "Enter" }).success).toBe(true);
    for (const key of ["Control+W", "Control+T", "Alt+F4", "F12", "Control+Shift+I", "Meta+Q"]) {
      expect(actionSchema.safeParse({ type: "key", key }).success, key).toBe(false);
    }
  });

  it("emulates a phone at 390x844 CSS pixels", async () => {
    const info = await manager.createSession(alice, { url: `${base}/static`, device: "mobile" });
    expect(info).toMatchObject({ width: 390, height: 844, device: "mobile" });
    const frame = await until(() => manager.frame(alice, info.id), (f) => f.state.title === "Static");
    expect(!frame.notModified && jpegSize(frame.body)).toEqual({ width: 390, height: 844 });
    const reloaded = await manager.action(alice, info.id, actionSchema.parse({ type: "reload" }));
    expect(reloaded.url).toBe(`${base}/static`);
    await manager.closeSession(alice, info.id);
  });

  it("binds sessions to their owner: anyone else gets not-found", async () => {
    const { id } = await manager.createSession(alice, { url: `${base}/static`, device: "desktop" });
    await expect(manager.frame(bob, id)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await expect(manager.frame({ orgId: "other", userId: alice.userId }, id)).rejects.toMatchObject({ status: 404 });
    await expect(
      manager.action(bob, id, actionSchema.parse({ type: "navigate", url: `${base}/page2` })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(manager.closeSession(carol, id)).rejects.toMatchObject({ status: 404 });
    await manager.closeSession(alice, id);
    await expect(manager.frame(alice, id)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses non-web schemes", async () => {
    for (const url of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)"]) {
      await expect(manager.createSession(alice, { url, device: "desktop" }), url).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});

describe("SSRF", () => {
  const manager = new BrowserManager();
  afterAll(async () => {
    process.env.ALLOW_PRIVATE_NETWORK = "1";
    await manager.close();
  });

  it("refuses to open or navigate to private addresses", async () => {
    delete process.env.ALLOW_PRIVATE_NETWORK;
    try {
      await expect(
        manager.createSession(alice, { url: "http://169.254.169.254/latest/meta-data/", device: "desktop" }),
      ).rejects.toMatchObject({ status: 400, code: "BLOCKED_ADDRESS" });
      await expect(manager.createSession(alice, { url: base, device: "desktop" })).rejects.toMatchObject({
        code: "BLOCKED_ADDRESS",
      });
      await expect(manager.render({ url: "http://10.0.0.1/", device: "desktop" })).rejects.toMatchObject({
        code: "BLOCKED_ADDRESS",
      });
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "1";
    }
  });

  it("blocks a loaded page's requests and WebSockets to private hosts", async () => {
    const { id } = await manager.createSession(alice, { url: `${base}/ssrf`, device: "desktop" });
    await until(() => manager.frame(alice, id), (f) => f.state.title === "SSRF probe");

    // Control: with private addresses allowed the probe does reach both servers.
    hits.length = 0;
    wsConnections = 0;
    await manager.action(alice, id, actionSchema.parse({ type: "click", x: 100, y: 50 }));
    await until(async () => hits.includes("/secret") && wsConnections > 0, Boolean, 5_000);
    expect(hits).toContain("/secret");
    expect(wsConnections).toBeGreaterThan(0);

    hits.length = 0;
    wsConnections = 0;

    delete process.env.ALLOW_PRIVATE_NETWORK;
    try {
      await expect(
        manager.action(alice, id, actionSchema.parse({ type: "navigate", url: "http://169.254.169.254/" })),
      ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
      await manager.action(alice, id, actionSchema.parse({ type: "click", x: 100, y: 50 }));
      await new Promise((r) => setTimeout(r, 1_500));
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "1";
    }
    expect(hits).not.toContain("/secret");
    expect(wsConnections).toBe(0);
    await manager.closeSession(alice, id);
  });

  it("shows the blocked page when a link leads inside", async () => {
    const { id } = await manager.createSession(alice, { url: `${base}/static`, device: "desktop" });
    await until(() => manager.frame(alice, id), (f) => f.state.title === "Static");
    delete process.env.ALLOW_PRIVATE_NETWORK;
    try {
      // Same page, but the host's verdict is cached per mode: now it is refused.
      await manager.action(alice, id, actionSchema.parse({ type: "reload" }));
      const blocked = await until(
        () => manager.frame(alice, id),
        (f) => f.state.title === "این نشانی مسدود است",
      );
      expect(blocked.state.title).toBe("این نشانی مسدود است");
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "1";
    }
    await manager.closeSession(alice, id);
  });

  it("the proxy itself refuses private destinations, whatever the page layer did", async () => {
    const proxy = await startGuardedProxy();
    delete process.env.ALLOW_PRIVATE_NETWORK;
    try {
      const connectStatus = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write(`CONNECT ${new URL(base).host} HTTP/1.1\r\nHost: ${new URL(base).host}\r\n\r\n`);
        });
        socket.once("data", (d) => {
          resolve(d.toString().split("\r\n")[0]!);
          socket.destroy();
        });
        socket.on("error", reject);
      });
      expect(connectStatus).toContain("403");

      for (const target of ["http://169.254.169.254/latest/meta-data/", "http://localhost/", `${base}/secret`]) {
        const status = await new Promise<number>((resolve, reject) => {
          const u = new URL(target);
          const req = http.request({ host: "127.0.0.1", port: proxy.port, path: target, headers: { host: u.host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
        expect(status, target).toBe(403);
      }
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "1";
      await proxy.close();
    }
    expect(hits).not.toContain("/secret");
  });
});

describe("limits", () => {
  it("replaces a person's own session, caps an organization and the server", async () => {
    const manager = new BrowserManager({ maxSessions: 2, maxSessionsPerOrg: 1 });
    try {
      const a1 = await manager.createSession(alice, { url: `${base}/static`, device: "desktop" });
      const a2 = await manager.createSession(alice, { url: `${base}/static`, device: "desktop" });
      await expect(manager.frame(alice, a1.id)).rejects.toMatchObject({ status: 404 });
      await expect(manager.createSession(bob, { url: `${base}/static`, device: "desktop" })).rejects.toMatchObject({
        status: 429,
        code: "BROWSER_BUSY",
        details: { reason: "org_limit" },
      });
      await manager.createSession(carol, { url: `${base}/static`, device: "desktop" });
      await expect(
        manager.createSession({ orgId: "org-d", userId: "dave" }, { url: `${base}/static`, device: "desktop" }),
      ).rejects.toMatchObject({ status: 429, details: { reason: "capacity" } });
      expect(manager.stats().sessions).toBe(2);
      await manager.closeSession(alice, a2.id);
    } finally {
      await manager.close();
    }
  });

  it("closes idle sessions, then Chromium itself", async () => {
    const manager = new BrowserManager({ idleMs: 50, browserIdleMs: 50, sweepEveryMs: 60_000 });
    try {
      const { id } = await manager.createSession(alice, { url: `${base}/static`, device: "desktop" });
      await new Promise((r) => setTimeout(r, 120));
      await manager.sweep();
      await expect(manager.frame(alice, id)).rejects.toMatchObject({ status: 404 });
      await new Promise((r) => setTimeout(r, 120));
      await manager.sweep();
      expect(manager.stats().running).toBe(false);
    } finally {
      await manager.close();
    }
  });

  it("answers BROWSER_UNAVAILABLE when turned off", async () => {
    const manager = new BrowserManager({ maxSessions: 0 });
    await expect(manager.createSession(alice, { url: `${base}/`, device: "desktop" })).rejects.toMatchObject({
      status: 503,
      code: "BROWSER_UNAVAILABLE",
    });
    await expect(manager.render({ url: `${base}/`, device: "desktop" })).rejects.toMatchObject({ status: 503 });
    await manager.close();
  });
});

describe("render", () => {
  const manager = new BrowserManager();
  afterAll(() => manager.close());

  it("reads SEO from the rendered DOM and flags what JavaScript changed", async () => {
    const r = await manager.render({ url: `${base}/`, device: "desktop" });
    expect(r.status).toBe(200);
    expect(r.seo).toMatchObject({
      title: "Rendered title",
      description: "Raw description",
      canonical: `${base}/`,
      h1: ["Raw heading"],
      robots: null,
    });
    expect(r.seo.jsonld.sort()).toEqual(["Organization", "Thing", "WebSite"]);
    expect(r.seo.links.internal).toBeGreaterThanOrEqual(3);
    expect(r.renderedVsRaw).toMatchObject({
      available: true,
      titleDiffers: true,
      descriptionDiffers: false,
      linksOnlyInRendered: 1,
    });
    expect(r.console.some((c) => c.text.includes("fixture console error"))).toBe(true);
    expect(r.metrics.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(typeof r.metrics.cls).toBe("number");
    expect(Buffer.from(r.screenshot, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(r.changesApplied).toBe(0);
  });

  it("applies proposed changes before the screenshot, a preview of the fix", async () => {
    const plain = await manager.render({ url: `${base}/`, device: "mobile" });
    const preview = await manager.render({
      url: `${base}/`,
      device: "mobile",
      changes: [
        { field: "h1", value: "A much better heading" },
        { field: "title", value: "New title" },
        { field: "img_alt", value: "a pixel", selector: "/pixel.png" },
        { field: "jsonld", value: '{"@type":"FAQPage"}' },
      ],
    });
    expect(preview.changesApplied).toBe(4);
    expect(preview.width).toBe(390);
    expect(preview.screenshot).not.toBe(plain.screenshot);
  });

  it("works when run through tsx, as the worker is", async () => {
    // tsx wraps named inner functions in a __name helper the page does not
    // have; in-page code must survive that transform (vitest's does not add it).
    const code = `
      import { BrowserManager } from ${JSON.stringify(new URL("./manager.ts", import.meta.url).pathname)};
      import { closeRedis } from "@seo/core";
      const m = new BrowserManager();
      const r = await m.render({ url: ${JSON.stringify(`${base}/`)}, device: "desktop", changes: [{ field: "h1", value: "x" }] });
      console.log(JSON.stringify({ metrics: r.metrics, applied: r.changesApplied }));
      await m.close();
      await closeRedis();
    `;
    // Asynchronously: the fixture site answering the child lives in this process.
    const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        { cwd: new URL("..", import.meta.url).pathname, timeout: 60_000, env: { ...process.env, LOG_LEVEL: "silent" } },
        (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }),
      );
    });
    expect(run.code, run.stderr).toBe(0);
    const line = run.stdout.trim().split("\n").at(-1) ?? "";
    const out = JSON.parse(line) as { metrics: { ttfbMs?: number; cls?: number }; applied: number };
    expect(out.metrics.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(typeof out.metrics.cls).toBe("number");
    expect(out.applied).toBe(1);
  });

  it("refuses a second render beyond the limit", async () => {
    const small = new BrowserManager({ maxRenders: 1 });
    try {
      const first = small.render({ url: `${base}/`, device: "desktop" });
      await expect(small.render({ url: `${base}/`, device: "desktop" })).rejects.toMatchObject({
        code: "BROWSER_BUSY",
      });
      await first;
    } finally {
      await small.close();
    }
  });
});
