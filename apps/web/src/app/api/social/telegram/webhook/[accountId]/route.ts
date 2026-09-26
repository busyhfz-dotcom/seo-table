import { NextResponse, type NextRequest } from "next/server";
import { childLogger } from "@seo/core";
import { handleTelegramWebhook } from "@seo/social";

/**
 * Telegram's webhook for a connected channel's bot (channel_post and
 * edited_channel_post). Not a session route: Telegram proves itself with the
 * secret_token registered for this account, sent in
 * X-Telegram-Bot-Api-Secret-Token and compared in constant time. A wrong or
 * missing secret is a 401 and the body is never parsed. Any other problem is
 * answered 200 so Telegram does not retry a message we will never accept.
 */
const MAX_BODY = 256 * 1024;

export async function POST(req: NextRequest, context: { params: Promise<{ accountId: string }> }): Promise<NextResponse> {
  const { accountId } = await context.params;
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!/^[a-z0-9]{10,40}$/.test(accountId) || !secret) return NextResponse.json({ ok: false }, { status: 401 });
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return NextResponse.json({ ok: false }, { status: 413 });
  // Verified before parsing: the check needs only the id and the header.
  const probe = await handleTelegramWebhook(accountId, secret, null);
  if (!probe.accepted) return NextResponse.json({ ok: false }, { status: 401 });
  let update: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return NextResponse.json({ ok: false }, { status: 413 });
    update = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: true });
  }
  try {
    const result = await handleTelegramWebhook(accountId, secret, update);
    return NextResponse.json({ ok: true, ingested: result.ingested });
  } catch (err) {
    childLogger({ component: "telegram-webhook" }).error({ accountId, err: (err as Error).message }, "webhook update not stored");
    return NextResponse.json({ ok: true });
  }
}
