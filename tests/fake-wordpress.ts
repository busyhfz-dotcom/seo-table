/**
 * A WordPress REST API double, over real HTTP.
 *
 * It implements the endpoints the connector calls, with WordPress's own shapes
 * and status codes, and it enforces Basic auth with an application password —
 * so the connector's auth, capability probing, URL resolution, read-before-write,
 * write and rollback are all exercised against a server, not a stubbed function.
 *
 * `bridge` toggles the SEO Table bridge plugin's namespace, which is what decides
 * whether SEO fields and redirects are writable. Like the real plugin, the bridge
 * keys redirects by decoded path and deletes a field written as null.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export type FakeMedia = {
  id: number;
  source_url: string;
  alt_text: string;
  media_details?: { sizes: Record<string, { source_url: string }> };
};

export type FakePost = {
  id: number;
  slug: string;
  /** Path of the permalink, e.g. "/about/team/". */
  path: string;
  /** rest_base of the post type. */
  restBase: "pages" | "posts" | "products";
  title: string;
  content: string;
};

export type FakeWp = {
  baseUrl: string;
  posts: FakePost[];
  media: Map<number, FakeMedia>;
  seo: Map<number, Record<string, string | null>>;
  /** Bridge redirects, keyed by decoded path ("/legacy"). */
  redirects: Map<string, string>;
  writes: Array<{ method: string; path: string; body: unknown }>;
  /** Knobs a test turns while the server runs. */
  knobs: {
    /** Make every bridge SEO read fail with HTTP 500. */
    failSeoReads: boolean;
    /** Delay each write by this many ms, to widen race windows. */
    writeDelayMs: number;
    /** Make the bridge resolve a path to a different post id (a misbehaving resolver). */
    misresolve: Map<string, number>;
  };
  close: () => Promise<void>;
};

const USER = "seo-bot";
const PASS = "abcd efgh ijkl mnop qrst uvwx";

export const FAKE_WP_CREDENTIALS = { username: USER, applicationPassword: PASS };

/**
 * `mode` reproduces what real sites put in front of WordPress:
 *  - blockUsers: a security plugin that 403s /wp/v2/users (editing still works)
 *  - stripAuth:  a host that drops the Authorization header
 *  - waf:        a firewall answering with an HTML page
 *  - subscriber: a valid login whose role cannot edit posts
 *  - moved:      the REST root answers with a redirect to another host
 */
export type FakeWpMode = "normal" | "blockUsers" | "stripAuth" | "waf" | "subscriber" | "moved";

export async function startFakeWordPress(
  opts: { bridge?: boolean; bridgeVersion?: string; mode?: FakeWpMode; frontPageId?: number } = {},
): Promise<FakeWp> {
  const mode = opts.mode ?? "normal";
  let baseUrl = "";
  const media = new Map<number, FakeMedia>();
  const seo = new Map<number, Record<string, string | null>>();
  const redirects = new Map<string, string>();
  const writes: FakeWp["writes"] = [];
  const knobs: FakeWp["knobs"] = { failSeoReads: false, writeDelayMs: 0, misresolve: new Map() };

  const posts: FakePost[] = [
    { id: 11, slug: "1204", path: "/p/1204/", restBase: "pages", title: "کتانی ۱۲۰۴", content: "<p>کتانی</p>" },
    { id: 12, slug: "1205", path: "/p/1205/", restBase: "pages", title: "کتانی ۱۲۰۵", content: "<p>کتانی</p>" },
    { id: 13, slug: "about", path: "/about/", restBase: "pages", title: "About", content: "" },
    // Same slug under two parents: only the full path tells them apart.
    { id: 14, slug: "team", path: "/about/team/", restBase: "pages", title: "About the team", content: "" },
    { id: 15, slug: "team", path: "/careers/team/", restBase: "pages", title: "Join the team", content: "" },
    { id: 16, slug: "home", path: "/", restBase: "pages", title: "Home", content: "" },
    { id: 21, slug: "hello", path: "/2024/hello/", restBase: "posts", title: "Hello", content: "" },
    { id: 22, slug: "کفش-دویدن", path: "/2024/کفش-دویدن/", restBase: "posts", title: "کفش", content: "" },
    { id: 31, slug: "shoe", path: "/product/shoe/", restBase: "products", title: "Shoe", content: "" },
    {
      id: 41,
      slug: "gallery",
      path: "/gallery/",
      restBase: "pages",
      title: "Gallery",
      content: "", // filled once the port is known
    },
  ];

  const link = (p: FakePost) => `${baseUrl}${encodeURI(p.path)}`;
  const decodedPath = (u: string) => {
    const path = decodeURIComponent(new URL(u, baseUrl).pathname).replace(/\/+$/, "");
    return path || "/";
  };
  const postJson = (p: FakePost) => ({
    id: p.id,
    slug: p.slug,
    link: link(p),
    title: { raw: p.title, rendered: p.title },
    content: { raw: p.content, rendered: p.content },
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const recordWrite = async (body: unknown) => {
      writes.push({ method, path: url.pathname, body });
      if (knobs.writeDelayMs) await new Promise((r) => setTimeout(r, knobs.writeDelayMs));
    };

    if (url.pathname === "/wp-json/" || url.pathname === "/wp-json") {
      if (mode === "moved") {
        res.writeHead(301, { location: "https://elsewhere.example/wp-json/" });
        return res.end();
      }
      return send(200, {
        name: "Fake WP",
        namespaces: ["wp/v2", "oembed/1.0", ...(opts.bridge ? ["seo-table/v1"] : [])],
      });
    }

    if (mode === "waf") {
      res.writeHead(403, { "content-type": "text/html" });
      return res.end("<html><body><h1>Access denied</h1>Request blocked by firewall.</body></html>");
    }
    if (mode === "stripAuth") delete req.headers.authorization;

    // Everything below requires the application password. Like WordPress: no
    // header at all is anonymous, a wrong application password is its own error.
    if (!req.headers.authorization) {
      return send(401, { code: "rest_forbidden_context", message: "Sorry, you are not allowed to edit posts in this post type.", data: { status: 401 } });
    }
    if (!authorized(req)) {
      return send(401, { code: "incorrect_password", message: "The provided password is an invalid application password.", data: { status: 401 } });
    }

    if (url.pathname === "/wp-json/wp/v2/users/me") {
      if (mode === "blockUsers") {
        return send(403, { code: "rest_user_cannot_view", message: "Sorry, you are not allowed to list users.", data: { status: 403 } });
      }
      return send(200, { id: 7, name: "SEO Bot", capabilities: { edit_posts: mode !== "subscriber" } });
    }

    if (url.pathname === "/wp-json/wp/v2/types") {
      return send(200, {
        post: { slug: "post", rest_base: "posts", rest_namespace: "wp/v2" },
        page: { slug: "page", rest_base: "pages", rest_namespace: "wp/v2" },
        attachment: { slug: "attachment", rest_base: "media", rest_namespace: "wp/v2" },
        wp_block: { slug: "wp_block", rest_base: "blocks", rest_namespace: "wp/v2" },
        product: { slug: "product", rest_base: "products", rest_namespace: "wp/v2" },
      });
    }

    const collection = url.pathname.match(/^\/wp-json\/wp\/v2\/(pages|posts|products)$/);
    if (collection && method === "GET") {
      if (mode === "subscriber") {
        return send(403, { code: "rest_forbidden_context", message: "Sorry, you are not allowed to edit posts in this post type.", data: { status: 403 } });
      }
      const slug = url.searchParams.get("slug");
      return send(
        200,
        posts.filter((p) => p.restBase === collection[1] && (slug === null || p.slug === slug)).map(postJson),
      );
    }

    const single = url.pathname.match(/^\/wp-json\/wp\/v2\/(pages|posts|products)\/(\d+)$/);
    if (single) {
      const post = posts.find((p) => p.id === Number(single[2]) && p.restBase === single[1]);
      if (!post) return send(404, { code: "rest_post_invalid_id" });
      if (method === "POST") {
        const body = (await json(req)) as { title?: string; content?: string };
        await recordWrite(body);
        if (typeof body.title === "string") post.title = body.title;
        if (typeof body.content === "string") post.content = body.content;
      }
      return send(200, postJson(post));
    }

    if (url.pathname === "/wp-json/wp/v2/media" && method === "GET") {
      // WordPress searches the attachment title, which is the file name stem.
      const q = url.searchParams.get("search") ?? "";
      return send(200, [...media.values()].filter((m) => m.source_url.includes(q)));
    }

    const mediaMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/media\/(\d+)$/);
    if (mediaMatch && method === "POST") {
      const item = media.get(Number(mediaMatch[1]));
      if (!item) return send(404, { code: "rest_post_invalid_id" });
      const body = (await json(req)) as { alt_text?: string };
      await recordWrite(body);
      if (typeof body.alt_text === "string") item.alt_text = body.alt_text;
      return send(200, item);
    }

    // ---- the bridge plugin ---------------------------------------------------
    if (opts.bridge && url.pathname.startsWith("/wp-json/seo-table/v1/")) {
      const route = url.pathname.slice("/wp-json/seo-table/v1".length);

      if (route === "/info") {
        if (opts.bridgeVersion === "0.4.0") return send(404, { code: "rest_no_route" });
        return send(200, { version: opts.bridgeVersion ?? "0.5.0", store: "own" });
      }

      if (route === "/resolve") {
        const target = decodedPath(url.searchParams.get("url") ?? "");
        const override = knobs.misresolve.get(target);
        const post =
          override !== undefined
            ? posts.find((p) => p.id === override)
            : target === "/"
              ? posts.find((p) => p.id === opts.frontPageId)
              : posts.find((p) => decodedPath(link(p)) === target);
        if (!post) return send(404, { code: "not_found", message: "No post has this address" });
        return send(200, { id: post.id, type: post.restBase, rest_base: post.restBase, rest_namespace: "wp/v2", link: link(post) });
      }

      if (route === "/seo") {
        if (method === "GET") {
          if (knobs.failSeoReads) return send(500, { code: "internal_server_error" });
          const id = Number(url.searchParams.get("post"));
          const fields = seo.get(id) ?? {};
          return send(200, {
            post: id,
            title: fields.title ?? null,
            meta_description: fields.meta_description ?? null,
            canonical: fields.canonical ?? null,
            meta_robots: fields.meta_robots ?? null,
          });
        }
        const body =
          method === "DELETE"
            ? { post: Number(url.searchParams.get("post")), field: url.searchParams.get("field"), value: null }
            : ((await json(req)) as { post: number; field: string; value: string | null });
        await recordWrite(body);
        const current = seo.get(Number(body.post)) ?? {};
        const previous = current[String(body.field)] ?? null;
        if (body.value === null) delete current[String(body.field)];
        else current[String(body.field)] = String(body.value);
        seo.set(Number(body.post), current);
        return send(200, { ok: true, value: body.value, previous });
      }

      if (route === "/redirects") {
        if (method === "GET") {
          const from = url.searchParams.get("from");
          if (!from) return send(200, Object.fromEntries(redirects));
          const key = decodedPath(from);
          return send(200, { from: key, to: redirects.get(key) ?? null, status: redirects.has(key) ? 301 : null });
        }
        if (method === "DELETE") {
          const key = decodedPath(url.searchParams.get("from") ?? "");
          await recordWrite({ from: key });
          const previous = redirects.get(key) ?? null;
          redirects.delete(key);
          return send(200, { ok: true, value: null, previous });
        }
        const body = (await json(req)) as { from: string; to: string };
        await recordWrite(body);
        if (new URL(body.to, baseUrl).host !== new URL(baseUrl).host) {
          return send(400, { code: "external_target", message: "Redirects may only point to this site" });
        }
        const key = decodedPath(body.from);
        const previous = redirects.get(key) ?? null;
        redirects.set(key, body.to);
        return send(200, { ok: true, value: body.to, previous });
      }
    }

    send(404, { code: "rest_no_route", message: "No route was found matching the URL and request method." });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const uploads = `${baseUrl}/wp-content/uploads`;
  media.set(501, {
    id: 501,
    source_url: `${uploads}/1204.webp`,
    alt_text: "",
    media_details: { sizes: { medium: { source_url: `${uploads}/1204-300x200.webp` } } },
  });
  media.set(502, { id: 502, source_url: `${uploads}/1205.webp`, alt_text: "" });
  // A name that contains another's: a substring match would pick the wrong one.
  media.set(503, { id: 503, source_url: `${uploads}/12045.webp`, alt_text: "" });
  media.set(601, {
    id: 601,
    source_url: `${uploads}/hero.jpg`,
    alt_text: "media library alt",
    media_details: { sizes: { large: { source_url: `${uploads}/hero-1024x768.jpg` } } },
  });
  for (const id of [14, 15]) posts.find((p) => p.id === id)!.content = `<img src="${uploads}/team.jpg">`;
  posts.find((p) => p.id === 41)!.content =
    `<!-- wp:image {"id":601} -->\n<figure class="wp-block-image"><img src="${uploads}/hero-1024x768.jpg" class="wp-image-601"/></figure>\n<!-- /wp:image -->\n<p>Other <img src="${uploads}/other.jpg" alt="keep me"> text</p>`;

  return {
    baseUrl,
    posts,
    media,
    seo,
    redirects,
    writes,
    knobs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
  return user === USER && rest.join(":") === PASS;
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
