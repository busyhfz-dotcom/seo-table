/**
 * WordPress connector — real REST API, Application Password auth.
 *
 * What WordPress can and cannot do is probed rather than assumed:
 *
 *  - Post/page title and content: core `wp/v2`, always writable.
 *  - Image alt text: core `wp/v2/media` exposes `alt_text`, always writable.
 *  - Meta description and SEO title: WordPress core has no such field. Yoast and
 *    Rank Math store them in post meta that is not writable over REST unless the
 *    site registers it. So we probe for a companion namespace and, failing that,
 *    report the field as unsupported with an actionable message instead of
 *    pretending the write succeeded.
 *  - Redirects: core has no redirect table. Probed for `redirection/v1` or our
 *    own mu-plugin namespace.
 *
 * The optional mu-plugin that closes those gaps ships in
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

type WpRoot = { namespaces?: string[]; name?: string; description?: string };
type WpPost = {
  id: number;
  link: string;
  title?: { rendered?: string; raw?: string };
  type?: string;
  meta?: Record<string, unknown>;
};
type WpMedia = { id: number; source_url: string; alt_text?: string };

export function wordpress(creds: WordPressCredentials): Connector {
  const base = creds.siteUrl.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString("base64")}`;
  const headers = { authorization: auth, "content-type": "application/json", accept: "application/json" };

  let capCache: ConnectorCapabilities | null = null;

  async function root(): Promise<WpRoot> {
    const { status, data } = await httpJson<WpRoot>(`${base}/wp-json/`, { headers });
    if (status === 404) {
      throw new ConnectorError("rest_api_disabled", "The site does not expose the WordPress REST API at /wp-json/");
    }
    if (status >= 400 || !data) {
      throw new ConnectorError("rest_api_unreachable", `WordPress REST API returned HTTP ${status}`);
    }
    return data;
  }

  async function capabilities(): Promise<ConnectorCapabilities> {
    if (capCache) return capCache;
    const info = await root();
    const ns = new Set(info.namespaces ?? []);
    const hasBridge = ns.has(BRIDGE_NS);
    const hasYoast = ns.has("yoast/v1");
    const hasRankMath = ns.has("rankmath/v1");
    const hasRedirection = ns.has("redirection/v1");

    const writableFields = ["post_title", "img.alt"];
    const supportedActions: FixAction[] = ["ALT_TEXT"];
    const notes: string[] = [];

    if (hasBridge) {
      writableFields.push("title", "meta_description", "canonical", "meta_robots", "redirect");
      supportedActions.push("TITLE_REWRITE", "META_REWRITE", "CANONICAL_FIX", "ROBOTS_FIX", "REDIRECT");
      notes.push("SEO Table bridge plugin detected: SEO title, meta description, canonical, robots and redirects are writable.");
    } else {
      notes.push(
        "No SEO Table bridge plugin found. SEO title, meta description, canonical and robots are not writable over the core REST API.",
      );
      if (hasYoast) notes.push("Yoast detected (read-only over REST). Install the bridge plugin to let fixes write its fields.");
      if (hasRankMath) notes.push("Rank Math detected (read-only over REST). Install the bridge plugin to let fixes write its fields.");
      // The post title is writable without any plugin, but it is what visitors
      // see, so it stays SENSITIVE in the policy.
      supportedActions.push("TITLE_REWRITE");
      writableFields.push("title:post_title_fallback");
    }

    if (hasRedirection && !hasBridge) {
      writableFields.push("redirect");
      supportedActions.push("REDIRECT");
      notes.push("Redirection plugin detected: redirects can be created (still requires human approval).");
    } else if (!hasRedirection && !hasBridge) {
      notes.push("No redirect plugin found, so redirect fixes cannot be executed on this site.");
    }

    capCache = { writableFields, supportedActions, notes };
    return capCache;
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
      const me = await httpJson<Me>(`${base}/wp-json/wp/v2/users/me?context=edit`, { headers });
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
      const posts = await httpJson<unknown[] | WpErr>(
        `${base}/wp-json/wp/v2/posts?context=edit&per_page=1&_fields=id`,
        { headers },
      );
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

  /** Resolve a public URL to the post or page behind it. */
  async function resolvePost(url: string): Promise<WpPost> {
    // WordPress ships an endpoint for exactly this lookup.
    const { status, data } = await httpJson<{ id?: number; type?: string }>(
      `${base}/wp-json/wp/v2/search?search=${encodeURIComponent(url)}&per_page=1`,
      { headers },
    );
    const first = Array.isArray(data) ? (data[0] as { id?: number; subtype?: string; type?: string }) : undefined;
    if (status < 400 && first?.id) {
      const subtype = first.subtype ?? "posts";
      const collection = subtype === "page" ? "pages" : subtype === "post" ? "posts" : `${subtype}s`;
      const res = await httpJson<WpPost>(`${base}/wp-json/wp/v2/${collection}/${first.id}?context=edit`, { headers });
      if (res.status < 400 && res.data) return { ...res.data, type: collection };
    }

    // Fall back to matching by slug across posts and pages.
    const slug = lastSegment(url);
    for (const collection of ["pages", "posts"]) {
      const res = await httpJson<WpPost[]>(
        `${base}/wp-json/wp/v2/${collection}?slug=${encodeURIComponent(slug)}&context=edit&per_page=1`,
        { headers },
      );
      const hit = res.data?.[0];
      if (hit?.id) return { ...hit, type: collection };
    }
    throw new ConnectorError("post_not_found", `No WordPress post or page matches ${url}`);
  }

  async function resolveMedia(src: string): Promise<WpMedia> {
    const file = lastSegment(src).replace(/\.[a-z0-9]+$/i, "");
    const res = await httpJson<WpMedia[]>(
      `${base}/wp-json/wp/v2/media?search=${encodeURIComponent(file)}&per_page=5&context=edit`,
      { headers },
    );
    const hit = res.data?.find((m) => m.source_url?.includes(file)) ?? res.data?.[0];
    if (!hit?.id) throw new ConnectorError("media_not_found", `No media item matches ${src}`);
    return hit;
  }

  async function read(req: Pick<WriteRequest, "url" | "field" | "selector">): Promise<string | null> {
    const caps = await capabilities();
    if (req.field === "img.alt" && req.selector) {
      const media = await resolveMedia(req.selector);
      return media.alt_text ?? null;
    }
    if (caps.writableFields.includes(req.field) && caps.writableFields.includes("meta_description")) {
      const post = await resolvePost(req.url);
      const res = await httpJson<Record<string, string | null>>(
        `${base}/wp-json/${BRIDGE_NS}/seo?post=${post.id}`,
        { headers },
      );
      return res.data?.[req.field] ?? null;
    }
    if (req.field === "title" || req.field === "post_title") {
      const post = await resolvePost(req.url);
      return post.title?.raw ?? post.title?.rendered ?? null;
    }
    return null;
  }

  async function write(req: WriteRequest): Promise<WriteResult> {
    const fail = (code: string, error: string): WriteResult => ({
      url: req.url,
      field: req.field,
      ok: false,
      code,
      error,
    });

    try {
      const caps = await capabilities();
      const viaBridge = caps.notes.some((n) => n.startsWith("SEO Table bridge plugin detected"));

      if (req.field === "img.alt") {
        if (!req.selector) return fail("missing_selector", "An alt-text change must name the image.");
        const media = await resolveMedia(req.selector);
        const previous = media.alt_text ?? null;
        const res = await httpJson<WpMedia>(`${base}/wp-json/wp/v2/media/${media.id}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ alt_text: req.after }),
        });
        if (res.status >= 400) return fail(`http_${res.status}`, res.text.slice(0, 300));
        return { url: req.url, field: req.field, ok: true, applied: res.data?.alt_text ?? req.after, previous };
      }

      if (["meta_description", "canonical", "meta_robots", "redirect"].includes(req.field) || (req.field === "title" && viaBridge)) {
        if (!viaBridge) {
          return fail(
            "unsupported_field",
            `WordPress cannot write "${req.field}" over the core REST API. Install the SEO Table bridge plugin (packages/connectors/wordpress-plugin) to enable it.`,
          );
        }
        const post = req.field === "redirect" ? null : await resolvePost(req.url);
        const body = post
          ? { post: post.id, field: req.field, value: req.after }
          : { field: "redirect", from: req.url, to: req.after, status: 301 };
        const res = await httpJson<{ ok?: boolean; previous?: string | null; value?: string | null }>(
          `${base}/wp-json/${BRIDGE_NS}/seo`,
          { method: "POST", headers, body: JSON.stringify(body) },
        );
        if (res.status >= 400 || !res.data?.ok) return fail(`http_${res.status}`, res.text.slice(0, 300));
        return {
          url: req.url,
          field: req.field,
          ok: true,
          applied: res.data.value ?? req.after,
          previous: res.data.previous ?? req.before,
        };
      }

      if (req.field === "title" || req.field === "post_title") {
        const post = await resolvePost(req.url);
        const previous = post.title?.raw ?? post.title?.rendered ?? null;
        const res = await httpJson<WpPost>(`${base}/wp-json/wp/v2/${post.type ?? "posts"}/${post.id}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: req.after }),
        });
        if (res.status >= 400) return fail(`http_${res.status}`, res.text.slice(0, 300));
        return {
          url: req.url,
          field: req.field,
          ok: true,
          applied: res.data?.title?.raw ?? req.after,
          previous,
        };
      }

      return fail("unsupported_field", `The WordPress connector cannot write "${req.field}".`);
    } catch (err) {
      if (err instanceof ConnectorError) return fail(err.code, err.message);
      return fail("network_error", (err as Error).message);
    }
  }

  return { kind: "WORDPRESS", check, capabilities, write, read };
}

function lastSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] ?? "");
  } catch {
    return url;
  }
}
