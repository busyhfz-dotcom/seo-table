/**
 * Telegram Bot API for alert delivery: getMe to validate a token, getChat to
 * confirm the bot can reach the chat, sendMessage to deliver.
 *
 * The bot token is part of every URL, so no error from here may carry a URL or
 * the raw fetch message: they are rebuilt from Telegram's own description.
 */
import { fetchJson, ProviderError } from "../http.js";
import type { ProviderCheck } from "./types.js";

export const TELEGRAM_API = "https://api.telegram.org";

export type TelegramCredentials = { botToken: string };

export const TELEGRAM_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

type TgResponse<T> = { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };

function reasonFor(status: number, description: string): string {
  if (status === 401 || status === 404) return "invalid_credentials";
  if (status === 429) return "rate_limited";
  if (/chat not found/i.test(description)) return "chat_not_found";
  if (status === 403) return "bot_blocked";
  return "provider_error";
}

export type TelegramClient = {
  check(chatId: string): Promise<ProviderCheck>;
  send(chatId: string, html: string): Promise<void>;
};

export function telegram(creds: TelegramCredentials, opts: { baseUrl?: string } = {}): TelegramClient {
  const base = (opts.baseUrl ?? TELEGRAM_API).replace(/\/$/, "");

  async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    let res;
    try {
      res = await fetchJson<TgResponse<T>>(`${base}/bot${creds.botToken}/${method}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: 20_000,
        maxBytes: 512 * 1024,
      });
    } catch (err) {
      const reason = err instanceof ProviderError ? err.reason : "network_error";
      throw new ProviderError(reason, `Telegram ${method} could not be reached`);
    }
    if (res.status >= 400 || !res.data?.ok) {
      const description = res.data?.description ?? `HTTP ${res.status}`;
      throw new ProviderError(reasonFor(res.status, description), `Telegram ${method}: ${description}`, {
        status: res.status,
        retryAfter: res.data?.parameters?.retry_after ?? null,
      });
    }
    return res.data.result as T;
  }

  return {
    async check(chatId) {
      try {
        const me = await call<{ username?: string; first_name?: string }>("getMe");
        const chat = await call<{ id?: number; title?: string; username?: string; type?: string }>("getChat", { chat_id: chatId });
        return {
          ok: true,
          message: `Bot @${me.username ?? "?"} can post to ${chat.title ?? chat.username ?? chatId}.`,
          detail: { botUsername: me.username ?? null, chatTitle: chat.title ?? chat.username ?? null, chatType: chat.type ?? null },
        };
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, reason: err.reason, message: err.message };
        return { ok: false, reason: "network_error", message: "Telegram could not be reached" };
      }
    },
    async send(chatId, html) {
      await call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
    },
  };
}
