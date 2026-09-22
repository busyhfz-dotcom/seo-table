/**
 * Connector registry: loads a project's connector row, unseals its credentials
 * and hands back a live client. Credentials are decrypted here and nowhere else,
 * and are never returned to a caller.
 */
import { db, connectors as connectorsTable, eq, and, type ConnectorKind } from "@seo/db";
import { seal, unsealJson, type SealedSecret } from "@seo/core";
import { ga4, type Ga4Credentials } from "./ga4.js";
import { searchConsole, type SearchConsoleCredentials } from "./search-console.js";
import { instagram, youtube, type SocialCredentials } from "./social.js";
import { wordpress, type WordPressCredentials } from "./wordpress.js";
import { NotConnected } from "@seo/core";
import type { Connector } from "./types.js";

export * from "./types.js";
export { wordpress, type WordPressCredentials } from "./wordpress.js";
export { searchConsole, type SearchConsoleCredentials, type Opportunity, type QueryRow, type SuggestedActionCode } from "./search-console.js";
export { ga4, type Ga4Credentials, type PageMetrics } from "./ga4.js";
export { instagram, youtube, type SocialCredentials, type OAuthTokens, type OAuthAppConfig } from "./social.js";
export { accessToken, forgetTokens, SCOPES, type GoogleCredentials } from "./google-auth.js";

export type AnyCredentials =
  | WordPressCredentials
  | SearchConsoleCredentials
  | Ga4Credentials
  | SocialCredentials;

export function build(kind: ConnectorKind, creds: AnyCredentials): Connector {
  switch (kind) {
    case "WORDPRESS":
      return wordpress(creds as WordPressCredentials);
    case "SEARCH_CONSOLE":
      return searchConsole(creds as SearchConsoleCredentials);
    case "GA4":
      return ga4(creds as Ga4Credentials);
    case "INSTAGRAM":
      return instagram(creds as SocialCredentials);
    case "YOUTUBE":
      return youtube(creds as SocialCredentials);
    default: {
      const never: never = kind;
      throw new Error(`Unknown connector kind: ${String(never)}`);
    }
  }
}

/** Load a connected connector for a project, or throw NotConnected. */
export async function forProject(projectId: string, kind: ConnectorKind): Promise<Connector> {
  const rows = await db
    .select()
    .from(connectorsTable)
    .where(and(eq(connectorsTable.projectId, projectId), eq(connectorsTable.kind, kind)))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "CONNECTED" || !row.secretCipher || !row.secretIv || !row.secretTag) {
    throw new NotConnected(kind);
  }
  const creds = unsealJson<AnyCredentials>({
    cipher: row.secretCipher,
    iv: row.secretIv,
    tag: row.secretTag,
  });
  return build(kind, creds);
}

/** Same, but returns null instead of throwing — for screens that degrade gracefully. */
export async function forProjectOrNull(projectId: string, kind: ConnectorKind): Promise<Connector | null> {
  try {
    return await forProject(projectId, kind);
  } catch {
    return null;
  }
}

export function sealCredentials(creds: AnyCredentials): SealedSecret {
  return seal(JSON.stringify(creds));
}

/** Everything the Connectors screen needs, with no secret material in it. */
export type ConnectorSummary = {
  kind: ConnectorKind;
  status: "NOT_CONNECTED" | "CONNECTED" | "ERROR";
  lastSyncAt: string | null;
  lastError: string | null;
  scopes: string[];
  /** True when this connector cannot be connected yet for lack of an OAuth app. */
  awaitingOAuthApp: boolean;
};

export const CONNECTOR_KINDS: ConnectorKind[] = [
  "WORDPRESS",
  "SEARCH_CONSOLE",
  "GA4",
  "INSTAGRAM",
  "YOUTUBE",
];

/** Kinds that have no OAuth application registered for this product yet. */
export const AWAITING_OAUTH_APP: ConnectorKind[] = ["INSTAGRAM", "YOUTUBE"];
