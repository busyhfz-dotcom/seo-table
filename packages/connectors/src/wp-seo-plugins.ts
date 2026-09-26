/**
 * Writing SEO fields through the SEO plugin a WordPress site already runs,
 * using that plugin's own REST API — no bridge plugin, nothing installed.
 *
 * Request shapes follow each plugin's source:
 *   - Rank Math: POST rankmath/v1/updateMeta {objectID, objectType:"post", meta}
 *     (includes/rest/class-shared.php). An empty value deletes the meta key.
 *     Permission: edit_post on that post.
 *   - SEOPress (6.8+ accepts application passwords): PUT
 *     seopress/v1/posts/{id}/title-description-metas {title, description} and
 *     PUT seopress/v1/posts/{id}/meta-robot-settings {_seopress_robots_*}.
 *     "yes" in _seopress_robots_index / _follow / … means noindex / nofollow / ….
 *     Both routes replace every field they carry, so the untouched ones are
 *     read first (GET seopress/v1/posts/{id}) and sent back unchanged.
 *   - AIOSEO: POST aioseo/v1/post {id, …} (app/Common/Api/PostsTerms.php).
 *     updatePosts() nulls title, description, keywords and the Open Graph and
 *     Twitter texts whenever they are absent, so the current values are read
 *     first (GET aioseo/v1/post?postId=) and sent back with the change.
 *     Permission: edit_post plus AIOSEO's aioseo_page_general_settings.
 *   - Yoast SEO exposes no write API (its REST routes only read), so a Yoast
 *     site gets no plugin writer here; the capability notes say so.
 *
 * What a plugin stores is often a template (Rank Math's "%title% %sep%
 * %sitename%"), so the connector never trusts the stored form: it reads and
 * verifies the rendered page (see wordpress.ts).
 */
import { ConnectorError } from "./types.js";

export type SeoPluginKind = "rankmath" | "seopress" | "aioseo";

export type WpApi = <T>(path: string, init?: RequestInit) => Promise<{ status: number; data: T | null; text: string }>;

export type SeoPluginWriter = {
  kind: SeoPluginKind;
  label: string;
  fields: readonly string[];
  /** Store `value` for the post (null clears the plugin's own value, so its default applies). */
  set: (postId: number, field: string, value: string | null) => Promise<void>;
};

const SEO_FIELDS = ["title", "meta_description", "canonical", "meta_robots"] as const;

/** Namespaces that identify each plugin's REST API, in the order a writer is chosen. */
export const SEO_PLUGIN_NAMESPACES: Record<SeoPluginKind | "yoast", string> = {
  rankmath: "rankmath/v1",
  seopress: "seopress/v1",
  aioseo: "aioseo/v1",
  yoast: "yoast/v1",
};

export const SEO_PLUGIN_LABELS: Record<SeoPluginKind | "yoast", string> = {
  rankmath: "Rank Math",
  seopress: "SEOPress",
  aioseo: "All in One SEO",
  yoast: "Yoast SEO",
};

/** Directives parsed from a robots value, lower-cased, in order. */
export function robotsDirectives(value: string | null): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

function fail(res: { status: number; text: string }, what: string): never {
  throw new ConnectorError(`http_${res.status}`, `${what} failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
}

export function seoPluginWriter(kind: SeoPluginKind, api: WpApi): SeoPluginWriter {
  switch (kind) {
    case "rankmath":
      return rankMath(api);
    case "seopress":
      return seoPress(api);
    case "aioseo":
      return aioseo(api);
  }
}

function rankMath(api: WpApi): SeoPluginWriter {
  const META: Record<string, string> = {
    title: "rank_math_title",
    meta_description: "rank_math_description",
    canonical: "rank_math_canonical_url",
    meta_robots: "rank_math_robots",
  };
  return {
    kind: "rankmath",
    label: SEO_PLUGIN_LABELS.rankmath,
    fields: SEO_FIELDS,
    async set(postId, field, value) {
      const key = META[field];
      if (!key) throw new ConnectorError("unsupported_field", `Rank Math has no "${field}" field.`);
      // Rank Math keeps robots as a list of directives; an empty value deletes the key.
      const stored = field === "meta_robots" ? (value === null ? "" : robotsDirectives(value)) : (value ?? "");
      const res = await api<unknown>("rankmath/v1/updateMeta", {
        method: "POST",
        body: JSON.stringify({ objectID: postId, objectType: "post", meta: { [key]: stored } }),
      });
      if (res.status >= 400) fail(res, "Rank Math updateMeta");
    },
  };
}

function seoPress(api: WpApi): SeoPluginWriter {
  const ROBOT_FLAGS: Record<string, string> = {
    noindex: "_seopress_robots_index",
    nofollow: "_seopress_robots_follow",
    noarchive: "_seopress_robots_archive",
    nosnippet: "_seopress_robots_snippet",
    noimageindex: "_seopress_robots_imageindex",
  };
  const ROBOT_KEYS = [...Object.values(ROBOT_FLAGS), "_seopress_robots_canonical", "_seopress_robots_primary_cat", "_seopress_robots_breadcrumbs"];

  async function current(postId: number): Promise<Record<string, unknown>> {
    const res = await api<Record<string, unknown>>(`seopress/v1/posts/${postId}`);
    if (res.status >= 400 || !res.data || typeof res.data !== "object") fail(res, "Reading the SEOPress fields");
    // Some versions wrap the metas; the keys are the same either way.
    const data = res.data as Record<string, unknown>;
    const inner = (data.meta ?? data.metas ?? data.data) as Record<string, unknown> | undefined;
    return { ...(inner && typeof inner === "object" ? inner : {}), ...data };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");

  return {
    kind: "seopress",
    label: SEO_PLUGIN_LABELS.seopress,
    fields: SEO_FIELDS,
    async set(postId, field, value) {
      const now = await current(postId);
      if (field === "title" || field === "meta_description") {
        const body = {
          title: field === "title" ? (value ?? "") : str(now._seopress_titles_title ?? now.title),
          description: field === "meta_description" ? (value ?? "") : str(now._seopress_titles_desc ?? now.description),
        };
        const res = await api<unknown>(`seopress/v1/posts/${postId}/title-description-metas`, { method: "PUT", body: JSON.stringify(body) });
        if (res.status >= 400) fail(res, "SEOPress title-description-metas");
        return;
      }
      const body: Record<string, string> = Object.fromEntries(ROBOT_KEYS.map((k) => [k, str(now[k])]));
      if (field === "canonical") body._seopress_robots_canonical = value ?? "";
      else if (field === "meta_robots") {
        const wanted = new Set(robotsDirectives(value));
        for (const [directive, key] of Object.entries(ROBOT_FLAGS)) {
          body[key] = wanted.has(directive) || (wanted.has("none") && ["noindex", "nofollow"].includes(directive)) ? "yes" : "";
        }
      } else throw new ConnectorError("unsupported_field", `SEOPress has no "${field}" field.`);
      const res = await api<unknown>(`seopress/v1/posts/${postId}/meta-robot-settings`, { method: "PUT", body: JSON.stringify(body) });
      if (res.status >= 400) fail(res, "SEOPress meta-robot-settings");
    },
  };
}

function aioseo(api: WpApi): SeoPluginWriter {
  // Always nulled by updatePosts() when missing, so always sent.
  const KEPT = ["title", "description", "keywords", "og_title", "og_description", "og_article_section", "og_article_tags", "twitter_title", "twitter_description"];
  const ROBOT_FLAGS = ["noindex", "nofollow", "noarchive", "nosnippet", "noimageindex"];

  return {
    kind: "aioseo",
    label: SEO_PLUGIN_LABELS.aioseo,
    fields: SEO_FIELDS,
    async set(postId, field, value) {
      const res = await api<{ success?: boolean; data?: { currentPost?: Record<string, unknown> } }>(`aioseo/v1/post?postId=${postId}`);
      const post = res.data?.data?.currentPost;
      if (res.status >= 400 || !post) fail(res, "Reading the All in One SEO fields");
      const body: Record<string, unknown> = { id: postId };
      for (const key of KEPT) body[key] = post[key] ?? null;
      switch (field) {
        case "title":
          body.title = value;
          break;
        case "meta_description":
          body.description = value;
          break;
        case "canonical":
          body.canonicalUrl = value ?? "";
          break;
        case "meta_robots": {
          // null returns the post to the site-wide robots defaults.
          const wanted = new Set(robotsDirectives(value));
          body.default = value === null;
          for (const flag of ROBOT_FLAGS) body[flag] = wanted.has(flag) || (wanted.has("none") && (flag === "noindex" || flag === "nofollow"));
          break;
        }
        default:
          throw new ConnectorError("unsupported_field", `All in One SEO has no "${field}" field.`);
      }
      const saved = await api<{ success?: boolean }>("aioseo/v1/post", { method: "POST", body: JSON.stringify(body) });
      if (saved.status >= 400 || saved.data?.success === false) fail(saved, "All in One SEO post update");
    },
  };
}
