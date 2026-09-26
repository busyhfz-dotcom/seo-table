/**
 * HTTP doubles for the social platforms, speaking their real shapes:
 *
 *   Instagram   api.instagram.com/oauth/access_token (form POST, {data:[…]}),
 *               graph.instagram.com access_token / refresh_access_token, and
 *               /v25.0/{me|id}[/media|/insights|/content_publishing_limit|
 *               /media_publish] with Graph error objects {error:{code,…}}
 *   Telegram    /bot<token>/<method> with {ok, result} / {ok:false, error_code,
 *               description, parameters.retry_after}
 *   t.me        /s/<channel> with the preview's markup (tgme_* classes), a
 *               302 for a private channel
 *
 * Each double records the requests it received; knobs change its behaviour
 * while it runs. `drop` makes the next call to a method close the connection
 * without an answer — the "did it post or not?" case.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type Received = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; body: string };

export type Fake<K> = { url: string; received: Received[]; knobs: K; close: () => Promise<void> };

async function serve<K>(knobs: K, handle: (req: Received, res: ServerResponse, knobs: K) => void): Promise<Fake<K>> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const r = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(r);
      handle(r, res, knobs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    knobs,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------- Instagram

export type IgMediaFixture = {
  id: string;
  caption: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  timestamp: string;
  like_count: number;
  comments_count: number;
  alt_text?: string | null;
  insights?: { reach: number; views: number; likes: number; comments: number; shares: number; saved: number; total_interactions: number };
};

export type InstagramKnobs = {
  appId: string;
  appSecret: string;
  code: string;
  /** The token the Graph API currently accepts. */
  token: string;
  userId: string;
  profile: { username: string; name: string; biography: string; website: string; account_type: string; followers_count: number; follows_count: number; media_count: number };
  media: IgMediaFixture[];
  account: { reach: number; views: number; total_interactions: number };
  businessDiscovery: "unsupported" | "ok";
  containers: Map<string, { status: "IN_PROGRESS" | "FINISHED" | "ERROR"; params: Record<string, string>; polls: number }>;
  /** Polls a container stays IN_PROGRESS before it is FINISHED. */
  processingPolls: number;
  published: string[];
  quotaUsage: number;
};

function graphError(res: ServerResponse, status: number, code: number, message: string, subcode?: number) {
  json(res, status, { error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: "Abc" } });
}

export function fakeInstagram(overrides: Partial<InstagramKnobs> = {}) {
  const knobs: InstagramKnobs = {
    appId: "123456789012345",
    appSecret: "app-secret-0123456789abcdef",
    code: "AQ-code-1",
    token: "IGAA-long-1",
    userId: "17841400000000001",
    profile: {
      username: "cafe.roya",
      name: "Cafe Roya",
      biography: "Coffee and cake in Tehran",
      website: "",
      account_type: "BUSINESS",
      followers_count: 5200,
      follows_count: 180,
      media_count: 3,
    },
    media: [],
    account: { reach: 800, views: 2400, total_interactions: 130 },
    businessDiscovery: "unsupported",
    containers: new Map(),
    processingPolls: 1,
    published: [],
    quotaUsage: 0,
    ...overrides,
  };
  let containerSeq = 0;
  return serve(knobs, (req, res, k) => {
    const form = new URLSearchParams(req.body);
    // api.instagram.com: code → short-lived token.
    if (req.path === "/oauth/access_token") {
      if (form.get("client_id") !== k.appId || form.get("client_secret") !== k.appSecret) {
        json(res, 400, { error_type: "OAuthException", code: 400, error_message: "Invalid platform app" });
        return;
      }
      if (form.get("code") !== k.code) {
        json(res, 400, { error_type: "OAuthException", code: 400, error_message: "This authorization code has been used" });
        return;
      }
      json(res, 200, { data: [{ access_token: "IGAA-short", user_id: k.userId, permissions: "instagram_business_basic,instagram_business_content_publish" }] });
      return;
    }
    if (req.path === "/access_token") {
      if (req.query.get("access_token") !== "IGAA-short" || req.query.get("client_secret") !== k.appSecret) return graphError(res, 400, 190, "Invalid OAuth access token");
      json(res, 200, { access_token: k.token, token_type: "bearer", expires_in: 5_184_000 });
      return;
    }
    if (req.path === "/refresh_access_token") {
      if (req.query.get("access_token") !== k.token) return graphError(res, 400, 190, "Invalid OAuth access token");
      k.token = `${k.token}-r`;
      json(res, 200, { access_token: k.token, token_type: "bearer", expires_in: 5_184_000 });
      return;
    }
    const token = req.query.get("access_token") ?? form.get("access_token");
    if (token !== k.token) return graphError(res, 400, 190, "Error validating access token: Session has expired");
    const parts = req.path.replace(/^\/v25\.0\//, "").split("/");
    const [node, edge] = parts;
    if (node === "me" && !edge) {
      json(res, 200, { user_id: k.userId, id: "app-scoped-1", ...k.profile, profile_picture_url: "https://cdn.example/p.jpg" });
      return;
    }
    if (node === "me" && edge === "media") {
      const after = Number(req.query.get("after") ?? 0);
      const limit = Number(req.query.get("limit") ?? 25);
      const page = k.media.slice(after, after + Math.min(limit, 2));
      const next = after + page.length < k.media.length ? after + page.length : null;
      json(res, 200, {
        data: page.map((m) => ({
          id: m.id,
          caption: m.caption,
          media_type: m.media_type,
          media_url: `https://cdn.example/${m.id}.jpg`,
          permalink: `https://www.instagram.com/p/${m.id}/`,
          timestamp: m.timestamp,
          like_count: m.like_count,
          comments_count: m.comments_count,
          alt_text: m.alt_text ?? null,
        })),
        paging: next !== null ? { cursors: { after: String(next) }, next: `https://graph.instagram.com/next?after=${next}` } : { cursors: {} },
      });
      return;
    }
    if (edge === "insights" && node === k.userId) {
      const names = (req.query.get("metric") ?? "").split(",");
      json(res, 200, {
        data: names.map((name) => ({ name, period: "day", total_value: { value: k.account[name as keyof typeof k.account] ?? 0 } })),
      });
      return;
    }
    if (edge === "insights") {
      const m = k.media.find((x) => x.id === node);
      if (!m?.insights) return graphError(res, 400, 100, "Unsupported get request", 33);
      const names = (req.query.get("metric") ?? "").split(",");
      json(res, 200, { data: names.map((name) => ({ name, period: "lifetime", values: [{ value: m.insights![name as keyof typeof m.insights] ?? 0 }] })) });
      return;
    }
    if (node === k.userId && !edge && (req.query.get("fields") ?? "").startsWith("business_discovery")) {
      if (k.businessDiscovery === "unsupported") return graphError(res, 400, 100, "Tried accessing nonexisting field (business_discovery) on node type (User)");
      json(res, 200, {
        business_discovery: {
          name: "Rival Cafe",
          biography: "Coffee",
          followers_count: 9100,
          media_count: 400,
          media: { data: [{ timestamp: new Date().toISOString(), like_count: 120, comments_count: 8 }] },
        },
      });
      return;
    }
    if (node === k.userId && edge === "content_publishing_limit") {
      json(res, 200, { data: [{ quota_usage: k.quotaUsage, config: { quota_total: 100, quota_duration: 86400 } }] });
      return;
    }
    if (node === k.userId && edge === "media" && req.method === "POST") {
      const id = `container-${++containerSeq}`;
      k.containers.set(id, { status: "IN_PROGRESS", params: Object.fromEntries(form), polls: 0 });
      json(res, 200, { id });
      return;
    }
    if (node === k.userId && edge === "media_publish" && req.method === "POST") {
      const c = k.containers.get(form.get("creation_id") ?? "");
      if (!c || c.status !== "FINISHED") return graphError(res, 400, 9007, "Media ID is not available", 2207027);
      const id = `1790000000000${k.published.length + 1}`;
      k.published.push(form.get("creation_id")!);
      json(res, 200, { id });
      return;
    }
    if (node?.startsWith("container-")) {
      const c = k.containers.get(node);
      if (!c) return graphError(res, 400, 100, "Unsupported get request", 33);
      if (c.status === "IN_PROGRESS" && ++c.polls > k.processingPolls) c.status = "FINISHED";
      json(res, 200, { id: node, status_code: c.status, status: c.status === "ERROR" ? "Error: media type not supported" : "" });
      return;
    }
    if (node?.startsWith("1790000000000") && req.query.get("fields") === "permalink") {
      json(res, 200, { id: node, permalink: `https://www.instagram.com/p/${node}/` });
      return;
    }
    graphError(res, 400, 100, "Unsupported get request", 33);
  });
}

// ---------------------------------------------------------------- Telegram

export type TelegramKnobs = {
  token: string;
  bot: { id: number; username: string };
  chat: { id: number; type: string; title: string; username?: string; description?: string; pinned_message?: unknown };
  /** "administrator" | "creator" | "member" | "left". */
  status: string;
  rights: Record<string, boolean>;
  members: number;
  updates: unknown[];
  /** Next call to a method fails this way (once). */
  fail: Map<string, { status: number; description: string; retryAfter?: number } | "drop">;
  sent: Array<{ method: string; body: Record<string, unknown> }>;
  nextMessageId: number;
};

export function fakeTelegram(overrides: Partial<TelegramKnobs> = {}) {
  const knobs: TelegramKnobs = {
    token: "7000000001:AAHfakeTokenForTestsOnly_abcdefghijk",
    bot: { id: 7000000001, username: "roya_panel_bot" },
    chat: { id: -1001234567890, type: "channel", title: "Roya News", username: "roya_news", description: "" },
    status: "administrator",
    rights: { can_post_messages: true, can_edit_messages: true, can_change_info: true },
    members: 1000,
    updates: [],
    fail: new Map(),
    sent: [],
    nextMessageId: 500,
    ...overrides,
  };
  return serve(knobs, (req, res, k) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.path);
    if (!m) return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    const [, token, method] = m as unknown as [string, string, string];
    if (token !== k.token) return json(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const body = (req.body ? JSON.parse(req.body) : {}) as Record<string, unknown>;
    const failure = k.fail.get(method);
    if (failure) {
      k.fail.delete(method);
      if (failure === "drop") {
        // The request arrived (and, for a send, the post would exist); the answer never comes.
        if (method.startsWith("send")) k.sent.push({ method, body });
        res.socket?.destroy();
        return;
      }
      return json(res, failure.status, {
        ok: false,
        error_code: failure.status,
        description: failure.description,
        ...(failure.retryAfter ? { parameters: { retry_after: failure.retryAfter } } : {}),
      });
    }
    const ok = (result: unknown) => json(res, 200, { ok: true, result });
    const chatMatches = () => String(body.chat_id) === String(k.chat.id) || body.chat_id === `@${k.chat.username}`;
    const message = (extra: Record<string, unknown>) => ({
      message_id: k.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: k.chat.id, type: k.chat.type, title: k.chat.title, username: k.chat.username },
      ...extra,
    });
    switch (method) {
      case "getMe":
        return ok({ id: k.bot.id, is_bot: true, first_name: "Panel", username: k.bot.username });
      case "getChat":
        if (!chatMatches()) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
        return ok(k.chat);
      case "getChatMember":
        return ok({ status: k.status, user: { id: k.bot.id }, ...(k.status === "administrator" ? k.rights : {}) });
      case "getChatMemberCount":
        return ok(k.members);
      case "setChatTitle":
        if (!k.rights.can_change_info) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: not enough rights to change chat title" });
        if (body.title === k.chat.title) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: chat title is not modified" });
        k.chat.title = String(body.title);
        k.sent.push({ method, body });
        return ok(true);
      case "setChatDescription":
        if (body.description === (k.chat.description ?? "")) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: chat description is not modified" });
        k.chat.description = String(body.description);
        k.sent.push({ method, body });
        return ok(true);
      case "sendMessage":
        if (/<(?!\/?(b|i|a)\b)/.test(String(body.text))) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
        k.sent.push({ method, body });
        return ok(message({ text: String(body.text).replace(/<[^>]+>/g, "") }));
      case "sendPhoto":
        k.sent.push({ method, body });
        return ok(message({ photo: [{ file_id: "p" }], caption: body.caption }));
      case "sendMediaGroup": {
        k.sent.push({ method, body });
        const items = body.media as Array<{ type: string }>;
        const group = `g${Date.now()}`;
        return ok(items.map((it, i) => message({ media_group_id: group, [it.type]: [{ file_id: "x" }], ...(i === 0 ? { caption: (items[0] as { caption?: string }).caption } : {}) })));
      }
      case "editMessageText":
      case "editMessageCaption":
      case "pinChatMessage":
        k.sent.push({ method, body });
        if (method === "pinChatMessage") k.chat.pinned_message = { message_id: body.message_id, date: 0, chat: k.chat, text: "pinned" };
        return ok(true);
      case "setWebhook":
      case "deleteWebhook":
        k.sent.push({ method, body });
        return ok(true);
      case "getUpdates": {
        const offset = Number(body.offset ?? 0);
        return ok((k.updates as Array<{ update_id: number }>).filter((u) => u.update_id >= offset));
      }
      default:
        return json(res, 404, { ok: false, error_code: 404, description: "Not Found: method not found" });
    }
  });
}

// ---------------------------------------------------------------- t.me preview

export type PreviewPostFixture = { id: number; date: Date; text: string; views: string; photo?: boolean; bold?: boolean };
export type PreviewKnobs = { channels: Map<string, { title: string; description: string; subscribers: string; posts: PreviewPostFixture[] }> };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The markup t.me/s/<channel> serves (trimmed to what the parser reads, class names as Telegram uses them). */
export function previewHtml(username: string, ch: { title: string; description: string; subscribers: string; posts: PreviewPostFixture[] }): string {
  const posts = [...ch.posts]
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const text = escapeHtml(p.text)
        .replace(/\n/g, "<br/>")
        .replace(/#([\p{L}\p{N}_]+)/gu, '<a href="?q=%23$1">#$1</a>');
      return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${username}/${p.id}" data-view="x">
  <div class="tgme_widget_message_bubble">
    ${p.photo ? `<a class="tgme_widget_message_photo_wrap" href="https://t.me/${username}/${p.id}" style="width:800px;background-image:url('https://cdn4.telesco.pe/file/${p.id}.jpg')"></a>` : ""}
    <div class="tgme_widget_message_text js-message_text" dir="auto">${p.bold ? `<b>${text}</b>` : text}</div>
    <div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info">
      <span class="tgme_widget_message_views">${p.views}</span><span class="copyonly"> views</span>
      <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${username}/${p.id}"><time datetime="${p.date.toISOString().replace(/\.\d{3}Z$/, "+00:00")}" class="time">12:00</time></a></span>
    </div></div>
  </div></div></div>`;
    })
    .join("\n");
  return `<!DOCTYPE html><html><head><title>${escapeHtml(ch.title)} – Telegram</title></head><body class="widget_frame_base tgme_webpage">
<section class="tgme_channel_history js-message_history">${posts}</section>
<div class="tgme_channel_info">
  <div class="tgme_channel_info_header"><i class="tgme_page_photo_image bgcolor2" data-content="R"><img src="https://cdn4.telesco.pe/file/avatar.jpg"></i>
    <div class="tgme_channel_info_header_title"><span dir="auto">${escapeHtml(ch.title)}</span></div>
    <div class="tgme_channel_info_header_username"><a href="https://t.me/${username}">@${username}</a></div></div>
  <div class="tgme_channel_info_description">${escapeHtml(ch.description).replace(/\n/g, "<br/>")}</div>
  <div class="tgme_channel_info_counters">
    <div class="tgme_channel_info_counter"><span class="counter_value">${ch.subscribers}</span> <span class="counter_type">subscribers</span></div>
    <div class="tgme_channel_info_counter"><span class="counter_value">312</span> <span class="counter_type">photos</span></div>
  </div>
</div></body></html>`;
}

export function fakePreview() {
  const knobs: PreviewKnobs = { channels: new Map() };
  return serve(knobs, (req, res, k) => {
    const m = /^\/s\/([A-Za-z0-9_]+)$/.exec(req.path);
    const ch = m ? k.channels.get(m[1]!.toLowerCase()) : undefined;
    if (!m || !ch) {
      res.writeHead(302, { location: `https://t.me/${m?.[1] ?? ""}` });
      res.end();
      return;
    }
    const before = Number(req.query.get("before") ?? Infinity);
    // 20 posts per page, newest last on the page, like Telegram.
    const page = ch.posts.filter((p) => p.id < before).sort((a, b) => b.id - a.id).slice(0, 20);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(previewHtml(m[1]!, { ...ch, posts: page }));
  });
}
