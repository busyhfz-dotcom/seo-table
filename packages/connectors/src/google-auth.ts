/**
 * Google access tokens, with no SDK.
 *
 * Two credential shapes are supported, because both are what people actually
 * have:
 *   - a service account JSON key (signed JWT assertion, RS256);
 *   - an OAuth client plus refresh token (for a property you own personally and
 *     cannot share with a service account).
 *
 * Tokens are cached in memory until shortly before expiry. Nothing is written to
 * disk and nothing is logged.
 */
import { createHash, createSign } from "node:crypto";
import { ConnectorError, httpJson } from "./types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ServiceAccountKey = {
  type: "service_account";
  client_email: string;
  private_key: string;
  /** Optional: impersonate a user in a Workspace domain. */
  subject?: string;
};

export type OAuthRefresh = {
  type: "oauth_refresh";
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

export type GoogleCredentials = ServiceAccountKey | OAuthRefresh;

type CacheEntry = { token: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * The whole credential is part of the key: two projects sharing an OAuth client
 * (or a service account impersonating different subjects) hold different grants,
 * and one must never be handed a token minted for the other. Hashed so no secret
 * sits in the map's keys.
 */
export function cacheKey(creds: GoogleCredentials, scopes: string[]): string {
  const material =
    creds.type === "service_account"
      ? [creds.type, creds.client_email, creds.private_key, creds.subject ?? ""]
      : [creds.type, creds.client_id, creds.client_secret, creds.refresh_token];
  return createHash("sha256")
    .update(JSON.stringify([...material, [...scopes].sort().join(" ")]))
    .digest("hex");
}

export async function accessToken(creds: GoogleCredentials, scopes: string[]): Promise<string> {
  const key = cacheKey(creds, scopes);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;

  const body =
    creds.type === "service_account"
      ? new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: signAssertion(creds, scopes),
        })
      : new URLSearchParams({
          grant_type: "refresh_token",
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          refresh_token: creds.refresh_token,
        });

  const res = await httpJson<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );

  if (res.status >= 400 || !res.data?.access_token) {
    throw new ConnectorError(
      res.data?.error === "invalid_grant" ? "invalid_credentials" : "token_exchange_failed",
      res.data?.error_description ?? `Google returned HTTP ${res.status} when exchanging credentials`,
    );
  }

  const token = res.data.access_token;
  cache.set(key, { token, expiresAt: Date.now() + (res.data.expires_in ?? 3600) * 1000 });
  return token;
}

function signAssertion(creds: ServiceAccountKey, scopes: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims: Record<string, unknown> = {
    iss: creds.client_email,
    scope: scopes.join(" "),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  if (creds.subject) claims.sub = creds.subject;
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(creds.private_key.replace(/\\n/g, "\n"));
  return `${header}.${payload}.${b64url(signature)}`;
}

export function forgetTokens(): void {
  cache.clear();
}

export const SCOPES = {
  searchConsole: ["https://www.googleapis.com/auth/webmasters.readonly"],
  analytics: ["https://www.googleapis.com/auth/analytics.readonly"],
} as const;
