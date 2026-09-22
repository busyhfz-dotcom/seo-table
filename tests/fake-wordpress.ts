/**
 * A WordPress REST API double, over real HTTP.
 *
 * It implements just the endpoints the connector calls, with WordPress's own
 * shapes and status codes, and it enforces Basic auth with an application
 * password — so the connector's auth, capability probing, read-before-write,
 * write and rollback are all exercised against a server, not a stubbed function.
 *
 * `bridge` toggles the SEO Table bridge plugin's namespace, which is what decides
 * whether SEO fields and redirects are writable.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export type FakeWp = {
  baseUrl: string;
  media: Map<number, { id: number; source_url: string; alt_text: string }>;
  seo: Map<number, Record<string, string | null>>;
  redirects: Map<string, string>;
  writes: Array<{ path: string; body: unknown }>;
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
 */
export type FakeWpMode = "normal" | "blockUsers" | "stripAuth" | "waf" | "subscriber";

export async function startFakeWordPress(opts: { bridge?: boolean; mode?: FakeWpMode } = {}): Promise<FakeWp> {
  const mode = opts.mode ?? "normal";
  let baseUrl = "";
  const media = new Map<number, { id: number; source_url: string; alt_text: string }>();
  const seo = new Map<number, Record<string, string | null>>();
  const redirects = new Map<string, string>();
  const writes: Array<{ path: string; body: unknown }> = [];

  const posts = [
    { id: 11, slug: "1204", link: "/p/1204", type: "pages", title: "کتانی ۱۲۰۴" },
    { id: 12, slug: "1205", link: "/p/1205", type: "pages", title: "کتانی ۱۲۰۵" },
  ];

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/wp-json/" || url.pathname === "/wp-json") {
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

    if (url.pathname === "/wp-json/wp/v2/posts" && req.method === "GET") {
      if (mode === "subscriber") {
        return send(403, { code: "rest_forbidden_context", message: "Sorry, you are not allowed to edit posts in this post type.", data: { status: 403 } });
      }
      return send(200, posts.filter((x) => x.type === "posts").map((x) => ({ id: x.id })));
    }

    if (url.pathname === "/wp-json/wp/v2/media" && req.method === "GET") {
      const q = url.searchParams.get("search") ?? "";
      return send(200, [...media.values()].filter((m) => m.source_url.includes(q)));
    }

    const mediaMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/media\/(\d+)$/);
    if (mediaMatch && req.method === "POST") {
      const item = media.get(Number(mediaMatch[1]));
      if (!item) return send(404, { code: "rest_post_invalid_id" });
      const body = (await json(req)) as { alt_text?: string };
      writes.push({ path: url.pathname, body });
      if (typeof body.alt_text === "string") item.alt_text = body.alt_text;
      return send(200, item);
    }

    if (url.pathname === "/wp-json/wp/v2/search") {
      const q = url.searchParams.get("search") ?? "";
      const hit = posts.find((p) => q.endsWith(p.link));
      return send(200, hit ? [{ id: hit.id, subtype: "page", type: "post" }] : []);
    }

    const pageMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/(pages|posts)\/(\d+)$/);
    if (pageMatch) {
      const post = posts.find((p) => p.id === Number(pageMatch[2]));
      if (!post) return send(404, { code: "rest_post_invalid_id" });
      if (req.method === "POST") {
        const body = (await json(req)) as { title?: string };
        writes.push({ path: url.pathname, body });
        if (body.title) post.title = body.title;
      }
      return send(200, { id: post.id, link: post.link, title: { raw: post.title, rendered: post.title } });
    }

    if (opts.bridge && url.pathname === "/wp-json/seo-table/v1/seo") {
      if (req.method === "GET") {
        const id = Number(url.searchParams.get("post"));
        return send(200, { post: id, ...(seo.get(id) ?? {}) });
      }
      const body = (await json(req)) as Record<string, string | number>;
      writes.push({ path: url.pathname, body });
      if (body.field === "redirect") {
        const previous = redirects.get(String(body.from)) ?? null;
        redirects.set(String(body.from), String(body.to));
        return send(200, { ok: true, value: body.to, previous });
      }
      const id = Number(body.post);
      const current = seo.get(id) ?? {};
      const previous = current[String(body.field)] ?? null;
      current[String(body.field)] = String(body.value);
      seo.set(id, current);
      return send(200, { ok: true, value: body.value, previous });
    }

    send(404, { code: "rest_no_route", message: "No route was found matching the URL and request method." });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  media.set(501, { id: 501, source_url: `${baseUrl}/wp-content/uploads/1204.webp`, alt_text: "" });
  media.set(502, { id: 502, source_url: `${baseUrl}/wp-content/uploads/1205.webp`, alt_text: "" });

  return {
    baseUrl,
    media,
    seo,
    redirects,
    writes,
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
