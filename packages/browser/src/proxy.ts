/**
 * A forward proxy on 127.0.0.1 that is Chromium's only route to the network.
 * HTTPS and WebSocket traffic arrives as CONNECT tunnels, plain HTTP as
 * absolute-form requests; either way the proxy resolves the host with the SSRF
 * rule and connects to that exact address, so no later DNS answer is used.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { childLogger } from "@seo/core";
import { resolvePublic } from "./guard.js";

const log = childLogger({ component: "browser-proxy" });
const IDLE_MS = 60_000;
const HOP_BY_HOP = [
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
];

export type GuardedProxy = { port: number; close(): Promise<void> };

function refuse(socket: Duplex, status: number, text: string): void {
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  else socket.destroy();
}

function statusFor(err: unknown): number {
  return (err as { code?: string }).code === "BLOCKED_ADDRESS" ? 403 : 502;
}

async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (target.protocol !== "http:") {
    res.writeHead(400).end();
    return;
  }
  let address: { address: string; family: number };
  try {
    address = await resolvePublic(target.hostname);
  } catch (err) {
    res.writeHead(statusFor(err)).end();
    return;
  }
  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];
  const upstream = http.request({
    host: address.address,
    family: address.family,
    port: Number(target.port) || 80,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: { ...headers, host: target.host },
    timeout: IDLE_MS,
  });
  upstream.on("response", (up) => {
    const out = { ...up.headers };
    for (const h of HOP_BY_HOP) delete out[h];
    res.writeHead(up.statusCode ?? 502, out);
    up.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

async function tunnel(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
  const [host, portText] = splitHostPort(req.url ?? "");
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return refuse(client, 400, "Bad Request");
  let address: { address: string; family: number };
  try {
    address = await resolvePublic(host);
  } catch (err) {
    return refuse(client, statusFor(err), statusFor(err) === 403 ? "Forbidden" : "Bad Gateway");
  }
  const upstream = net.connect({ host: address.address, port, family: address.family });
  upstream.setTimeout(IDLE_MS, () => upstream.destroy());
  let established = false;
  client.on("error", () => upstream.destroy());
  // Once the tunnel is up the bytes are the browser's TLS stream: no HTTP answer fits in it.
  upstream.on("error", () => (established ? client.destroy() : refuse(client, 502, "Bad Gateway")));
  upstream.once("connect", () => {
    established = true;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
}

/** "host:port" or "[v6]:port". */
function splitHostPort(authority: string): [string, string] {
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(authority);
  if (v6) return [v6[1]!, v6[2]!];
  const i = authority.lastIndexOf(":");
  return i > 0 ? [authority.slice(0, i), authority.slice(i + 1)] : [authority, ""];
}

export async function startGuardedProxy(): Promise<GuardedProxy> {
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    forward(req, res).catch((err: Error) => {
      log.warn({ err: err.message }, "proxy request failed");
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  server.on("connect", (req, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    tunnel(req, socket, head).catch(() => socket.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
