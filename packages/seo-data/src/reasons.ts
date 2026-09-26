/**
 * The machine reasons a provider or integration can fail with, in both
 * languages, so every API response can carry text the panel shows as-is.
 */
import type { LocalizedText } from "@seo/db";

const REASONS: Record<string, LocalizedText> = {
  invalid_credentials: {
    fa: "اطلاعات ورود نادرست است. نام کاربری/رمز یا توکن را دوباره بررسی کنید.",
    en: "The credentials were rejected. Check the login/password or token.",
  },
  insufficient_funds: {
    fa: "موجودی حساب کافی نیست. حساب را شارژ کنید.",
    en: "The account balance is too low. Top it up to continue.",
  },
  access_denied: {
    fa: "این حساب به این سرویس دسترسی ندارد (اشتراک لازم فعال نیست).",
    en: "This account has no access to that service (the subscription it needs is not active).",
  },
  rate_limited: {
    fa: "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره امتحان کنید.",
    en: "Too many requests to the provider. Try again shortly.",
  },
  quota_exceeded: {
    fa: "سهمیهٔ روزانهٔ API تمام شده است. کلید API اختصاصی سهمیه را بالا می‌برد.",
    en: "The API quota is used up. An API key of your own raises it.",
  },
  location_unsupported: {
    fa: "این سرویس برای این کشور/زبان داده ندارد (مثلاً سامانه‌ی تبلیغات گوگل برای ایران حجم جست‌وجو ارائه نمی‌دهد).",
    en: "The provider has no data for this country/language (Google Ads, for example, does not serve Iran).",
  },
  invalid_request: { fa: "درخواست توسط سرویس پذیرفته نشد.", en: "The provider refused the request." },
  page_unreachable: {
    fa: "PageSpeed نتوانست صفحه را باز کند (خطای شبکه، DNS یا پاسخ نامعتبر).",
    en: "PageSpeed could not load the page (network, DNS or an invalid response).",
  },
  chat_not_found: {
    fa: "چت پیدا نشد. ربات را به گروه/کانال اضافه کنید و شناسهٔ چت را بررسی کنید.",
    en: "Chat not found. Add the bot to the group/channel and check the chat id.",
  },
  bot_blocked: {
    fa: "ربات اجازهٔ ارسال پیام به این چت را ندارد.",
    en: "The bot is not allowed to post to this chat.",
  },
  blocked_address: {
    fa: "این نشانی به شبکهٔ داخلی اشاره می‌کند و مجاز نیست.",
    en: "That address points to a private network and is not allowed.",
  },
  webhook_rejected: {
    fa: "نشانی وب‌هوک پیام را نپذیرفت (پاسخ موفق برنگرداند).",
    en: "The webhook endpoint did not accept the message (non-2xx answer).",
  },
  network_error: { fa: "سرویس در دسترس نبود.", en: "The service could not be reached." },
  redirected: { fa: "سرویس به نشانی دیگری هدایت کرد.", en: "The service answered with a redirect." },
  response_too_large: { fa: "پاسخ سرویس بیش از حد بزرگ بود.", en: "The service's response was too large." },
  provider_error: { fa: "سرویس خطا برگرداند.", en: "The provider returned an error." },
  not_configured: { fa: "این سرویس هنوز تنظیم نشده است.", en: "This service is not configured yet." },
};

export function reasonText(reason: string | null | undefined): LocalizedText | null {
  if (!reason) return null;
  return REASONS[reason] ?? REASONS.provider_error!;
}
