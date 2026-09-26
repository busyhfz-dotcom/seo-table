import { NextResponse } from "next/server";
import { enforce, NotFound } from "@seo/core";
import { handler } from "../../../../../../lib/route";
import { callWorker, SESSION_ID, workerError } from "../../../_lib/worker";

const PASSED_HEADERS = [
  "etag",
  "x-browser-url",
  "x-browser-title",
  "x-browser-loading",
  "x-browser-back",
  "x-browser-forward",
  "x-browser-error",
];

/**
 * The session's current picture as image/jpeg. Send the last ETag in
 * If-None-Match: while the page has not changed the answer is an empty 304.
 * The page's URL, title (both percent-encoded), loading and history state
 * ride along in x-browser-* headers on both answers.
 *
 * Polled a few times a second, so it has its own per-person budget instead of
 * the general API limit.
 */
export const GET = handler(
  { permission: "scan:run", sessionOnly: true, noRateLimit: true },
  async ({ req, session, params }) => {
    const id = params.id ?? "";
    if (!SESSION_ID.test(id)) throw new NotFound("Browser session not found");
    await enforce(`browser:frame:${session.userId}`, 600, 60_000);
    const ifNoneMatch = req.headers.get("if-none-match");
    const res = await callWorker(`/sessions/${id}/frame`, {
      method: "GET",
      caller: session,
      headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
      timeoutMs: 10_000,
    });
    if (res.status !== 200 && res.status !== 304) {
      throw workerError(res.status, await res.json().catch(() => null));
    }
    const headers = new Headers({ "cache-control": "private, no-store" });
    for (const name of PASSED_HEADERS) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (res.status === 304) return new NextResponse(null, { status: 304, headers });
    headers.set("content-type", "image/jpeg");
    return new NextResponse(await res.arrayBuffer(), { status: 200, headers });
  },
);
