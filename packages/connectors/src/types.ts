import type { ConnectorKind, FixAction } from "@seo/db";

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
  after: string;
  selector?: string;
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
  /** Reads the current value of a field, used to build the rollback snapshot. */
  read?: (req: Pick<WriteRequest, "url" | "field" | "selector">) => Promise<string | null>;
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

/** Fetch with a timeout and no retry-on-write, so a write is never duplicated. */
export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; data: T | null; text: string; headers: Headers }> {
  const { timeoutMs = 20_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, headers: res.headers };
}
