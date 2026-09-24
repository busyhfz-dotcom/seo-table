/**
 * Telegram webhook: channel posts pushed by Telegram as they are published.
 *
 * Telegram sends the secret_token we registered in X-Telegram-Bot-Api-Secret-Token;
 * a request without the right one is refused before its body is read. One bot
 * can manage several channels (one webhook per bot), so an update is filed
 * under whichever connected channel of that same bot it belongs to.
 */
import { and, db, eq, socialAccounts, sql } from "@seo/db";
import type { TgMessage, TgUpdate } from "@seo/connectors";
import { verifyWebhookSecret } from "./accounts.js";
import { ingestTelegramMessages } from "./sync.js";

export async function handleTelegramWebhook(
  accountId: string,
  secretHeader: string | null,
  update: unknown,
): Promise<{ accepted: boolean; ingested: number }> {
  if (!verifyWebhookSecret(accountId, secretHeader)) return { accepted: false, ingested: 0 };
  const account = (await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1))[0];
  if (!account || account.platform !== "TELEGRAM" || account.status === "NOT_CONNECTED") return { accepted: true, ingested: 0 };
  const u = update as TgUpdate;
  const message: TgMessage | undefined = u?.channel_post ?? u?.edited_channel_post;
  if (!message?.chat || typeof message.message_id !== "number") return { accepted: true, ingested: 0 };
  const chatId = String(message.chat.id);
  const target =
    chatId === account.externalId
      ? account
      : (
          await db
            .select()
            .from(socialAccounts)
            .where(
              and(
                eq(socialAccounts.platform, "TELEGRAM"),
                eq(socialAccounts.externalId, chatId),
                sql`${socialAccounts.profile}->>'botId' = ${String(account.profile.botId ?? "")}`,
              ),
            )
            .limit(1)
        )[0];
  if (!target || target.status === "NOT_CONNECTED") return { accepted: true, ingested: 0 };
  return { accepted: true, ingested: await ingestTelegramMessages(target, [message]) };
}
