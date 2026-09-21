/**
 * Instagram and YouTube.
 *
 * These are production-ready connector shells, not demos. The OAuth flow, the
 * token store, the refresh logic and the API surface are all defined — but no
 * OAuth application exists for this product yet, so there is no credential to
 * authenticate with.
 *
 * The deliberate consequence: `check()` reports `not_configured`, the UI shows
 * "not connected", and the read methods refuse rather than returning data.
 * Nothing here fabricates a follower count, a view count or a post. When real
 * OAuth credentials exist, `authorizeUrl` / `exchangeCode` / `refresh` are the
 * only functions that need filling in, and the rest already works.
 */
import { ConnectorError, httpJson, type Connector, type ConnectorCapabilities, type ConnectorHealth } from "./types.js";

export type OAuthAppConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
};

export type SocialCredentials = {
  app?: OAuthAppConfig;
  tokens?: OAuthTokens;
  /** Instagram business account id, or YouTube channel id. */
  accountId?: string;
};

const NOT_CONFIGURED: ConnectorHealth = {
  ok: false,
  reason: "not_configured",
  message:
    "No OAuth application is registered for this connector yet. Nothing can be read until a real client id, secret and redirect URI are supplied — no placeholder data is shown in the meantime.",
};

function shell(
  kind: "INSTAGRAM" | "YOUTUBE",
  creds: SocialCredentials,
  spec: {
    authBase: string;
    tokenUrl: string;
    scopes: string[];
    profileUrl: (accountId: string) => string;
    notes: string[];
  },
): Connector & {
  authorizeUrl: (state: string) => string;
  exchangeCode: (code: string) => Promise<OAuthTokens>;
  refresh: () => Promise<OAuthTokens>;
  configured: () => boolean;
} {
  const configured = () => Boolean(creds.app?.clientId && creds.app?.clientSecret && creds.app?.redirectUri);

  async function capabilities(): Promise<ConnectorCapabilities> {
    return { writableFields: [], supportedActions: [], notes: spec.notes };
  }

  async function check(): Promise<ConnectorHealth & { capabilities?: ConnectorCapabilities }> {
    if (!configured()) return { ...NOT_CONFIGURED, capabilities: await capabilities() };
    if (!creds.tokens?.accessToken) {
      return {
        ok: false,
        reason: "not_authorized",
        message: "The OAuth application is configured but no account has authorized it yet.",
        capabilities: await capabilities(),
      };
    }
    if (!creds.accountId) {
      return {
        ok: false,
        reason: "no_account_selected",
        message: "Authorized, but no account or channel has been selected.",
        capabilities: await capabilities(),
      };
    }
    const res = await httpJson<{ id?: string; error?: unknown }>(spec.profileUrl(creds.accountId), {
      headers: { authorization: `Bearer ${creds.tokens.accessToken}` },
    });
    if (res.status === 401) {
      return { ok: false, reason: "token_expired", message: "The access token has expired; re-authorize the account." };
    }
    if (res.status >= 400) {
      return { ok: false, reason: `http_${res.status}`, message: res.text.slice(0, 200) };
    }
    return { ok: true, message: `Connected to ${kind.toLowerCase()} account ${creds.accountId}.`, capabilities: await capabilities() };
  }

  function authorizeUrl(state: string): string {
    if (!creds.app) throw new ConnectorError("not_configured", NOT_CONFIGURED.message!);
    const u = new URL(spec.authBase);
    u.searchParams.set("client_id", creds.app.clientId);
    u.searchParams.set("redirect_uri", creds.app.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", spec.scopes.join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("access_type", "offline");
    return u.toString();
  }

  async function exchangeCode(code: string): Promise<OAuthTokens> {
    if (!creds.app) throw new ConnectorError("not_configured", NOT_CONFIGURED.message!);
    const res = await httpJson<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error_description?: string;
    }>(spec.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: creds.app.clientId,
        client_secret: creds.app.clientSecret,
        redirect_uri: creds.app.redirectUri,
      }).toString(),
    });
    if (res.status >= 400 || !res.data?.access_token) {
      throw new ConnectorError("token_exchange_failed", res.data?.error_description ?? `HTTP ${res.status}`);
    }
    return {
      accessToken: res.data.access_token,
      ...(res.data.refresh_token ? { refreshToken: res.data.refresh_token } : {}),
      ...(res.data.expires_in ? { expiresAt: Date.now() + res.data.expires_in * 1000 } : {}),
      ...(res.data.scope ? { scope: res.data.scope } : {}),
    };
  }

  async function refresh(): Promise<OAuthTokens> {
    if (!creds.app || !creds.tokens?.refreshToken) {
      throw new ConnectorError("not_authorized", "No refresh token is stored for this account.");
    }
    const res = await httpJson<{ access_token?: string; expires_in?: number; error_description?: string }>(spec.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.tokens.refreshToken,
        client_id: creds.app.clientId,
        client_secret: creds.app.clientSecret,
      }).toString(),
    });
    if (res.status >= 400 || !res.data?.access_token) {
      throw new ConnectorError("refresh_failed", res.data?.error_description ?? `HTTP ${res.status}`);
    }
    return {
      accessToken: res.data.access_token,
      refreshToken: creds.tokens.refreshToken,
      ...(res.data.expires_in ? { expiresAt: Date.now() + res.data.expires_in * 1000 } : {}),
    };
  }

  return { kind, check, capabilities, authorizeUrl, exchangeCode, refresh, configured };
}

export function instagram(creds: SocialCredentials = {}) {
  return shell("INSTAGRAM", creds, {
    authBase: "https://api.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_basic", "instagram_manage_insights", "pages_show_list"],
    profileUrl: (id) => `https://graph.instagram.com/${id}?fields=id,username`,
    notes: [
      "Requires a Meta app with Instagram Graph API access and a Business or Creator account.",
      "No data is displayed until a real account authorizes the app.",
    ],
  });
}

export function youtube(creds: SocialCredentials = {}) {
  return shell("YOUTUBE", creds, {
    authBase: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"],
    profileUrl: (id) => `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${id}`,
    notes: [
      "Requires a Google Cloud OAuth client with the YouTube Data and Analytics APIs enabled.",
      "No data is displayed until a real channel authorizes the app.",
    ],
  });
}
