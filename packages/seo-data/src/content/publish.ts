/**
 * Publishing a content document to WordPress, under the safety policy.
 *
 * Content changes are SENSITIVE: whoever may edit documents (content:write)
 * can ask; only a person with fix:approve_sensitive can approve, and the
 * approval is what performs the write. Two modes:
 *   - draft:  a new WordPress draft (status "draft"); nothing visitors see changes;
 *   - update: the post whose permalink is the document's URL gets the
 *             document's title and body. What the post held before is kept, and
 *             rollback restores it — unless someone edited the post since, in
 *             which case rollback refuses rather than overwrite their work.
 * A request is bound to the document as it was when asked (a hash of title and
 * body); editing the document afterwards voids the request, so an approver
 * never approves text they did not see.
 *
 * WordPress is reached with the project's WordPress connector credentials
 * (Application Password), through the SSRF-guarded client; the post is found
 * by permalink path, never by search.
 */
import { and, connectors, contentDocuments, db, eq, sql, type ContentDocument, type ContentPublishState } from "@seo/db";
import { BadRequest, Conflict, NotConnected, UpstreamError, sha256, unsealJson, type Actor } from "@seo/core";
import { httpJson, type WordPressCredentials } from "@seo/connectors";
import { getDocument } from "./documents.js";

export type PublishMode = ContentPublishState["mode"];

type WpPost = {
  id: number;
  link?: string;
  status?: string;
  title?: { raw?: string; rendered?: string };
  content?: { raw?: string; rendered?: string };
};
type WpType = { rest_base?: string; rest_namespace?: string };

const NON_CONTENT = new Set(["attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face"]);

async function credentials(projectId: string): Promise<WordPressCredentials> {
  const row = (
    await db
      .select()
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.kind, "WORDPRESS")))
      .limit(1)
  )[0];
  if (!row || row.status !== "CONNECTED" || !row.secretCipher || !row.secretIv || !row.secretTag) throw new NotConnected("WORDPRESS");
  return unsealJson<WordPressCredentials>({ cipher: row.secretCipher, iv: row.secretIv, tag: row.secretTag });
}

function client(creds: WordPressCredentials) {
  const base = creds.siteUrl.replace(/\/+$/, "");
  const headers = {
    authorization: `Basic ${Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString("base64")}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await httpJson<T & { message?: string; code?: string }>(`${base}/wp-json/${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status >= 400 || !res.data) {
      const reason = res.data?.code ?? `http_${res.status}`;
      throw new UpstreamError(`WordPress answered HTTP ${res.status}${res.data?.message ? `: ${res.data.message}` : ""}`, { reason });
    }
    return res.data;
  }
  const path = (u: string) => {
    try {
      return decodeURIComponent(new URL(u).pathname).replace(/\/+$/, "") || "/";
    } catch {
      return u;
    }
  };
  return {
    async createDraft(restBase: string, title: string, content: string): Promise<WpPost> {
      return call<WpPost>("POST", `wp/v2/${restBase}`, { title, content, status: "draft" });
    },
    async get(restBase: string, id: number): Promise<WpPost> {
      return call<WpPost>("GET", `wp/v2/${restBase}/${id}?context=edit`);
    },
    async update(restBase: string, id: number, fields: { title: string; content: string }): Promise<WpPost> {
      return call<WpPost>("POST", `wp/v2/${restBase}/${id}`, fields);
    },
    async trash(restBase: string, id: number): Promise<void> {
      await call<WpPost>("DELETE", `wp/v2/${restBase}/${id}`);
    },
    /** The post whose permalink is `url`: candidates by slug in every content type, confirmed by link path. */
    async resolve(url: string): Promise<{ id: number; restBase: string; link: string | null; status: string | null }> {
      const wanted = path(url);
      const slug = wanted.split("/").filter(Boolean).at(-1);
      if (!slug) throw new BadRequest("The site's home page cannot be updated from the content editor");
      const types = await call<Record<string, WpType>>("GET", "wp/v2/types");
      for (const [name, t] of Object.entries(types)) {
        if (NON_CONTENT.has(name) || !t.rest_base || (t.rest_namespace ?? "wp/v2") !== "wp/v2") continue;
        const found = await call<WpPost[]>("GET", `wp/v2/${t.rest_base}?slug=${encodeURIComponent(slug)}&context=edit&per_page=20`).catch(() => []);
        const post = found.find((p) => p.link && path(p.link) === wanted);
        if (post) return { id: post.id, restBase: t.rest_base, link: post.link ?? null, status: post.status ?? null };
      }
      throw new BadRequest("No WordPress post or page has this document's URL as its permalink", { url });
    },
  };
}

function bodyHash(doc: Pick<ContentDocument, "title" | "body">): string {
  return sha256(`${doc.title}\n${doc.body}`);
}

const actorId = (a: Actor) => (a.type === "API_KEY" ? `api-key:${a.id}` : (a.id ?? a.type));

async function save(projectId: string, id: string, publish: ContentPublishState, expectStatus?: ContentPublishState["status"]) {
  const rows = await db
    .update(contentDocuments)
    .set({ publish })
    .where(
      and(
        eq(contentDocuments.id, id),
        eq(contentDocuments.projectId, projectId),
        ...(expectStatus ? [sql`${contentDocuments.publish}->>'status' = ${expectStatus}`] : []),
      ),
    )
    .returning({ id: contentDocuments.id });
  return rows.length > 0;
}

export async function requestPublish(
  projectId: string,
  id: string,
  input: { mode: PublishMode; postType?: "posts" | "pages" },
  actor: Actor,
): Promise<ContentPublishState> {
  const doc = await getDocument(projectId, id);
  if (!doc.body.trim()) throw new BadRequest("The document is empty");
  if (doc.publish?.status === "publishing") throw new Conflict("This document is being published right now");
  const wp = client(await credentials(projectId));
  let post: ContentPublishState["post"];
  if (input.mode === "update") {
    if (!doc.url) throw new BadRequest("Set the page's URL on the document to update an existing post", { field: "url" });
    post = await wp.resolve(doc.url);
  }
  const state: ContentPublishState = {
    status: "pending",
    mode: input.mode,
    postType: post?.restBase ?? input.postType ?? "posts",
    requestedBy: actorId(actor),
    requestedAt: new Date().toISOString(),
    bodyHash: bodyHash(doc),
    ...(post ? { post } : {}),
  };
  await save(projectId, id, state);
  return state;
}

/**
 * Approve (and write) or reject a pending request. Only a person may decide —
 * the route requires fix:approve_sensitive, and an agent or API key is refused here too.
 */
export async function decidePublish(
  projectId: string,
  id: string,
  input: { approve: boolean; reason?: string },
  actor: Actor,
): Promise<ContentPublishState> {
  if (actor.type !== "USER") throw new Conflict("Only a person can approve or reject publishing");
  const doc = await getDocument(projectId, id);
  const current = doc.publish;
  if (!current || current.status !== "pending") throw new Conflict("There is no pending publish request for this document");
  if (current.bodyHash !== bodyHash(doc)) {
    throw new Conflict("The document changed after publishing was requested; ask again so the approver sees the current text", { reason: "document_changed" });
  }
  const decided = { decidedBy: actorId(actor), decidedAt: new Date().toISOString(), ...(input.reason ? { reason: input.reason } : {}) };
  if (!input.approve) {
    const rejected: ContentPublishState = { ...current, ...decided, status: "rejected" };
    if (!(await save(projectId, id, rejected, "pending"))) throw new Conflict("The request was decided by someone else");
    return rejected;
  }
  // Claim first: of two simultaneous approvals exactly one writes.
  if (!(await save(projectId, id, { ...current, ...decided, status: "publishing" }, "pending"))) {
    throw new Conflict("The request was decided by someone else");
  }
  let outcome: ContentPublishState;
  try {
    const wp = client(await credentials(projectId));
    if (current.mode === "draft") {
      const created = await wp.createDraft(current.postType, doc.title, doc.body);
      outcome = {
        ...current,
        ...decided,
        status: "published",
        post: { id: created.id, restBase: current.postType, link: created.link ?? null, status: created.status ?? "draft" },
        written: { title: doc.title, content: doc.body },
        publishedAt: new Date().toISOString(),
      };
    } else {
      const target = current.post ?? (await wp.resolve(doc.url!));
      const before = await wp.get(target.restBase, target.id);
      const previous = { title: before.title?.raw ?? before.title?.rendered ?? "", content: before.content?.raw ?? before.content?.rendered ?? "" };
      const after = await wp.update(target.restBase, target.id, { title: doc.title, content: doc.body });
      outcome = {
        ...current,
        ...decided,
        status: "published",
        post: { ...target, link: after.link ?? target.link, status: after.status ?? target.status },
        previous,
        written: { title: after.title?.raw ?? doc.title, content: after.content?.raw ?? doc.body },
        publishedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    outcome = { ...current, ...decided, status: "failed", error: (err as Error).message.slice(0, 500) };
  }
  await save(projectId, id, outcome, "publishing");
  return outcome;
}

/**
 * Undo a publish: an updated post gets its previous title and content back, a
 * created draft goes to the WordPress trash. Refused when the post was edited
 * after we wrote it (or the draft was published by someone).
 */
export async function rollbackPublish(projectId: string, id: string): Promise<ContentPublishState> {
  const doc = await getDocument(projectId, id);
  const current = doc.publish;
  if (!current || current.status !== "published" || !current.post) throw new Conflict("Nothing published from this document to undo");
  const wp = client(await credentials(projectId));
  const post = await wp.get(current.post.restBase, current.post.id);
  const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim() === (b ?? "").trim();
  if (current.mode === "draft") {
    if (post.status && post.status !== "draft") throw new Conflict("The draft has been published in WordPress since; it is left as it is", { reason: "changed_since_publish" });
    await wp.trash(current.post.restBase, current.post.id);
  } else {
    if (!current.previous) throw new Conflict("The previous content was not recorded");
    if (!same(post.content?.raw, current.written?.content) || !same(post.title?.raw, current.written?.title)) {
      throw new Conflict("The post was edited in WordPress after publishing; it is left as it is", { reason: "changed_since_publish" });
    }
    await wp.update(current.post.restBase, current.post.id, current.previous);
  }
  // Who rolled back is recorded in the audit log (content.publish_rollback).
  const next: ContentPublishState = { ...current, status: "rolled_back" };
  if (!(await save(projectId, id, next, "published"))) throw new Conflict("The publish state changed meanwhile");
  return next;
}
