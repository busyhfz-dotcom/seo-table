/**
 * The web side of contract K3: every /api/browser route is a thin, authenticated
 * proxy to the worker's /internal/browser API, which hosts Chromium. The web
 * process never runs a browser (Next would have to bundle it, and a web replica
 * is sized for requests, not renderers).
 */
import { createHmac } from "node:crypto";
import { AppError, childLogger, env } from "@seo/core";

const log = childLogger({ component: "browser-proxy" });

/**
 * Same derivation as `internalToken` in @seo/browser (a test holds them equal);
 * repeated here so the web bundle does not pull in Playwright.
 */
export function internalToken(sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update("seo-table-internal-browser").digest("hex");
}

/** Session ids are 32 hex characters; anything else is not worth a round trip. */
export const SESSION_ID = /^[a-f0-9]{32}$/;

export class BrowserUnavailable extends AppError {
  constructor(message = "The browser service is not reachable") {
    super(503, "BROWSER_UNAVAILABLE", message);
  }
}

type Caller = { orgId: string; userId: string };

export async function callWorker(
  path: string,
  opts: { method: string; caller: Caller; body?: unknown; headers?: Record<string, string>; timeoutMs: number },
): Promise<Response> {
  const base = env().WORKER_INTERNAL_URL.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "x-internal-token": internalToken(env().SESSION_SECRET),
    "x-org-id": opts.caller.orgId,
    "x-user-id": opts.caller.userId,
    ...opts.headers,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base}/internal/browser${path}`, {
      method: opts.method,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message, path }, "worker browser API unreachable");
    throw new BrowserUnavailable();
  }
  if (res.status === 401) {
    // Web and worker disagree on SESSION_SECRET: an operator's problem, not the viewer's session.
    log.error({ path }, "worker refused the internal token; SESSION_SECRET differs between web and worker");
    throw new BrowserUnavailable();
  }
  return res;
}

/** The worker's JSON answer, or its `{error}` rethrown as the same AppError. */
export async function workerJson<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw new BrowserUnavailable("The browser service sent an unreadable answer");
  }
  if (res.ok) return body as T;
  throw workerError(res.status, body);
}

export function workerError(status: number, body: unknown): AppError {
  const e = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  if (e && typeof e.code === "string") {
    return new AppError(status, e.code, typeof e.message === "string" ? e.message : e.code, e.details);
  }
  return new BrowserUnavailable();
}
