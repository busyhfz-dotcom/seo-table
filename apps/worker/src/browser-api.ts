/**
 * The worker's internal browser API (contract K3), served on the same HTTP
 * server as the health checks. Only the web service calls it: every request
 * carries `x-internal-token` (an HMAC of SESSION_SECRET), and the person the web
 * service authenticated, as `x-org-id` / `x-user-id`, whose sessions are the
 * only ones the request can touch.
 *
 *   POST   /internal/browser/sessions              {url, device, locale}  → SessionInfo
 *   GET    /internal/browser/sessions/:id/frame    (If-None-Match)        → image/jpeg | 304
 *   POST   /internal/browser/sessions/:id/action   BrowserAction          → ActionResult
 *   DELETE /internal/browser/sessions/:id                                 → {ok}
 *   POST   /internal/browser/render                {url, device, changes?, locale} → RenderResult
 *   GET    /internal/browser/status                                       → limits and usage
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AppError,
  BadRequest,
  childLogger,
  constantTimeEquals,
  errorToResponse,
  isAppError,
  NotFound,
  Unauthorized,
} from "@seo/core";
import {
  actionSchema,
  BrowserUnavailable,
  createSessionSchema,
  internalToken,
  renderSchema,
  type BrowserManager,
  type Frame,
  type Owner,
} from "@seo/browser";

const log = childLogger({ component: "browser-api" });
const PREFIX = "/internal/browser/";
const MAX_BODY_BYTES = 256 * 1024;
const OWNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[a-f0-9]{32}$/;

class PayloadTooLarge extends AppError {
  constructor() {
    super(413, "PAYLOAD_TOO_LARGE", "The request body is too large");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The page state travels in headers so a 304 can carry it too (titles are percent-encoded: headers are Latin-1). */
function stateHeaders(frame: Frame): Record<string, string> {
  const s = frame.state;
  return {
    etag: frame.etag,
    "cache-control": "no-store",
    "x-browser-url": encodeURIComponent(s.url),
    "x-browser-title": encodeURIComponent(s.title.slice(0, 300)),
    "x-browser-loading": s.loading ? "1" : "0",
    "x-browser-back": s.canGoBack ? "1" : "0",
    "x-browser-forward": s.canGoForward ? "1" : "0",
    ...(s.error ? { "x-browser-error": s.error } : {}),
  };
}

type Schema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
};

async function readJson<T>(req: IncomingMessage, schema: Schema<T>): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(chunk as Buffer);
  }
  let value: unknown = {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new BadRequest("The request body is not valid JSON");
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequest("The request body is not valid", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

function ownerOf(req: IncomingMessage): Owner {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  if (typeof orgId !== "string" || typeof userId !== "string" || !OWNER_ID.test(orgId) || !OWNER_ID.test(userId)) {
    throw new BadRequest("x-org-id and x-user-id are required");
  }
  return { orgId, userId };
}

export type BrowserApiOptions = {
  manager: () => BrowserManager;
  sessionSecret: string;
  /** While true (the worker is draining) every call answers BROWSER_UNAVAILABLE. */
  draining?: () => boolean;
};

/** Returns a request handler that answers /internal/browser/* and reports whether it did. */
export function browserApi(options: BrowserApiOptions) {
  const expected = internalToken(options.sessionSecret);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://worker.internal");
    if (!url.pathname.startsWith(PREFIX)) return false;
    try {
      const token = req.headers["x-internal-token"];
      if (typeof token !== "string" || !constantTimeEquals(token, expected)) throw new Unauthorized();
      if (options.draining?.()) throw new BrowserUnavailable("The worker is restarting");

      const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const manager = options.manager();

      if (parts[0] === "status" && parts.length === 1 && method === "GET") {
        sendJson(res, 200, manager.stats());
        return true;
      }
      const owner = ownerOf(req);

      if (parts[0] === "render" && parts.length === 1 && method === "POST") {
        const body = await readJson(req, renderSchema);
        sendJson(res, 200, await manager.render(body));
        return true;
      }

      if (parts[0] === "sessions") {
        if (parts.length === 1 && method === "POST") {
          const body = await readJson(req, createSessionSchema);
          sendJson(res, 201, await manager.createSession(owner, body));
          return true;
        }
        const id = parts[1] ?? "";
        if (!SESSION_ID.test(id)) throw new NotFound("Browser session not found");
        if (parts.length === 2 && method === "DELETE") {
          await manager.closeSession(owner, id);
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (parts.length === 3 && parts[2] === "frame" && method === "GET") {
          const frame = await manager.frame(owner, id, req.headers["if-none-match"] ?? null);
          if (frame.notModified) {
            res.writeHead(304, stateHeaders(frame)).end();
          } else {
            res.writeHead(200, {
              ...stateHeaders(frame),
              "content-type": "image/jpeg",
              "content-length": String(frame.body.length),
            });
            res.end(frame.body);
          }
          return true;
        }
        if (parts.length === 3 && parts[2] === "action" && method === "POST") {
          const action = await readJson(req, actionSchema);
          sendJson(res, 200, await manager.action(owner, id, action));
          return true;
        }
      }
      throw new NotFound();
    } catch (err) {
      const { status, body } = errorToResponse(err);
      if (!isAppError(err)) log.error({ err: (err as Error).message, path: url.pathname }, "browser API error");
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
      return true;
    }
  };
}
