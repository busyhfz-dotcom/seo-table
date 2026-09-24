/**
 * Where the Instagram and Telegram clients send their requests.
 *
 * Production uses the vendors' hosts. Tests point the clients at local doubles
 * through `setSocialEndpoints`, a function rather than an environment variable
 * so a deployment's configuration can never redirect an access token or a bot
 * token to another host.
 */
export type SocialEndpoints = {
  /** Instagram API with Instagram Login (profile, media, insights, publishing, token exchange). */
  instagramGraph: string;
  /** Short-lived token exchange (api.instagram.com/oauth/access_token). */
  instagramApi: string;
  /** The consent screen the owner is sent to (a browser redirect, never fetched by us). */
  instagramAuthorize: string;
  telegramApi: string;
  /** Telegram's public channel preview (t.me/s/<channel>). */
  telegramPreview: string;
};

const DEFAULTS: SocialEndpoints = {
  instagramGraph: "https://graph.instagram.com",
  instagramApi: "https://api.instagram.com",
  instagramAuthorize: "https://www.instagram.com/oauth/authorize",
  telegramApi: "https://api.telegram.org",
  telegramPreview: "https://t.me",
};

let current: SocialEndpoints = { ...DEFAULTS };

export function socialEndpoints(): SocialEndpoints {
  return current;
}

/** Test hook: override some endpoints; call with no argument to restore the vendors' hosts. */
export function setSocialEndpoints(partial?: Partial<SocialEndpoints>): void {
  current = partial ? { ...current, ...partial } : { ...DEFAULTS };
}

/** Network failures that prove the request never reached the platform. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Whether a thrown fetch error means the request certainly did not arrive
 * (safe to send again) or may have arrived (a post may exist: never resend).
 */
export function deliveryOf(err: unknown): "not_sent" | "unknown" {
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code;
  if (code && NOT_SENT.has(code)) return "not_sent";
  if ((err as { code?: string }).code === "blocked_address") return "not_sent";
  return "unknown";
}
