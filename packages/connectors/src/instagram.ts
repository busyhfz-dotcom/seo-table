/**
 * Instagram API with Instagram Login (graph.instagram.com).
 *
 * Works with professional (Business or Creator) accounts only; a personal
 * account cannot authorize these scopes. What the API can and cannot do shapes
 * the product:
 *
 *  - read the profile, media, and media/account insights;
 *  - publish images, carousels and reels through media containers, with
 *    alt_text on images (since March 2025);
 *  - NOT change the profile name, biography or website: those findings are
 *    recommendations with copy-ready text that the owner pastes in the app;
 *  - NOT read other accounts: Business Discovery belongs to the Facebook Login
 *    flavour of the API. `businessDiscovery` asks anyway and reports
 *    `unsupported` when the token cannot, so competitors are never scraped.
 *
 * The access token travels in the query string (as the API documents), so no
 * error from here may carry a URL or a raw fetch message: messages are rebuilt
 * from the Graph error object.
 *
 * Insights metrics: `impressions`, `plays`, `video_views` and the reel play
 * counters were deprecated in April 2025; `views` replaces them. Account-level
 * `follower_count` and demographics need 100+ followers, so followers are taken
 * from the profile's followers_count each day instead.
 */
import { BlockedAddressError, guardedFetch } from "@seo/core";
import type { SocialCompetitorSnapshot, SocialPostMetrics } from "@seo/db";
import { ConnectorError } from "./types.js";
import { deliveryOf, socialEndpoints } from "./social-endpoints.js";

export const INSTAGRAM_GRAPH_VERSION = "v25.0";

/** instagram_business_manage_comments is asked for now so comment features need no second consent. */
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
  "instagram_business_manage_comments",
] as const;

/** Meta's documented ceiling on API-published posts per rolling 24 hours (a carousel counts once). */
export const INSTAGRAM_PUBLISH_LIMIT = 100;

export type InstagramApp = { appId: string; appSecret: string; redirectUri: string };

export class InstagramError extends ConnectorError {
  constructor(
    code: string,
    message: string,
    /** "not_sent": safe to retry; "unknown": the request may have been acted on; "rejected": the API answered with an error. */
    readonly delivery: "not_sent" | "unknown" | "rejected",
    detail?: Record<string, unknown>,
  ) {
    super(code, message, detail);
    this.name = "InstagramError";
  }
  /** Worth trying again later: rate limits and the API's own transient failures. */
  get transient(): boolean {
    return this.code === "rate_limited" || this.code === "api_unavailable" || this.delivery === "not_sent";
  }
}

type GraphError = { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean };

function reasonFor(status: number, e: GraphError | undefined): string {
  const code = e?.code;
  if (code === 190 || status === 401) return "invalid_token";
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80002 || status === 429) return "rate_limited";
  if (code === 9 && e?.error_subcode === 2207042) return "publish_limit_reached";
  if (code === 10 || (code !== undefined && code >= 200 && code < 300)) return "permission_denied";
  if (code === 100 && e?.error_subcode === 33) return "not_found";
  if (code === 100) return "invalid_parameter";
  if (e?.is_transient || code === 1 || code === 2 || status >= 500) return "api_unavailable";
  return "api_error";
}

async function graphRequest<T>(
  op: string,
  url: URL,
  init: { method?: "GET" | "POST"; form?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  let res;
  try {
    res = await guardedFetch(url.toString(), {
      method: init.method ?? "GET",
      headers: init.form ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
      body: init.form ? new URLSearchParams(init.form).toString() : undefined,
      timeoutMs: init.timeoutMs ?? 30_000,
      maxBytes: 5 * 1024 * 1024,
    });
  } catch (err) {
    const delivery = err instanceof BlockedAddressError ? "not_sent" : deliveryOf(err);
    throw new InstagramError("network_error", `Instagram ${op} could not be reached`, delivery);
  }
  let data: (T & { error?: GraphError; error_message?: string; error_type?: string }) | null = null;
  try {
    data = JSON.parse(res.body.toString("utf8"));
  } catch {
    data = null;
  }
  if (res.status >= 400 || !data || data.error) {
    const e = data?.error;
    const message = e?.message ?? data?.error_message ?? `HTTP ${res.status}`;
    throw new InstagramError(reasonFor(res.status, e), `Instagram ${op}: ${message}`.slice(0, 500), "rejected", {
      status: res.status,
      graphCode: e?.code ?? null,
      graphSubcode: e?.error_subcode ?? null,
    });
  }
  return data;
}

function graphUrl(path: string, params: Record<string, string | number | undefined>, token?: string): URL {
  const base = socialEndpoints().instagramGraph.replace(/\/$/, "");
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  if (token) url.searchParams.set("access_token", token);
  return url;
}

// ---------------------------------------------------------------- OAuth

export function instagramAuthorizeUrl(app: InstagramApp, state: string): string {
  const url = new URL(socialEndpoints().instagramAuthorize);
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
  url.searchParams.set("state", state);
  // Skip the "continue with Facebook" detour: this app uses Instagram Login only.
  url.searchParams.set("enable_fb_login", "0");
  return url.toString();
}

export type InstagramGrant = { accessToken: string; userId: string; permissions: string[] };

/** Authorization code → short-lived token (one hour). */
export async function exchangeInstagramCode(app: InstagramApp, code: string): Promise<InstagramGrant> {
  const url = new URL(`${socialEndpoints().instagramApi.replace(/\/$/, "")}/oauth/access_token`);
  // The API has answered both a flat object and {data: [...]} over time.
  type Grant = { access_token?: string; user_id?: string | number; permissions?: string | string[] };
  const body = await graphRequest<Grant & { data?: Grant[] }>("token exchange", url, {
    method: "POST",
    form: {
      client_id: app.appId,
      client_secret: app.appSecret,
      grant_type: "authorization_code",
      redirect_uri: app.redirectUri,
      // Instagram appends "#_" to the code in the redirect; it is not part of it.
      code: code.replace(/#_$/, ""),
    },
  });
  const grant = body.data?.[0] ?? body;
  if (!grant.access_token || grant.user_id === undefined) {
    throw new InstagramError("token_exchange_failed", "Instagram returned no access token", "rejected");
  }
  const permissions = Array.isArray(grant.permissions)
    ? grant.permissions
    : (grant.permissions ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { accessToken: grant.access_token, userId: String(grant.user_id), permissions };
}

export type InstagramToken = { accessToken: string; expiresAt: Date };

function tokenFrom(body: { access_token?: string; expires_in?: number }, now: number): InstagramToken {
  if (!body.access_token) throw new InstagramError("token_exchange_failed", "Instagram returned no access token", "rejected");
  // Documented as 60 days; the API states the exact figure in expires_in.
  return { accessToken: body.access_token, expiresAt: new Date(now + (body.expires_in ?? 60 * 86_400) * 1000) };
}

/** Short-lived → long-lived token (60 days). */
export async function longLivedInstagramToken(app: InstagramApp, shortLived: string): Promise<InstagramToken> {
  const url = graphUrl("access_token", { grant_type: "ig_exchange_token", client_secret: app.appSecret }, shortLived);
  return tokenFrom(await graphRequest("long-lived token exchange", url), Date.now());
}

/** Extends a long-lived token by another 60 days. Allowed once it is 24 hours old and still valid. */
export async function refreshInstagramToken(token: string): Promise<InstagramToken> {
  const url = graphUrl("refresh_access_token", { grant_type: "ig_refresh_token" }, token);
  return tokenFrom(await graphRequest("token refresh", url), Date.now());
}

// ---------------------------------------------------------------- reading

export type InstagramProfile = {
  id: string;
  username: string;
  name: string | null;
  biography: string | null;
  website: string | null;
  pictureUrl: string | null;
  accountType: string | null;
  followers: number | null;
  follows: number | null;
  mediaCount: number | null;
};

export type InstagramMedia = {
  id: string;
  caption: string | null;
  mediaType: string;
  productType: string | null;
  mediaUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  likes: number | null;
  comments: number | null;
  /** null = the API did not report alt text for this media (not "no alt text"). */
  altText: string | null | undefined;
  children: Array<{ mediaType: string; mediaUrl: string | null; altText: string | null | undefined }>;
};

const PROFILE_FIELDS = "user_id,username,name,biography,website,profile_picture_url,account_type,followers_count,follows_count,media_count";
const MEDIA_FIELDS_FULL =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,alt_text,children{media_type,media_url,alt_text}";
/** Some fields are documented as Facebook-Login-only; if the API refuses them, read without. */
const MEDIA_FIELDS_BASIC = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";

type RawMedia = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  alt_text?: string | null;
  children?: { data?: Array<{ media_type?: string; media_url?: string; alt_text?: string | null }> };
};

function toMedia(m: RawMedia, withAlt: boolean): InstagramMedia {
  return {
    id: m.id,
    caption: m.caption ?? null,
    mediaType: m.media_type ?? "UNKNOWN",
    productType: m.media_product_type ?? null,
    mediaUrl: m.media_url ?? m.thumbnail_url ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ?? null,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    altText: withAlt ? (m.alt_text ?? null) : undefined,
    children: (m.children?.data ?? []).map((c) => ({
      mediaType: c.media_type ?? "UNKNOWN",
      mediaUrl: c.media_url ?? null,
      altText: withAlt ? (c.alt_text ?? null) : undefined,
    })),
  };
}

export type ContainerParams =
  | { kind: "image"; imageUrl: string; caption?: string; altText?: string | null; carouselItem?: boolean }
  | { kind: "video"; videoUrl: string; carouselItem: true }
  | { kind: "reel"; videoUrl: string; caption?: string; shareToFeed?: boolean }
  | { kind: "carousel"; children: string[]; caption?: string };

export type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export function instagramClient(token: string, userId = "me") {
  const v = INSTAGRAM_GRAPH_VERSION;
  const get = <T>(op: string, path: string, params: Record<string, string | number | undefined> = {}) =>
    graphRequest<T>(op, graphUrl(`${v}/${path}`, params, token));
  const post = <T>(op: string, path: string, form: Record<string, string>) =>
    graphRequest<T>(op, graphUrl(`${v}/${path}`, {}, token), { method: "POST", form });

  async function profile(): Promise<InstagramProfile> {
    const p = await get<{
      id?: string;
      user_id?: string | number;
      username?: string;
      name?: string;
      biography?: string;
      website?: string;
      profile_picture_url?: string;
      account_type?: string;
      followers_count?: number;
      follows_count?: number;
      media_count?: number;
    }>("profile", "me", { fields: PROFILE_FIELDS });
    return {
      // user_id is the professional account id that media and insights are keyed by.
      id: String(p.user_id ?? p.id ?? userId),
      username: p.username ?? "",
      name: p.name ?? null,
      biography: p.biography ?? null,
      website: p.website ?? null,
      pictureUrl: p.profile_picture_url ?? null,
      accountType: p.account_type ?? null,
      followers: p.followers_count ?? null,
      follows: p.follows_count ?? null,
      mediaCount: p.media_count ?? null,
    };
  }

  /** Newest first, following the API's cursors, at most `max` items. */
  async function media(max = 100): Promise<InstagramMedia[]> {
    const out: InstagramMedia[] = [];
    let fields = MEDIA_FIELDS_FULL;
    let withAlt = true;
    let after: string | undefined;
    for (let page = 0; page < 10 && out.length < max; page++) {
      let body: { data?: RawMedia[]; paging?: { cursors?: { after?: string }; next?: string } };
      try {
        body = await get("media", "me/media", { fields, limit: Math.min(50, max - out.length), after });
      } catch (err) {
        if (err instanceof InstagramError && err.code === "invalid_parameter" && fields === MEDIA_FIELDS_FULL) {
          fields = MEDIA_FIELDS_BASIC;
          withAlt = false;
          page--;
          continue;
        }
        throw err;
      }
      for (const m of body.data ?? []) out.push(toMedia(m, withAlt));
      after = body.paging?.next ? body.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out.slice(0, max);
  }

  /**
   * Lifetime metrics of one post. Albums and reels support the same core set;
   * a post from before the account turned professional has none (null).
   */
  async function mediaInsights(mediaId: string): Promise<SocialPostMetrics | null> {
    let body: { data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> };
    try {
      body = await get("media insights", `${mediaId}/insights`, { metric: "reach,views,likes,comments,shares,saved,total_interactions" });
    } catch (err) {
      if (err instanceof InstagramError && (err.code === "invalid_parameter" || err.code === "not_found")) return null;
      throw err;
    }
    const value = (name: string) => {
      const m = body.data?.find((d) => d.name === name);
      const v = m?.total_value?.value ?? m?.values?.[0]?.value;
      return typeof v === "number" ? v : undefined;
    };
    const metrics: SocialPostMetrics = {};
    const set = (k: keyof SocialPostMetrics, v: number | undefined) => {
      if (v !== undefined) metrics[k] = v;
    };
    set("reach", value("reach"));
    set("views", value("views"));
    set("likes", value("likes"));
    set("comments", value("comments"));
    set("shares", value("shares"));
    set("saves", value("saved"));
    set("interactions", value("total_interactions"));
    return metrics;
  }

  /** One day's account totals (UTC day [since, until)). */
  async function accountInsights(day: string): Promise<{ reach: number | null; views: number | null; interactions: number | null }> {
    const since = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
    const body = await get<{ data?: Array<{ name: string; total_value?: { value?: number } }> }>("account insights", `${userId}/insights`, {
      metric: "reach,views,total_interactions",
      period: "day",
      metric_type: "total_value",
      since,
      until: since + 86_400,
    });
    const value = (name: string) => body.data?.find((d) => d.name === name)?.total_value?.value ?? null;
    return { reach: value("reach"), views: value("views"), interactions: value("total_interactions") };
  }

  async function publishingLimit(): Promise<{ used: number; total: number }> {
    const body = await get<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
      "publishing limit",
      `${userId}/content_publishing_limit`,
      { fields: "quota_usage,config" },
    );
    const row = body.data?.[0];
    return { used: row?.quota_usage ?? 0, total: row?.config?.quota_total ?? INSTAGRAM_PUBLISH_LIMIT };
  }

  async function createContainer(p: ContainerParams): Promise<string> {
    const form: Record<string, string> = {};
    if (p.kind === "image") {
      form.image_url = p.imageUrl;
      if (p.altText) form.alt_text = p.altText;
      if (p.carouselItem) form.is_carousel_item = "true";
      else if (p.caption) form.caption = p.caption;
    } else if (p.kind === "video") {
      form.media_type = "VIDEO";
      form.video_url = p.videoUrl;
      form.is_carousel_item = "true";
    } else if (p.kind === "reel") {
      form.media_type = "REELS";
      form.video_url = p.videoUrl;
      if (p.caption) form.caption = p.caption;
      form.share_to_feed = p.shareToFeed === false ? "false" : "true";
    } else {
      form.media_type = "CAROUSEL";
      form.children = p.children.join(",");
      if (p.caption) form.caption = p.caption;
    }
    const body = await post<{ id?: string }>("create container", `${userId}/media`, form);
    if (!body.id) throw new InstagramError("api_error", "Instagram created no container", "rejected");
    return body.id;
  }

  async function containerStatus(containerId: string): Promise<{ status: ContainerStatus; detail: string | null }> {
    const body = await get<{ status_code?: ContainerStatus; status?: string }>("container status", containerId, {
      fields: "status_code,status",
    });
    return { status: body.status_code ?? "IN_PROGRESS", detail: body.status ?? null };
  }

  /** The irreversible step. Its caller must treat a network failure as "may have been published". */
  async function publish(containerId: string): Promise<string> {
    const body = await post<{ id?: string }>("publish", `${userId}/media_publish`, { creation_id: containerId });
    if (!body.id) throw new InstagramError("api_error", "Instagram published nothing", "unknown");
    return body.id;
  }

  async function permalink(mediaId: string): Promise<string | null> {
    const body = await get<{ permalink?: string }>("permalink", mediaId, { fields: "permalink" });
    return body.permalink ?? null;
  }

  /**
   * Another professional account's public profile and recent posts. Documented
   * for Facebook Login only; `unsupported` when this token cannot use it.
   */
  async function businessDiscovery(username: string): Promise<SocialCompetitorSnapshot> {
    const fields = `business_discovery.username(${username}){username,name,biography,followers_count,media_count,media.limit(24){timestamp,like_count,comments_count}}`;
    let body: {
      business_discovery?: {
        name?: string;
        biography?: string;
        followers_count?: number;
        media_count?: number;
        media?: { data?: Array<{ timestamp?: string; like_count?: number; comments_count?: number }> };
      };
    };
    try {
      body = await get("business discovery", userId, { fields });
    } catch (err) {
      if (err instanceof InstagramError && (err.code === "invalid_parameter" || err.code === "permission_denied")) {
        const notFound = /cannot be found|not.*business|does not exist/i.test(err.message);
        throw new InstagramError(notFound ? "not_found" : "unsupported", err.message, "rejected");
      }
      throw err;
    }
    const bd = body.business_discovery;
    if (!bd) throw new InstagramError("unsupported", "Business Discovery returned nothing", "rejected");
    const recent = (bd.media?.data ?? []).map((m) => ({
      at: m.timestamp ?? null,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
    }));
    const interactions = recent.map((r) => (r.likes ?? 0) + (r.comments ?? 0));
    return {
      source: "business_discovery",
      name: bd.name ?? null,
      bio: bd.biography ?? null,
      followers: bd.followers_count ?? null,
      mediaCount: bd.media_count ?? null,
      recent,
      postsPerWeek: postsPerWeek(recent.map((r) => r.at)),
      avgViews: null,
      avgInteractions: interactions.length ? Math.round(interactions.reduce((a, b) => a + b, 0) / interactions.length) : null,
    };
  }

  return {
    profile,
    media,
    mediaInsights,
    accountInsights,
    publishingLimit,
    createContainer,
    containerStatus,
    publish,
    permalink,
    businessDiscovery,
  };
}

export type InstagramClient = ReturnType<typeof instagramClient>;

/** Posts per week over the span the timestamps cover (at least one week); null with fewer than two. */
export function postsPerWeek(timestamps: Array<string | null>): number | null {
  const times = timestamps.map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const weeks = Math.max(1, (times.at(-1)! - times[0]!) / (7 * 86_400_000));
  return Math.round((times.length / weeks) * 10) / 10;
}

/**
 * The Instagram account as a Connector for the fix executor. It writes
 * nothing: the API offers no way to change the name, biography or website, so
 * a proposal for them fails as unsupported rather than pretending.
 */
export function instagramAccount(creds: { accessToken: string; userId?: string }): import("./types.js").Connector {
  const capabilities = async () => ({
    writableFields: [],
    supportedActions: [],
    notes: ["The Instagram API cannot change the profile name, biography or website; copy the suggested text into the Instagram app."],
  });
  return {
    kind: "INSTAGRAM",
    capabilities,
    async check() {
      try {
        const p = await instagramClient(creds.accessToken, creds.userId).profile();
        return { ok: true, message: `Connected to @${p.username}.`, capabilities: await capabilities() };
      } catch (err) {
        const e = err as InstagramError;
        return { ok: false, reason: e.code ?? "network_error", message: e.message, capabilities: await capabilities() };
      }
    },
  };
}
