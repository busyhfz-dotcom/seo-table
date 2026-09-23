/**
 * JSON over the SSRF-guarded fetch, for vendor APIs (DataForSEO, PageSpeed
 * Insights, Telegram, Google Suggest) and customer webhooks alike. The guard
 * costs nothing for a public vendor host and is essential for a webhook URL a
 * customer typed. Redirects are never followed: a redirected POST would turn
 * into a GET and report a delivery that never happened.
 */
import { BlockedAddressError, guardedFetch } from "@seo/core";

export class ProviderError extends Error {
  constructor(
    /** Stable machine reason the panel translates: invalid_credentials, insufficient_funds, … */
    readonly reason: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type JsonResponse<T> = { status: number; data: T | null; text: string; headers: Headers };

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {},
): Promise<JsonResponse<T>> {
  const { timeoutMs = 30_000, maxBytes = 10 * 1024 * 1024, ...rest } = init;
  let res;
  try {
    res = await guardedFetch(url, { ...rest, timeoutMs, maxBytes });
  } catch (err) {
    if (err instanceof BlockedAddressError) throw new ProviderError("blocked_address", err.message);
    throw new ProviderError("network_error", (err as Error).message);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ProviderError("redirected", `${new URL(url).origin} answered HTTP ${res.status} with a redirect`, {
      status: res.status,
    });
  }
  if (res.truncated) throw new ProviderError("response_too_large", `The response from ${new URL(url).origin} was too large`);
  const text = res.body.toString("utf8");
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, headers: res.headers };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
