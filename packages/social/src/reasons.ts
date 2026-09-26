/**
 * Every machine reason the social features report, in both languages, so the
 * panel never shows a raw code or an English API message on a Persian page.
 */
import type { LocalizedText } from "@seo/db";

const TEXT: Record<string, LocalizedText> = {
  not_configured: {
    fa: "برنامهٔ اینستاگرام (Meta) هنوز روی این سرور تنظیم نشده است؛ تا تنظیم نشود هیچ داده‌ای نمایش داده نمی‌شود.",
    en: "No Instagram (Meta) app is configured on this server yet; nothing is shown until it is.",
  },
  not_connected: { fa: "حساب هنوز وصل نشده است.", en: "The account is not connected yet." },
  invalid_token: { fa: "توکن معتبر نیست یا باطل شده است؛ دوباره وصل کنید.", en: "The token is invalid or was revoked; connect again." },
  token_expired: { fa: "توکن اینستاگرام منقضی شده است؛ دوباره وصل کنید.", en: "The Instagram token has expired; connect again." },
  chat_not_found: {
    fa: "ربات این کانال را پیدا نمی‌کند؛ نام کاربری یا شناسه را بررسی کنید و ربات را مدیر کانال کنید.",
    en: "The bot cannot find this channel; check the @username or id and make the bot an administrator.",
  },
  not_a_channel: { fa: "این گفتگو کانال نیست (گروه یا گفتگوی خصوصی است).", en: "This chat is not a channel (it is a group or a private chat)." },
  not_admin: { fa: "ربات مدیر این کانال نیست؛ آن را با دسترسی‌های لازم مدیر کنید.", en: "The bot is not an administrator of this channel; add it with the rights needed." },
  "missing_right:can_post_messages": { fa: "ربات اجازهٔ «ارسال پیام» ندارد.", en: "The bot lacks the “Post messages” right." },
  "missing_right:can_edit_messages": { fa: "ربات اجازهٔ «ویرایش پیام‌های دیگران» ندارد.", en: "The bot lacks the “Edit messages of others” right." },
  "missing_right:can_change_info": { fa: "ربات اجازهٔ «تغییر اطلاعات کانال» ندارد.", en: "The bot lacks the “Change channel info” right." },
  network_error: { fa: "سرویس در دسترس نبود؛ کمی بعد دوباره تلاش کنید.", en: "The service could not be reached; try again shortly." },
  rate_limited: { fa: "سقف درخواست‌های پلتفرم پر شده است؛ بعداً دوباره تلاش می‌شود.", en: "The platform's rate limit was reached; it will be retried later." },
  api_unavailable: { fa: "پلتفرم موقتاً پاسخ نداد.", en: "The platform did not answer for now." },
  permission_denied: { fa: "این مجوز به برنامه داده نشده است؛ دوباره وصل کنید و همهٔ مجوزها را بپذیرید.", en: "The app was not granted this permission; reconnect and accept every permission." },
  unsupported: {
    fa: "این قابلیت با ورود از طریق اینستاگرام در دسترس نیست (فقط با ورود فیسبوک).",
    en: "This is not available with Instagram Login (only with Facebook Login).",
  },
  not_found: { fa: "این حساب پیدا نشد یا حرفه‌ای (بیزینس/کریتور) نیست.", en: "This account was not found or is not a Business/Creator account." },
  no_public_preview: {
    fa: "این کانال پیش‌نمایش عمومی ندارد (خصوصی است)؛ آمار بازدید در دسترس نیست.",
    en: "This channel has no public preview (it is private); view counts are not available.",
  },
  invalid_username: { fa: "نام کاربری معتبر نیست.", en: "Not a valid username." },
  publish_limit_reached: {
    fa: "سقف ۱۰۰ انتشار در ۲۴ ساعت اینستاگرام پر شده است؛ بعداً دوباره تلاش می‌شود.",
    en: "Instagram's limit of 100 published posts per 24 hours is reached; it will be retried later.",
  },
  media_unreachable: { fa: "پلتفرم نتوانست فایل رسانه را از آدرس داده‌شده دریافت کند.", en: "The platform could not fetch the media from the given address." },
  invalid_html: { fa: "قالب‌بندی متن برای تلگرام معتبر نیست.", en: "The text's formatting is not valid for Telegram." },
  message_not_found: { fa: "پیام موردنظر در کانال پیدا نشد.", en: "That message was not found in the channel." },
  container_error: { fa: "اینستاگرام پردازش رسانه را رد کرد (قالب یا اندازهٔ فایل را بررسی کنید).", en: "Instagram rejected the media (check the file's format and size)." },
  container_timeout: { fa: "پردازش ویدیو در اینستاگرام بیش از حد طول کشید.", en: "Instagram took too long to process the video." },
  outcome_unknown: {
    fa: "معلوم نیست پست منتشر شد یا نه (ارتباط وسط انتشار قطع شد)؛ برای جلوگیری از انتشار تکراری دوباره ارسال نشد. کانال/صفحه را بررسی کنید.",
    en: "It is unknown whether the post went out (the connection dropped mid-publish); it was not re-sent to avoid a duplicate. Check the channel/page.",
  },
  bad_request: { fa: "پلتفرم درخواست را نپذیرفت.", en: "The platform refused the request." },
  api_error: { fa: "پلتفرم خطا داد.", en: "The platform returned an error." },
  invalid_parameter: { fa: "پلتفرم یکی از مقادیر را نپذیرفت.", en: "The platform refused one of the values." },
  token_exchange_failed: { fa: "دریافت توکن از اینستاگرام ناموفق بود.", en: "Getting a token from Instagram failed." },
  personal_account: {
    fa: "این حساب شخصی است؛ در اپ اینستاگرام آن را به حساب حرفه‌ای (بیزینس یا کریتور) تبدیل کنید.",
    en: "This is a personal account; switch it to a professional (Business or Creator) account in the Instagram app.",
  },
  wrong_platform: { fa: "این پروژه برای این پلتفرم نیست.", en: "This project is not for this platform." },
  state_invalid: { fa: "درخواست اتصال منقضی یا نامعتبر است؛ دوباره از پنل شروع کنید.", en: "The connection request expired or is invalid; start again from the panel." },
  access_denied: { fa: "اجازهٔ دسترسی در اینستاگرام داده نشد.", en: "Access was not granted in Instagram." },
  webhook_failed: { fa: "ثبت وبهوک تلگرام ناموفق بود؛ پست‌های جدید در همگام‌سازی بعدی خوانده می‌شوند.", en: "Registering the Telegram webhook failed; new posts are read on the next sync." },
};

/** Every reason with its own wording, for screens that translate codes they receive later (a failed post's error). */
export const SOCIAL_REASON_CODES: readonly string[] = Object.keys(TEXT);

export function socialReasonText(reason: string | null | undefined): LocalizedText | null {
  if (!reason) return null;
  if (TEXT[reason]) return TEXT[reason]!;
  if (reason.startsWith("missing_right:")) {
    const right = reason.slice("missing_right:".length);
    return { fa: `ربات این دسترسی را ندارد: ${right}`, en: `The bot lacks this right: ${right}` };
  }
  return { fa: "خطای ناشناخته از پلتفرم.", en: "An unrecognised error from the platform." };
}
