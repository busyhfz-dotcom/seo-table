/**
 * The worker's internal browser API over real HTTP, with a real BrowserManager
 * (Chromium) behind it and a local page to open.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeRedis, env, resetEnvCache } from "@seo/core";
import { BrowserManager, internalToken } from "@seo/browser";
import { browserApi } from "./browser-api.js";

const SECRET = "x".repeat(48);
const token = internalToken(SECRET);
let draining = false;
const manager = new BrowserManager({ maxSessions: 2 });
let api: http.Server;
let site: http.Server;
let apiBase: string;
let siteBase: string;

beforeAll(async () => {
  site = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>عنوان صفحه</title><h1>Hello</h1>");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteBase = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  const handle = browserApi({ manager: () => manager, sessionSecret: SECRET, draining: () => draining });
  api = http.createServer(async (req, res) => {
    if (await handle(req, res)) return;
    res.writeHead(404).end("not browser");
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await manager.close();
  await new Promise((r) => api.close(r));
  await new Promise((r) => site.close(r));
  await closeRedis();
});

const alice = { "x-org-id": "11111111-1111-4111-8111-111111111111", "x-user-id": "22222222-2222-4222-8222-222222222222" };
const mallory = { "x-org-id": alice["x-org-id"], "x-user-id": "33333333-3333-4333-8333-333333333333" };

function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return fetch(`${apiBase}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "x-internal-token": token,
      ...alice,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe("authentication", () => {
  it("refuses a missing or wrong token without touching the browser", async () => {
    for (const headers of [{ "x-internal-token": "" }, { "x-internal-token": "0".repeat(64) }, { "x-internal-token": `${token}x` }]) {
      const res = await call("/internal/browser/status", { headers });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
    }
    expect(manager.stats().running).toBe(false);
  });

  it("the token is bound to the secret", () => {
    expect(internalToken(SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(internalToken(`${SECRET}y`)).not.toBe(token);
  });

  it("requires the owner on every session call", async () => {
    const res = await fetch(`${apiBase}/internal/browser/sessions`, {
      method: "POST",
      headers: { "x-internal-token": token, "content-type": "application/json" },
      body: JSON.stringify({ url: siteBase }),
    });
    expect(res.status).toBe(400);
  });

  it("leaves other paths to the rest of the server", async () => {
    const res = await fetch(`${apiBase}/health`);
    expect(await res.text()).toBe("not browser");
  });
});

describe("sessions over HTTP", () => {
  it("creates, streams frames with ETags, acts, isolates owners, and closes", async () => {
    const created = await call("/internal/browser/sessions", { method: "POST", body: { url: siteBase, device: "mobile" } });
    expect(created.status).toBe(201);
    const info = (await created.json()) as { id: string; width: number; height: number; url: string };
    expect(info).toMatchObject({ width: 390, height: 844, url: `${siteBase}/` });

    let frame = await call(`/internal/browser/sessions/${info.id}/frame`);
    for (let i = 0; i < 20 && decodeURIComponent(frame.headers.get("x-browser-title") ?? "") !== "عنوان صفحه"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      frame = await call(`/internal/browser/sessions/${info.id}/frame`);
    }
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect(decodeURIComponent(frame.headers.get("x-browser-title")!)).toBe("عنوان صفحه");
    expect(decodeURIComponent(frame.headers.get("x-browser-url")!)).toBe(`${siteBase}/`);
    let etag = frame.headers.get("etag")!;
    expect(Buffer.from(await frame.arrayBuffer()).subarray(0, 2).toString("hex")).toBe("ffd8");

    // Once the page stops painting, the same ETag gets an empty 304.
    let again = await call(`/internal/browser/sessions/${info.id}/frame`, { headers: { "if-none-match": etag } });
    for (let i = 0; i < 20 && again.status !== 304; i++) {
      etag = again.headers.get("etag")!;
      await new Promise((r) => setTimeout(r, 300));
      again = await call(`/internal/browser/sessions/${info.id}/frame`, { headers: { "if-none-match": etag } });
    }
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("x-browser-loading")).toBe("0");

    const act = await call(`/internal/browser/sessions/${info.id}/action`, {
      method: "POST",
      body: { type: "scroll", dy: 200 },
    });
    expect(act.status).toBe(200);
    expect(await act.json()).toMatchObject({ url: `${siteBase}/`, loading: false });

    const badKey = await call(`/internal/browser/sessions/${info.id}/action`, {
      method: "POST",
      body: { type: "key", key: "Control+W" },
    });
    expect(badKey.status).toBe(400);

    const blocked = await call(`/internal/browser/sessions/${info.id}/action`, {
      method: "POST",
      body: { type: "navigate", url: "file:///etc/passwd" },
    });
    expect(blocked.status).toBe(400);

    for (const [method, path] of [
      ["GET", `/internal/browser/sessions/${info.id}/frame`],
      ["POST", `/internal/browser/sessions/${info.id}/action`],
      ["DELETE", `/internal/browser/sessions/${info.id}`],
    ] as const) {
      const res = await call(path, {
        method,
        headers: mallory,
        ...(method === "POST" ? { body: { type: "reload" } } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    expect((await call(`/internal/browser/sessions/${info.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/internal/browser/sessions/${info.id}/frame`)).status).toBe(404);
    expect((await call(`/internal/browser/sessions/not-an-id/frame`)).status).toBe(404);
  });

  it("renders a page and returns the screenshot as base64", async () => {
    const res = await call("/internal/browser/render", { method: "POST", body: { url: siteBase, device: "desktop" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { screenshot: string; seo: { title: string; h1: string[] } };
    expect(body.seo).toMatchObject({ title: "عنوان صفحه", h1: ["Hello"] });
    expect(Buffer.from(body.screenshot, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  it("answers BLOCKED_ADDRESS for private targets in production mode", async () => {
    delete process.env.ALLOW_PRIVATE_NETWORK;
    try {
      const res = await call("/internal/browser/render", {
        method: "POST",
        body: { url: "http://169.254.169.254/latest/meta-data/", device: "desktop" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BLOCKED_ADDRESS");
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "1";
    }
  });

  it("answers BROWSER_UNAVAILABLE while the worker drains", async () => {
    draining = true;
    try {
      const res = await call("/internal/browser/sessions", { method: "POST", body: { url: siteBase } });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BROWSER_UNAVAILABLE");
    } finally {
      draining = false;
    }
  });
});

describe("configuration", () => {
  it("treats a Railway reference that rendered without a host as unset", () => {
    const saved = process.env.WORKER_INTERNAL_URL;
    try {
      process.env.WORKER_INTERNAL_URL = "http://:3001";
      resetEnvCache();
      expect(env().WORKER_INTERNAL_URL).toBe("http://127.0.0.1:3001");
      process.env.WORKER_INTERNAL_URL = "http://worker.railway.internal:3001";
      resetEnvCache();
      expect(env().WORKER_INTERNAL_URL).toBe("http://worker.railway.internal:3001");
      expect(env().BROWSER_MAX_SESSIONS).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.WORKER_INTERNAL_URL;
      else process.env.WORKER_INTERNAL_URL = saved;
      resetEnvCache();
    }
  });
});
