import { createHmac } from "node:crypto";

/** What the shared secret is bound to, so this token is useless as any other credential. */
export const INTERNAL_TOKEN_CONTEXT = "seo-table-internal-browser";

/**
 * The `x-internal-token` web sends and the worker expects (contract K3): hex
 * HMAC-SHA256 of a fixed context string, keyed with SESSION_SECRET, which both
 * services already share. Nothing new to configure or rotate separately.
 */
export function internalToken(sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(INTERNAL_TOKEN_CONTEXT).digest("hex");
}
