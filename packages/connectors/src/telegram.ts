/**
 * A Telegram channel managed through a bot the owner adds as an administrator.
 *
 * The Bot API can change the channel's title and description (with the
 * can_change_info right), post, edit and pin messages (can_post_messages,
 * can_edit_messages), and report the member count. It cannot set the public
 * @username, and it never reports view counts: those come from the public web
 * preview (telegram-preview.ts) for public channels only.
 *
 * `telegramChannel` is also a `Connector`, so a title or description proposal
 * runs through the same executor as every website fix: dry run, approval,
 * snapshot of the previous value, drift check, rollback.
 *
 * The bot token is part of every URL: no error from here may carry a URL or a
 * raw fetch message; they are rebuilt from Telegram's own description.
 */
import { BlockedAddressError, guardedFetch } from "@seo/core";
import type { FixAction } from "@seo/db";
import { ConnectorError, type Connector, type ConnectorCapabilities, type ConnectorHealth, type WriteRequest, type WriteResult } from "./types.js";
import { deliveryOf, socialEndpoints } from "./social-endpoints.js";

export const TELEGRAM_BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
/** A numeric chat id ("-100…" for channels) or a public @username. */
export const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;
/** Channel title and description limits (Bot API setChatTitle / setChatDescription). */
export const TELEGRAM_TITLE_MAX = 128;
export const TELEGRAM_DESCRIPTION_MAX = 255;
export const TELEGRAM_TEXT_MAX = 4096;
export const TELEGRAM_CAPTION_MAX = 1024;

/** The administrator rights the panel needs, and what each unlocks. */
export const TELEGRAM_RIGHTS = ["can_post_messages", "can_edit_messages", "can_change_info"] as const;
export type TelegramRight = (typeof TELEGRAM_RIGHTS)[number];

export class TelegramError extends ConnectorError {
  constructor(
    code: string,
    message: string,
    /** "not_sent": safe to retry; "unknown": may have been delivered; "rejected": Telegram answered with an error. */
    readonly delivery: "not_sent" | "unknown" | "rejected",
    readonly retryAfter: number | null = null,
  ) {
    super(code, message);
    this.name = "TelegramError";
  }
  get transient(): boolean {
    return this.code === "rate_limited" || this.code === "api_unavailable" || this.delivery === "not_sent";
  }
}

function reasonFor(status: number, description: string): string {
  if (status === 401 || (status === 404 && /not found/i.test(description) && !/chat/i.test(description))) return "invalid_token";
  if (status === 429) return "rate_limited";
  if (/chat not found/i.test(description)) return "chat_not_found";
  if (/not enough rights|administrator rights|CHAT_ADMIN_REQUIRED|need administrator/i.test(description)) return "not_admin";
  if (/bot is not a member|bot was kicked|Forbidden/i.test(description) || status === 403) return "not_admin";
  if (/message to edit not found|message not found|MESSAGE_ID_INVALID/i.test(description)) return "message_not_found";
  if (/can't parse entities/i.test(description)) return "invalid_html";
  if (/wrong file identifier|failed to get HTTP URL content|wrong type of the web page content|WEBPAGE/i.test(description)) return "media_unreachable";
  if (status >= 500) return "api_unavailable";
  return "bad_request";
}

type TgResponse<T> = { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };

export type TgChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  description?: string;
  pinned_message?: TgMessage;
  photo?: { big_file_id?: string };
};

export type TgMessage = {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number; type: string; username?: string; title?: string };
  text?: string;
  caption?: string;
  entities?: Array<{ type: string }>;
  caption_entities?: Array<{ type: string }>;
  photo?: unknown[];
  video?: unknown;
  document?: unknown;
  media_group_id?: string;
};

export type TgChatMember = { status: string; user?: { id: number } } & Partial<Record<TelegramRight | "can_pin_messages", boolean>>;

export type TgUpdate = { update_id: number; channel_post?: TgMessage; edited_channel_post?: TgMessage };

export function telegramBot(botToken: string) {
  async function call<T>(method: string, body?: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    const base = socialEndpoints().telegramApi.replace(/\/$/, "");
    let res;
    try {
      res = await guardedFetch(`${base}/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        timeoutMs,
        maxBytes: 2 * 1024 * 1024,
      });
    } catch (err) {
      const delivery = err instanceof BlockedAddressError ? "not_sent" : deliveryOf(err);
      throw new TelegramError("network_error", `Telegram ${method} could not be reached`, delivery);
    }
    let data: TgResponse<T> | null = null;
    try {
      data = JSON.parse(res.body.toString("utf8")) as TgResponse<T>;
    } catch {
      data = null;
    }
    if (res.status >= 400 || !data?.ok) {
      const description = data?.description ?? `HTTP ${res.status}`;
      throw new TelegramError(
        reasonFor(res.status, description),
        `Telegram ${method}: ${description}`.slice(0, 400),
        "rejected",
        data?.parameters?.retry_after ?? null,
      );
    }
    return data.result as T;
  }

  return {
    call,
    getMe: () => call<{ id: number; username?: string; first_name?: string; is_bot?: boolean }>("getMe"),
    getChat: (chatId: string | number) => call<TgChat>("getChat", { chat_id: chatId }),
    getChatMemberCount: (chatId: string | number) => call<number>("getChatMemberCount", { chat_id: chatId }),
    getChatMember: (chatId: string | number, userId: number) => call<TgChatMember>("getChatMember", { chat_id: chatId, user_id: userId }),
    setChatTitle: (chatId: string | number, title: string) => call<boolean>("setChatTitle", { chat_id: chatId, title }),
    setChatDescription: (chatId: string | number, description: string) =>
      call<boolean>("setChatDescription", { chat_id: chatId, description }),
    sendMessage: (chatId: string | number, html: string, opts: { silent?: boolean } = {}) =>
      call<TgMessage>("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_notification: Boolean(opts.silent),
      }),
    sendPhoto: (chatId: string | number, photoUrl: string, captionHtml: string, opts: { silent?: boolean } = {}) =>
      call<TgMessage>("sendPhoto", {
        chat_id: chatId,
        photo: photoUrl,
        ...(captionHtml ? { caption: captionHtml, parse_mode: "HTML" } : {}),
        disable_notification: Boolean(opts.silent),
      }),
    sendVideo: (chatId: string | number, videoUrl: string, captionHtml: string, opts: { silent?: boolean } = {}) =>
      call<TgMessage>("sendVideo", {
        chat_id: chatId,
        video: videoUrl,
        ...(captionHtml ? { caption: captionHtml, parse_mode: "HTML" } : {}),
        disable_notification: Boolean(opts.silent),
      }),
    sendMediaGroup: (
      chatId: string | number,
      media: Array<{ type: "photo" | "video"; url: string }>,
      captionHtml: string,
      opts: { silent?: boolean } = {},
    ) =>
      call<TgMessage[]>("sendMediaGroup", {
        chat_id: chatId,
        // Telegram shows the first item's caption as the album's caption.
        media: media.map((m, i) => ({
          type: m.type,
          media: m.url,
          ...(i === 0 && captionHtml ? { caption: captionHtml, parse_mode: "HTML" } : {}),
        })),
        disable_notification: Boolean(opts.silent),
      }),
    editMessageText: (chatId: string | number, messageId: number, html: string) =>
      call<TgMessage | true>("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML" }),
    editMessageCaption: (chatId: string | number, messageId: number, html: string) =>
      call<TgMessage | true>("editMessageCaption", { chat_id: chatId, message_id: messageId, caption: html, parse_mode: "HTML" }),
    pinChatMessage: (chatId: string | number, messageId: number, silent = true) =>
      call<boolean>("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: silent }),
    setWebhook: (url: string, secretToken: string) =>
      call<boolean>("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["channel_post", "edited_channel_post"],
        max_connections: 10,
      }),
    deleteWebhook: () => call<boolean>("deleteWebhook", { drop_pending_updates: false }),
    getUpdates: (offset: number | undefined) =>
      call<TgUpdate[]>("getUpdates", {
        ...(offset !== undefined ? { offset } : {}),
        allowed_updates: ["channel_post", "edited_channel_post"],
        limit: 100,
        timeout: 0,
      }),
  };
}

export type TelegramBot = ReturnType<typeof telegramBot>;

export type TelegramCheck = ConnectorHealth & {
  /** Present once the chat was found. */
  chat?: TgChat;
  bot?: { id: number; username: string | null };
  rights?: Record<TelegramRight, boolean> & { is_creator: boolean };
  members?: number | null;
  missing?: TelegramRight[];
};

/**
 * Can this bot manage this channel? Reasons: invalid_token, chat_not_found,
 * not_a_channel, not_admin, missing_right:<name> (the first missing right; all
 * are listed in `missing`), network_error.
 */
export async function checkTelegramChannel(botToken: string, chat: string | number): Promise<TelegramCheck> {
  const bot = telegramBot(botToken);
  const fail = (reason: string, message: string, extra: Partial<TelegramCheck> = {}): TelegramCheck => ({ ok: false, reason, message, ...extra });
  let me;
  try {
    me = await bot.getMe();
  } catch (err) {
    const e = err as TelegramError;
    if (e.code === "invalid_token" || e.code === "bad_request") return fail("invalid_token", "Telegram does not recognise this bot token.");
    return fail(e.code ?? "network_error", "Telegram could not be reached.");
  }
  const botInfo = { id: me.id, username: me.username ?? null };
  let info: TgChat;
  try {
    info = await bot.getChat(chat);
  } catch (err) {
    const e = err as TelegramError;
    if (e.code === "chat_not_found" || e.code === "bad_request" || e.code === "not_admin") {
      return fail("chat_not_found", "The bot cannot see this channel: check the @username or id, and add the bot as an administrator.", { bot: botInfo });
    }
    return fail(e.code ?? "network_error", "Telegram could not be reached.", { bot: botInfo });
  }
  if (info.type !== "channel") {
    return fail("not_a_channel", `This chat is a ${info.type}, not a channel.`, { bot: botInfo, chat: info });
  }
  let member: TgChatMember;
  try {
    member = await bot.getChatMember(info.id, me.id);
  } catch {
    return fail("not_admin", "The bot is not an administrator of this channel.", { bot: botInfo, chat: info });
  }
  const isCreator = member.status === "creator";
  if (!isCreator && member.status !== "administrator") {
    return fail("not_admin", "The bot is not an administrator of this channel.", { bot: botInfo, chat: info });
  }
  const rights = Object.fromEntries(TELEGRAM_RIGHTS.map((r) => [r, isCreator || member[r] === true])) as Record<TelegramRight, boolean>;
  const missing = TELEGRAM_RIGHTS.filter((r) => !rights[r]);
  let members: number | null = null;
  try {
    members = await bot.getChatMemberCount(info.id);
  } catch {
    members = null;
  }
  const extra = { bot: botInfo, chat: info, rights: { ...rights, is_creator: isCreator }, members, missing };
  if (missing.length) {
    return fail(`missing_right:${missing[0]}`, `The bot is an administrator but lacks: ${missing.join(", ")}.`, extra);
  }
  return { ok: true, message: `@${botInfo.username ?? "bot"} manages ${info.title ?? info.id}.`, ...extra };
}

export type TelegramChannelCredentials = { botToken: string; chatId: string };

/** The address a proposal's change points at: "tg:<chat id>". */
export function telegramTarget(chatId: string | number): string {
  return `tg:${chatId}`;
}

const FIELD_ACTION: Record<string, FixAction> = { title: "SOCIAL_TITLE", description: "SOCIAL_DESCRIPTION" };

/** Title and description as a Connector for the fix executor. */
export function telegramChannel(creds: TelegramChannelCredentials): Connector {
  const bot = telegramBot(creds.botToken);
  let cachedCheck: Promise<TelegramCheck> | null = null;
  const check = () => (cachedCheck ??= checkTelegramChannel(creds.botToken, creds.chatId));

  function assertTarget(url: string, field: string): void {
    if (url !== telegramTarget(creds.chatId)) {
      throw new ConnectorError("wrong_target", "This change is for a different Telegram channel");
    }
    if (!(field in FIELD_ACTION)) throw new ConnectorError("unsupported_field", `Telegram cannot write "${field}"`);
  }

  async function capabilities(): Promise<ConnectorCapabilities> {
    const c = await check();
    const canChange = Boolean(c.rights?.can_change_info);
    return {
      writableFields: canChange ? ["title", "description"] : [],
      supportedActions: canChange ? ["SOCIAL_TITLE", "SOCIAL_DESCRIPTION"] : [],
      notes: canChange
        ? ["The channel's @username cannot be changed by a bot; change it in Telegram."]
        : ["The bot lacks the can_change_info right, so title and description changes cannot be applied."],
    };
  }

  async function read(req: Pick<WriteRequest, "url" | "field">): Promise<string | null> {
    assertTarget(req.url, req.field);
    const chat = await bot.getChat(creds.chatId);
    const value = req.field === "title" ? chat.title : chat.description;
    return value && value.length ? value : null;
  }

  async function write(req: WriteRequest): Promise<WriteResult> {
    const base = { url: req.url, field: req.field };
    try {
      assertTarget(req.url, req.field);
      const value = req.after ?? "";
      if (req.field === "title") {
        if (!value.trim()) return { ...base, ok: false, code: "invalid_value", error: "A channel title cannot be empty" };
        if ([...value].length > TELEGRAM_TITLE_MAX) return { ...base, ok: false, code: "too_long", error: `Titles are at most ${TELEGRAM_TITLE_MAX} characters` };
        await notModifiedIsOk(() => bot.setChatTitle(creds.chatId, value));
      } else {
        if ([...value].length > TELEGRAM_DESCRIPTION_MAX) {
          return { ...base, ok: false, code: "too_long", error: `Descriptions are at most ${TELEGRAM_DESCRIPTION_MAX} characters` };
        }
        await notModifiedIsOk(() => bot.setChatDescription(creds.chatId, value));
      }
      const applied = await read(req);
      return { ...base, ok: true, applied };
    } catch (err) {
      const e = err as ConnectorError;
      return { ...base, ok: false, code: e.code ?? "error", error: e.message };
    }
  }

  async function healthCheck(): Promise<ConnectorHealth & { capabilities?: ConnectorCapabilities }> {
    cachedCheck = null;
    const c = await check();
    return { ok: c.ok, reason: c.reason, message: c.message, capabilities: await capabilities() };
  }

  return { kind: "TELEGRAM", check: healthCheck, capabilities, read, write };
}

/** Writing the value a field already holds is an error in the Bot API and a no-op for us. */
async function notModifiedIsOk(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TelegramError && /not modified/i.test(err.message)) return;
    throw err;
  }
}

/** The public link of a channel message; private channels use the /c/ form members can open. */
export function telegramMessageLink(chat: { id: number | string; username?: string | null }, messageId: number): string {
  if (chat.username) return `https://t.me/${chat.username.replace(/^@/, "")}/${messageId}`;
  return `https://t.me/c/${String(chat.id).replace(/^-100/, "")}/${messageId}`;
}
