/**
 * WordPress connector — real REST API, Application Password auth.
 *
 * What WordPress can and cannot do is probed rather than assumed:
 *
 *  - Image alt text: core REST, always writable. An image embedded in post
 *    content renders the alt written in that HTML, so the alt is changed there;
 *    only an image outside the content (a featured image) uses the media item's
 *    `alt_text`.
 *  - SEO title, meta description, canonical, robots: core has no such fields.
 *    Yoast and Rank Math keep them in post meta that REST cannot write, so they
 *    need the bridge plugin; without it they are reported as unsupported rather
 *    than faked. The visible post title is never used as a stand-in.
 *  - Redirects: core has no redirect table; only the bridge's is supported.
 *
 * Every write targets the post whose permalink IS the requested URL: the post
 * is resolved by path (never by full-text search) and its link is compared with
 * the URL before anything is written.
 *
 * The mu-plugin that closes those gaps ships in
 * `packages/connectors/wordpress-plugin/seo-table-bridge.php`.
 */
import type { FixAction } from "@seo/db";
import {
  ConnectorError,
  httpJson,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorHealth,
  type WriteRequest,
  type WriteResult,
} from "./types.js";

export type WordPressCredentials = {
  siteUrl: string;
  username: string;
  /** WordPress Application Password. Stored sealed; never logged. */
  applicationPassword: string;
};

const BRIDGE_NS = "seo-table/v1";
/** The oldest bridge with path resolution, deletes and the hardened permission checks. */
const MIN_BRIDGE_VERSION = [0, 5, 0] as const;
const BRIDGE_POST_FIELDS = ["title", "meta_description", "canonical", "meta_robots"];

type WpRoot = { namespaces?: string[]; name?: string; description?: string };
type WpPost = {
  id: number;
  link: string;
  title?: { rendered?: string; raw?: string };
  content?: { raw?: string; rendered?: string };
};
/** A post together with the REST route it lives under (pages, posts, a custom type's rest_base). */
type ResolvedPost = { id: number; link: string; restNamespace: string; restBase: string };
type WpType = { slug?: string; rest_base?: string; rest_namespace?: string };
type WpMedia = {
  id: number;
  source_url: string;
  alt_text?: string;
  media_details?: { sizes?: Record<string, { source_url?: string }> };
};
type BridgeInfo = { version?: string };

/** Post types that never own a public permalink worth fixing. */
const NON_CONTENT_TYPES = new Set(["attachment", "nav_menu_item", "revision", "custom_css", "customize_changeset", "oembed_cache", "user_request"]);

export function wordpress(creds: WordPressCredentials): Connector {
  const base = creds.siteUrl.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString("base64")}`;
  const headers = { authorization: auth, "content-type": "application/json", accept: "application/json" };

  let capCache: (ConnectorCapabilities & { bridge: boolean }) | null = null;

  const api = <T>(path: string, init: RequestInit = {}) =>
    httpJson<T>(`${base}/wp-json/${path}`, { headers, ...init });

  async function root(): Promise<WpRoot> {
    const { status, data } = await api<WpRoot>("");
    if (status === 404) {
      throw new ConnectorError("rest_api_disabled", "The site does not expose the WordPress REST API at /wp-json/");
    }
    if (status >= 400 || !data) {
      throw new ConnectorError("rest_api_unreachable", `WordPress REST API returned HTTP ${status}`);
    }
    return data;
  }

  async function probeCapabilities(): Promise<ConnectorCapabilities & { bridge: boolean }> {
    if (capCache) return capCache;
    const info = await root();
    const ns = new Set(info.namespaces ?? []);
    const writableFields = ["img.alt"];
    const supportedActions: FixAction[] = ["ALT_TEXT"];
    const notes: string[] = [];

    let bridge = false;
    if (ns.has(BRIDGE_NS)) {
      const probe = await api<BridgeInfo>(`${BRIDGE_NS}/info`);
      const version = probe.status === 200 ? probe.data?.version : undefined;
      if (version && versionAtLeast(version, MIN_BRIDGE_VERSION)) {
        bridge = true;
        writableFields.push(...BRIDGE_POST_FIELDS, "redirect");
        supportedActions.push("TITLE_REWRITE", "META_REWRITE", "CANONICAL_FIX", "ROBOTS_FIX", "REDIRECT");
        notes.push(`SEO Table bridge plugin ${version} detected: SEO title, meta description, canonical, robots and redirects are writable.`);
      } else {
        notes.push(
          `The SEO Table bridge plugin on this site is outdated (${version ?? "before 0.5.0"}). Update it to ${MIN_BRIDGE_VERSION.join(".")} or later to enable SEO fields and redirects.`,
        );
      }
    }
    if (!bridge) {
      notes.push(
        "Without the SEO Table bridge plugin, SEO title, meta description, canonical, robots and redirects are not writable over the WordPress REST API.",
      );
      if (ns.has("yoast/v1")) notes.push("Yoast detected (read-only over REST). Install the bridge plugin to let fixes write its fields.");
      if (ns.has("rankmath/v1")) notes.push("Rank Math detected (read-only over REST). Install the bridge plugin to let fixes write its fields.");
      if (ns.has("redirection/v1")) {
        notes.push("The Redirection plugin is detected, but SEO Table writes redirects only through its bridge plugin.");
      }
    }

    capCache = { writableFields, supportedActions, notes, bridge };
    return capCache;
  }

  async function capabilities(): Promise<ConnectorCapabilities> {
    const { writableFields, supportedActions, notes } = await probeCapabilities();
    return { writableFields, supportedActions, notes };
  }

  /**
   * Verify the credentials and that the account can edit content.
   *
   * Real sites put a lot between us and WordPress: security plugins that block
   * the users endpoint, hosts that strip the Authorization header, WAFs that
   * answer with an HTML page. Each gets its own reason code so the UI can say
   * what to change, instead of one generic "not allowed".
   */
  async function check(): Promise<ConnectorHealth & { capabilities?: ConnectorCapabilities }> {
    type WpErr = { code?: string; message?: string };
    type Me = { id?: number; name?: string; capabilities?: Record<string, boolean> } & WpErr;
    try {
      const me = await api<Me>("wp/v2/users/me?context=edit");
      if (me.status === 200 && me.data?.id) {
        const caps = await capabilities();
        if (me.data.capabilities?.edit_posts === false) {
          return {
            ok: false,
            reason: "insufficient_role",
            message: "The account cannot edit posts. Use an Editor or Administrator account.",
            capabilities: caps,
          };
        }
        return { ok: true, message: `Connected as ${me.data.name ?? creds.username}.`, capabilities: caps };
      }

      // The users endpoint is a favourite target of security plugins. What we
      // actually need is permission to edit posts, so ask for that directly.
      const posts = await api<unknown[] | WpErr>("wp/v2/posts?context=edit&per_page=1&_fields=id");
      if (posts.status === 200 && Array.isArray(posts.data)) {
        const caps = await capabilities();
        return {
          ok: true,
          message: `Connected as ${creds.username}.`,
          capabilities: {
            ...caps,
            notes: [
              ...caps.notes,
              "The site blocks the REST users endpoint (usually a security plugin); editing still works.",
            ],
          },
        };
      }

      return classify(posts.status === 404 ? me : posts);
    } catch (err) {
      // blocked_address and redirected arrive here as ConnectorError codes.
      if (err instanceof ConnectorError) return { ok: false, reason: err.code, message: err.message };
      return { ok: false, reason: "network_error", message: (err as Error).message };
    }

    function classify(res: { status: number; data: WpErr | unknown; text: string }): ConnectorHealth {
      const body = (res.data && !Array.isArray(res.data) ? (res.data as WpErr) : null) ?? null;
      const code = body?.code ?? "";
      const detail = code ? ` (${res.status} ${code})` : ` (HTTP ${res.status})`;
      if (res.status === 404) {
        return { ok: false, reason: "rest_api_disabled", message: `The WordPress REST API is not available at /wp-json/${detail}.` };
      }
      if (!body && res.status >= 400) {
        return {
          ok: false,
          reason: "firewall_blocked",
          message: `A firewall or security service answered instead of WordPress${detail}.`,
        };
      }
      if (["incorrect_password", "invalid_username", "invalid_email", "invalid_application_password"].includes(code)) {
        return { ok: false, reason: "invalid_credentials", message: `WordPress rejected the username or application password${detail}.` };
      }
      if (code === "application_passwords_disabled") {
        return { ok: false, reason: "app_passwords_disabled", message: `Application passwords are disabled on this site${detail}.` };
      }
      if (res.status === 401) {
        // WordPress treated the request as anonymous although we sent credentials:
        // the web server dropped the Authorization header on the way in.
        return {
          ok: false,
          reason: "credentials_not_received",
          message: `WordPress did not receive the login (the server drops the Authorization header)${detail}.`,
        };
      }
      if (res.status === 403 && ["rest_forbidden_context", "rest_cannot_edit", "rest_forbidden", "rest_cannot_view"].includes(code)) {
        return {
          ok: false,
          reason: "insufficient_role",
          message: `The account signed in but cannot edit posts. Use an Editor or Administrator account${detail}.`,
        };
      }
      if (res.status === 403) {
        return {
          ok: false,
          reason: "security_plugin_blocked",
          message: `A security plugin or host rule blocks the REST API for this account${detail}.`,
        };
      }
      return { ok: false, reason: "unexpected_response", message: `WordPress returned an unexpected response${detail}.` };
    }
  }

  // ---- resolving a URL to the post behind it --------------------------------

  /**
   * The post whose permalink is exactly `url`. Resolved by path — the bridge
   * asks WordPress itself (url_to_postid, which also knows the front page);
   * without it, by slug across pages, posts and custom types, keeping only the
   * candidate whose link matches the whole path. Anything else is refused.
   */
  async function resolvePost(url: string): Promise<ResolvedPost> {
    const target = comparableUrl(url);
    if (!target || !sameSite(url, base)) {
      throw new ConnectorError("url_outside_site", `${url} is not an address on ${base}`);
    }

    const { bridge } = await probeCapabilities();
    const post = bridge ? await resolveViaBridge(url) : await resolveBySlug(url, target);
    if (comparableUrl(post.link) !== target) {
      throw new ConnectorError(
        "post_url_mismatch",
        `WordPress resolved ${url} to post ${post.id}, whose address is ${post.link}; nothing was written.`,
        { postId: post.id, link: post.link },
      );
    }
    return post;
  }

  async function resolveViaBridge(url: string): Promise<ResolvedPost> {
    const res = await api<{ id?: number; link?: string; rest_base?: string; rest_namespace?: string }>(
      `${BRIDGE_NS}/resolve?url=${encodeURIComponent(url)}`,
    );
    if (res.status === 404) throw new ConnectorError("post_not_found", `No WordPress post or page has the address ${url}`);
    if (res.status >= 400 || !res.data?.id || !res.data.link || !res.data.rest_base) {
      throw new ConnectorError(`http_${res.status}`, `The bridge could not resolve ${url}: ${res.text.slice(0, 200)}`);
    }
    return {
      id: res.data.id,
      link: res.data.link,
      restBase: res.data.rest_base,
      restNamespace: res.data.rest_namespace ?? "wp/v2",
    };
  }

  async function resolveBySlug(url: string, target: string): Promise<ResolvedPost> {
    const slug = lastSegment(url);
    if (!slug) {
      // The front page has no slug in its URL; only WordPress knows which post it is.
      throw new ConnectorError(
        "home_page_unsupported",
        "The home page can only be edited with the SEO Table bridge plugin installed.",
      );
    }
    const routes: Array<{ restNamespace: string; restBase: string }> = [
      { restNamespace: "wp/v2", restBase: "pages" },
      { restNamespace: "wp/v2", restBase: "posts" },
      ...(await customTypeRoutes()),
    ];
    const matches: ResolvedPost[] = [];
    for (const route of routes) {
      const res = await api<WpPost[]>(
        `${route.restNamespace}/${route.restBase}?slug=${encodeURIComponent(slug)}&context=edit&per_page=100&_fields=id,link`,
      );
      if (res.status >= 400 || !Array.isArray(res.data)) continue;
      // Several pages can share a slug under different parents; the full link decides.
      for (const hit of res.data) {
        if (hit?.id && hit.link && comparableUrl(hit.link) === target) matches.push({ ...route, id: hit.id, link: hit.link });
      }
    }
    if (matches.length === 0) throw new ConnectorError("post_not_found", `No WordPress post or page has the address ${url}`);
    if (matches.length > 1) {
      throw new ConnectorError("post_ambiguous", `${matches.length} WordPress posts claim the address ${url}; nothing was written.`);
    }
    return matches[0]!;
  }

  async function customTypeRoutes(): Promise<Array<{ restNamespace: string; restBase: string }>> {
    const res = await api<Record<string, WpType>>("wp/v2/types");
    if (res.status >= 400 || !res.data || typeof res.data !== "object") return [];
    return Object.entries(res.data)
      .filter(([slug, t]) => t.rest_base && !["post", "page"].includes(slug) && !NON_CONTENT_TYPES.has(slug) && !slug.startsWith("wp_"))
      .map(([, t]) => ({ restNamespace: t.rest_namespace ?? "wp/v2", restBase: t.rest_base! }));
  }

  async function postContent(post: ResolvedPost): Promise<string> {
    const res = await api<WpPost>(`${post.restNamespace}/${post.restBase}/${post.id}?context=edit&_fields=id,link,content`);
    const raw = res.data?.content?.raw;
    if (res.status >= 400 || typeof raw !== "string") {
      throw new ConnectorError("content_unreadable", `Could not read the content of post ${post.id} (HTTP ${res.status})`);
    }
    return raw;
  }

  // ---- images ---------------------------------------------------------------

  type ImageLocation =
    | { kind: "content"; post: ResolvedPost; raw: string; alt: string | null }
    | { kind: "media"; media: WpMedia };

  /**
   * Where the alt the scanner saw actually comes from: the <img> tag in the
   * post's own content when it is there, otherwise the media item (featured
   * images and other theme-rendered images).
   */
  async function locateImage(pageUrl: string, src: string): Promise<ImageLocation> {
    let post: ResolvedPost | null = null;
    try {
      post = await resolvePost(pageUrl);
    } catch (err) {
      // An image on an archive or the home page without a bridge has no post
      // content to edit; its alt can only come from the media item.
      if (!(err instanceof ConnectorError) || !["post_not_found", "home_page_unsupported"].includes(err.code)) throw err;
    }
    if (post) {
      const raw = await postContent(post);
      const alts = imgTags(raw, src, base).map((t) => t.alt);
      if (alts.length > 0) {
        if (new Set(alts).size > 1) {
          throw new ConnectorError("image_ambiguous", `The image ${src} appears in post ${post.id} with different alt texts; edit it by hand.`);
        }
        return { kind: "content", post, raw, alt: alts[0]! };
      }
    }
    return { kind: "media", media: await resolveMedia(src) };
  }

  /** The one media item that owns `src` as its original or one of its sizes. Never a guess. */
  async function resolveMedia(src: string): Promise<WpMedia> {
    const wanted = comparableUrl(src);
    const stem = fileStem(src);
    if (!wanted || !stem) throw new ConnectorError("media_not_found", `No media item matches ${src}`);
    const res = await api<WpMedia[]>(`wp/v2/media?search=${encodeURIComponent(stem)}&per_page=100&context=edit`);
    if (res.status >= 400 || !Array.isArray(res.data)) {
      throw new ConnectorError(`http_${res.status}`, `Media lookup failed for ${src}`);
    }
    const hits = res.data.filter((m) =>
      [m.source_url, ...Object.values(m.media_details?.sizes ?? {}).map((s) => s.source_url)]
        .some((u) => u && comparableUrl(u) === wanted),
    );
    if (hits.length === 0) throw new ConnectorError("media_not_found", `No media item has the address ${src}`);
    if (hits.length > 1) throw new ConnectorError("media_ambiguous", `${hits.length} media items have the address ${src}`);
    return hits[0]!;
  }

  // ---- read / write ---------------------------------------------------------

  async function read(req: Pick<WriteRequest, "url" | "field" | "selector">): Promise<string | null> {
    const { bridge } = await probeCapabilities();
    if (req.field === "img.alt") {
      if (!req.selector) throw new ConnectorError("missing_selector", "An alt-text change must name the image.");
      const loc = await locateImage(req.url, req.selector);
      return loc.kind === "content" ? loc.alt : emptyToNull(loc.media.alt_text);
    }
    if (!bridge) throw new ConnectorError("unsupported_field", `WordPress cannot read "${req.field}" without the bridge plugin.`);
    if (req.field === "redirect") {
      const res = await api<{ to?: string | null }>(`${BRIDGE_NS}/redirects?from=${encodeURIComponent(req.url)}`);
      if (res.status >= 400 || !res.data) throw new ConnectorError(`http_${res.status}`, res.text.slice(0, 300));
      return emptyToNull(res.data.to);
    }
    if (BRIDGE_POST_FIELDS.includes(req.field)) {
      const post = await resolvePost(req.url);
      const res = await api<Record<string, string | null>>(`${BRIDGE_NS}/seo?post=${post.id}`);
      if (res.status >= 400 || !res.data) throw new ConnectorError(`http_${res.status}`, res.text.slice(0, 300));
      return emptyToNull(res.data[req.field]);
    }
    throw new ConnectorError("unsupported_field", `The WordPress connector cannot read "${req.field}".`);
  }

  async function write(req: WriteRequest): Promise<WriteResult> {
    const fail = (code: string, error: string): WriteResult => ({ url: req.url, field: req.field, ok: false, code, error });
    const done = (applied: string | null, previous: string | null): WriteResult => ({
      url: req.url,
      field: req.field,
      ok: true,
      applied,
      previous,
    });

    try {
      const { bridge } = await probeCapabilities();

      if (req.field === "img.alt") {
        if (!req.selector) return fail("missing_selector", "An alt-text change must name the image.");
        const loc = await locateImage(req.url, req.selector);
        if (loc.kind === "content") {
          const content = setImgAlt(loc.raw, req.selector, base, req.after);
          const res = await api<WpPost>(`${loc.post.restNamespace}/${loc.post.restBase}/${loc.post.id}`, {
            method: "POST",
            body: JSON.stringify({ content }),
          });
          if (res.status >= 400) return fail(`http_${res.status}`, res.text.slice(0, 300));
          return done(req.after, loc.alt);
        }
        const res = await api<WpMedia>(`wp/v2/media/${loc.media.id}`, {
          method: "POST",
          body: JSON.stringify({ alt_text: req.after ?? "" }),
        });
        if (res.status >= 400) return fail(`http_${res.status}`, res.text.slice(0, 300));
        return done(emptyToNull(res.data?.alt_text ?? req.after), emptyToNull(loc.media.alt_text));
      }

      if (!bridge || (req.field !== "redirect" && !BRIDGE_POST_FIELDS.includes(req.field))) {
        return fail(
          "unsupported_field",
          `WordPress cannot write "${req.field}" over the core REST API. Install the SEO Table bridge plugin (packages/connectors/wordpress-plugin) to enable it.`,
        );
      }

      type BridgeWrite = { ok?: boolean; previous?: string | null; value?: string | null };
      let res;
      if (req.field === "redirect") {
        res =
          req.after === null
            ? await api<BridgeWrite>(`${BRIDGE_NS}/redirects?from=${encodeURIComponent(req.url)}`, { method: "DELETE" })
            : await api<BridgeWrite>(`${BRIDGE_NS}/redirects`, {
                method: "POST",
                body: JSON.stringify({ from: req.url, to: req.after, status: 301 }),
              });
      } else {
        const post = await resolvePost(req.url);
        res =
          req.after === null
            ? await api<BridgeWrite>(`${BRIDGE_NS}/seo?post=${post.id}&field=${encodeURIComponent(req.field)}`, {
                method: "DELETE",
              })
            : await api<BridgeWrite>(`${BRIDGE_NS}/seo`, {
                method: "POST",
                body: JSON.stringify({ post: post.id, field: req.field, value: req.after }),
              });
      }
      if (res.status >= 400 || !res.data?.ok) return fail(`http_${res.status}`, res.text.slice(0, 300));
      return done(emptyToNull(res.data.value), emptyToNull(res.data.previous));
    } catch (err) {
      if (err instanceof ConnectorError) return fail(err.code, err.message);
      return fail("network_error", (err as Error).message);
    }
  }

  return { kind: "WORDPRESS", check, capabilities, write, read };
}

// ---- helpers ------------------------------------------------------------------

function emptyToNull(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === "" ? null : v;
}

function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    if (a !== min[i]) return a > min[i]!;
  }
  return true;
}

/**
 * A URL reduced to what identifies a WordPress resource: the percent-decoded
 * path without a trailing slash, plus the query string with its parameters
 * sorted (plain permalinks are `/?p=123`). Scheme, host and fragment are left
 * out; the host is checked separately.
 */
export function comparableUrl(url: string, relativeTo?: string): string | null {
  let u: URL;
  try {
    u = new URL(url, relativeTo);
  } catch {
    return null;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* a malformed escape is compared as written */
  }
  path = path.replace(/\/+$/, "") || "/";
  const params = [...u.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return path + query;
}

/** Same site, allowing for the www/non-www and http/https variants of one install. */
function sameSite(url: string, base: string): boolean {
  try {
    const host = (h: string) => h.toLowerCase().replace(/^www\./, "");
    return host(new URL(url).host) === host(new URL(base).host);
  } catch {
    return false;
  }
}

function lastSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] ?? "");
  } catch {
    return "";
  }
}

/** The media title WordPress derives from a file: no extension, no -WxH size, no -scaled. */
function fileStem(src: string): string {
  return lastSegment(src)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/-\d+x\d+$/, "")
    .replace(/-scaled$/, "");
}

const IMG_TAG = /<img\b[^>]*>/gi;
const ATTR = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;|&#0*34;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(tag: string, name: string): string | null {
  const m = ATTR(name).exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** The <img> tags in `html` whose src is `src`, with their current alt (null when absent). */
export function imgTags(html: string, src: string, base: string): Array<{ tag: string; alt: string | null }> {
  const wanted = comparableUrl(src, base);
  const out: Array<{ tag: string; alt: string | null }> = [];
  for (const tag of html.match(IMG_TAG) ?? []) {
    const tagSrc = attr(tag, "src");
    if (tagSrc && comparableUrl(tagSrc, base) === wanted) out.push({ tag, alt: attr(tag, "alt") });
  }
  return out;
}

/**
 * Set (or with null, remove) the alt attribute of every <img> whose src is
 * `src`, leaving every other byte of the content exactly as it was.
 */
export function setImgAlt(html: string, src: string, base: string, alt: string | null): string {
  const wanted = comparableUrl(src, base);
  return html.replace(IMG_TAG, (tag) => {
    const tagSrc = attr(tag, "src");
    if (!tagSrc || comparableUrl(tagSrc, base) !== wanted) return tag;
    const stripped = tag.replace(ATTR("alt"), "");
    if (alt === null) return stripped;
    return stripped.replace(/^<img\b/i, `<img alt="${escapeAttr(alt)}"`);
  });
}
