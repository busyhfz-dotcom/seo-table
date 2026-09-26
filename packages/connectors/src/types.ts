import type { ConnectorKind, FixAction } from "@seo/db";
import { BlockedAddressError, guardedFetch } from "@seo/core";

export type ConnectorHealth = {
  ok: boolean;
  /** Short machine reason when not ok, e.g. "invalid_credentials". */
  reason?: string;
  message?: string;
  detail?: Record<string, unknown>;
};

/** What a connector can actually do on this particular site, probed at connect time. */
export type ConnectorCapabilities = {
  /** Fields this connector can write. Anything absent is reported as unsupported. */
  writableFields: string[];
  /** Fix actions this connector can execute. */
  supportedActions: FixAction[];
  /** Human-readable notes, e.g. "redirects need a redirect plugin". */
  notes: string[];
};

export type WriteRequest = {
  url: string;
  field: string;
  before: string | null;
  /** null removes the value (deletes the meta key, the redirect, clears the alt text). */
  after: string | null;
  selector?: string;
  /**
   * "restore" when a rollback writes back a recorded value. A connector whose
   * store holds templates or overrides may then prefer clearing its own value
   * when that reproduces the recorded one, instead of pinning the old text.
   */
  intent?: "apply" | "restore";
};

export type WriteResult = {
  url: string;
  field: string;
  ok: boolean;
  /** Value read back from the remote after the write, when the API returns one. */
  applied?: string | null;
  /** The value the remote held before the write — what rollback restores. */
  previous?: string | null;
  error?: string;
  code?: string;
};

/**
 * Every connector implements the same shape, so the fix executor does not know
 * or care which CMS or API is behind a change.
 */
export type Connector = {
  kind: ConnectorKind;
  /** Verifies credentials and returns what this install supports. */
  check: () => Promise<ConnectorHealth & { capabilities?: ConnectorCapabilities }>;
  capabilities: () => Promise<ConnectorCapabilities>;
  /** Writes one change. Must be safe to call twice with the same input. */
  write?: (req: WriteRequest) => Promise<WriteResult>;
  /**
   * Reads the current value of a field, used to build the rollback snapshot.
   * Resolves null only when the field is genuinely empty; throws when the value
   * cannot be read, so "unknown" is never mistaken for "empty".
   */
  read?: (req: Pick<WriteRequest, "url" | "field" | "selector">) => Promise<string | null>;
  /**
   * For connectors that layer an override over the site's own value (the
   * Cloudflare edge): the override alone, null when the site's value shows.
   * read() reports what visitors get; this reports what rollback must write
   * back so the override — not a copy of the old text — is what gets undone.
   */
  readStored?: (req: Pick<WriteRequest, "url" | "field" | "selector">) => Promise<string | null>;
};

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * JSON over the SSRF-guarded fetch, with a timeout and no retry, so a write is
 * never duplicated. Redirects are never followed: fetch turns a redirected POST
 * into a GET, which would report a write that never happened as a success.
 */
export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; data: T | null; text: string; headers: Headers }> {
  const { timeoutMs = 20_000, ...rest } = init;
  let res;
  try {
    res = await guardedFetch(url, { ...rest, timeoutMs, maxBytes: MAX_RESPONSE_BYTES });
  } catch (err) {
    if (err instanceof BlockedAddressError) {
      throw new ConnectorError("blocked_address", err.message);
    }
    throw err;
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "(no Location header)";
    throw new ConnectorError(
      "redirected",
      `${new URL(url).origin} answered HTTP ${res.status} redirecting to ${location}; use the final address as the site URL`,
      { status: res.status, location },
    );
  }
  if (res.truncated) {
    throw new ConnectorError("response_too_large", `The response from ${new URL(url).origin} exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  const text = res.body.toString("utf8");
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, headers: res.headers };
}
