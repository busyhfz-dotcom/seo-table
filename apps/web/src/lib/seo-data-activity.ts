/**
 * Audit-log sentences for the SEO data actions (keywords, rank, PageSpeed,
 * competitors, schedules, alerts, integrations), in both languages. Returns
 * null for anything else so activity.ts can fall through.
 */
import { num } from "./format";
import type { Locale } from "./i18n";

const INTEGRATION: Record<string, { fa: string; en: string }> = {
  DATAFORSEO: { fa: "DataForSEO", en: "DataForSEO" },
  PAGESPEED: { fa: "کلید PageSpeed", en: "PageSpeed key" },
  TELEGRAM_ALERTS: { fa: "هشدار تلگرام", en: "Telegram alerts" },
};

const SCHEDULE: Record<string, { fa: string; en: string }> = {
  scan: { fa: "اسکن", en: "scan" },
  rank: { fa: "رتبه", en: "rank tracking" },
  pagespeed: { fa: "سرعت صفحه", en: "PageSpeed" },
  competitors: { fa: "رقبا", en: "competitors" },
  report: { fa: "گزارش", en: "report" },
  social_sync: { fa: "همگام‌سازی صفحه", en: "profile sync" },
};

const ALERT: Record<string, { fa: string; en: string }> = {
  score_drop: { fa: "افت امتیاز", en: "score drop" },
  new_critical: { fa: "مشکل بحرانی تازه", en: "new critical issues" },
  rank_drop: { fa: "افت رتبه", en: "rank drop" },
  page_down: { fa: "از دسترس خارج شدن سایت", en: "site down" },
  cwv_regression: { fa: "افت سرعت", en: "speed regression" },
  index_drop: { fa: "کاهش صفحات ایندکس‌شده", en: "indexed pages drop" },
  follower_drop: { fa: "افت دنبال‌کننده", en: "follower drop" },
  engagement_drop: { fa: "افت تعامل", en: "engagement drop" },
  token_expiring: { fa: "انقضای اتصال اینستاگرام", en: "Instagram connection expiring" },
  publish_failed: { fa: "انتشار ناموفق پست", en: "failed post" },
};

const PLATFORM: Record<string, { fa: string; en: string }> = {
  INSTAGRAM: { fa: "اینستاگرام", en: "Instagram" },
  TELEGRAM: { fa: "کانال تلگرام", en: "Telegram channel" },
};

export function describeSeoDataAction(action: string, metadata: unknown, locale: Locale): string | null {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const fa = locale === "fa";
  const n = (v: unknown) => num(Number(v ?? 0), locale);
  const pick = (table: Record<string, { fa: string; en: string }>, key: unknown, fallback: { fa: string; en: string }) =>
    (table[String(key ?? "")] ?? fallback)[locale];
  const integration = pick(INTEGRATION, m.kind, { fa: "سرویس", en: "integration" });
  const cost = typeof m.cost === "number" ? (fa ? ` (هزینه: ${num(m.cost, locale)} دلار)` : ` (cost: $${m.cost})`) : "";
  switch (action) {
    case "keyword.add":
      return fa ? `${n(m.added)} کلمهٔ کلیدی افزوده شد` : `${n(m.added)} keywords added`;
    case "keyword.update":
      return fa ? "کلمهٔ کلیدی ویرایش شد" : "Keyword updated";
    case "keyword.archive":
      return fa ? "کلمهٔ کلیدی بایگانی شد" : "Keyword archived";
    case "keyword.delete":
      return fa ? "کلمهٔ کلیدی حذف شد" : "Keyword deleted";
    case "keyword.research":
      return (fa ? "تحقیق کلمهٔ کلیدی با DataForSEO" : "Keyword research with DataForSEO") + cost;
    case "rank.sync":
      return fa ? "همگام‌سازی رتبه‌ها درخواست شد" : "Rank sync requested";
    case "pagespeed.run":
      return fa ? "سنجش سرعت صفحه درخواست شد" : "PageSpeed run requested";
    case "competitor.add":
      return fa ? "رقیب افزوده شد" : "Competitor added";
    case "competitor.update":
      return fa ? "رقیب ویرایش شد" : "Competitor updated";
    case "competitor.delete":
      return fa ? "رقیب حذف شد" : "Competitor removed";
    case "competitor.analyze":
      return fa ? "تحلیل رقبا درخواست شد" : "Competitor analysis requested";
    case "competitor.keyword_gap":
      return (fa ? "شکاف کلمات کلیدی با رقیب" : "Keyword gap against a competitor") + cost;
    case "schedule.update":
      return fa ? `زمان‌بندی ${pick(SCHEDULE, m.kind, { fa: "کار", en: "" })} تغییر کرد` : `${pick(SCHEDULE, m.kind, { fa: "", en: "Task" })} schedule changed`;
    case "alert.create":
      return fa ? `هشدار «${pick(ALERT, m.kind, { fa: "تازه", en: "" })}» ساخته شد` : `Alert "${pick(ALERT, m.kind, { fa: "", en: "new" })}" created`;
    case "alert.update":
      return fa ? "هشدار ویرایش شد" : "Alert updated";
    case "alert.delete":
      return fa ? "هشدار حذف شد" : "Alert deleted";
    case "alert.test":
      return fa ? "پیام آزمایشی هشدار ارسال شد" : "Alert test sent";
    case "integration.connect":
      if (m.ok === false) return fa ? `اتصال ${integration} ناموفق بود` : `${integration} connection failed`;
      return fa ? `${integration} تنظیم شد` : `${integration} configured`;
    case "integration.disconnect":
      return fa ? `${integration} حذف شد` : `${integration} removed`;
    case "content.create":
      return fa ? "سند محتوایی ساخته شد" : "Content document created";
    case "content.update":
      return fa ? "سند محتوایی ویرایش شد" : "Content document edited";
    case "content.delete":
      return fa ? "سند محتوایی حذف شد" : "Content document deleted";
    case "content.import":
      return fa ? "صفحه‌ای از سایت به ویرایشگر محتوا وارد شد" : "A site page was imported into the content editor";
    case "content.publish_request":
      return fa ? "درخواست انتشار در وردپرس ثبت شد" : "Publishing to WordPress was requested";
    case "content.publish":
      return m.status === "failed" ? (fa ? "انتشار در وردپرس تأیید شد اما ناموفق بود" : "Publishing to WordPress was approved but failed") : fa ? "انتشار در وردپرس تأیید و انجام شد" : "Publishing to WordPress was approved and done";
    case "content.publish_reject":
      return fa ? "درخواست انتشار در وردپرس رد شد" : "Publishing to WordPress was rejected";
    case "content.publish_rollback":
      return fa ? "انتشار در وردپرس برگردانده شد" : "Publishing to WordPress was rolled back";
    case "schema.propose":
      return fa ? "نشانه‌گذاری ساختاریافته برای تأیید پیشنهاد شد" : "Structured data proposed for approval";
    case "robots.propose":
      return fa ? "robots.txt تازه برای تأیید پیشنهاد شد" : "A new robots.txt was proposed for approval";
    case "sitemap.propose":
      return fa ? `نقشهٔ سایت با ${n(m.urls)} نشانی برای تأیید پیشنهاد شد` : `A sitemap with ${n(m.urls)} URLs was proposed for approval`;
    case "report.create":
      return fa ? "ساخت گزارش PDF درخواست شد" : "A PDF report was requested";
    case "report.delete":
      return fa ? "گزارش حذف شد" : "Report deleted";
    case "social.oauth_start":
      return fa ? "اتصال اینستاگرام آغاز شد" : "Instagram connection started";
    case "social.connect":
      return fa ? `${pick(PLATFORM, m.platform, { fa: "حساب", en: "Account" })} وصل شد` : `${pick(PLATFORM, m.platform, { fa: "حساب", en: "Account" })} connected`;
    case "social.connect_failed":
      return fa ? `اتصال ${pick(PLATFORM, m.platform, { fa: "حساب", en: "account" })} ناموفق بود` : `Connecting the ${pick(PLATFORM, m.platform, { fa: "حساب", en: "account" })} failed`;
    case "social.disconnect":
      return fa ? `اتصال ${pick(PLATFORM, m.platform, { fa: "حساب", en: "account" })} قطع شد` : `${pick(PLATFORM, m.platform, { fa: "حساب", en: "Account" })} disconnected`;
    case "social.check":
      return m.ok === false ? (fa ? "بررسی اتصال ناموفق بود" : "Connection check failed") : fa ? "اتصال بررسی شد" : "Connection checked";
    case "social.sync":
      return m.queued ? (fa ? "همگام‌سازی درخواست شد" : "Sync requested") : m.ok === false ? (fa ? "همگام‌سازی ناموفق بود" : "Sync failed") : fa ? `همگام‌سازی انجام شد (${n(m.posts)} پست)` : `Synced (${n(m.posts)} posts)`;
    case "social.audit":
      return fa ? `ممیزی صفحه انجام شد (امتیاز ${n(m.score)})` : `Profile audited (score ${n(m.score)})`;
    case "social.settings_update":
      return fa ? "کلیدواژه‌ها و تنظیمات صفحه تغییر کرد" : "Profile keywords and settings changed";
    case "social.token_refresh":
      return fa ? "اتصال اینستاگرام تمدید شد" : "Instagram connection renewed";
    case "social.competitor_add":
      return fa ? "رقیب تازه اضافه شد" : "Competitor added";
    case "social.competitor_delete":
      return fa ? "رقیب حذف شد" : "Competitor removed";
    case "social.competitor_refresh":
      return fa ? "آمار رقبا به‌روز شد" : "Competitors refreshed";
    case "social.post_create":
      return fa ? "پیش‌نویس پست ساخته شد" : "Post drafted";
    case "social.post_update":
      return fa ? "پست برنامه‌ریزی‌شده ویرایش شد" : "Planned post edited";
    case "social.post_submit":
      return fa ? "پست برای تأیید فرستاده شد" : "Post submitted for approval";
    case "social.post_approve":
      return fa ? "انتشار پست تأیید شد" : "Post approved for publishing";
    case "social.post_reject":
      return fa ? "انتشار پست رد شد" : "Post rejected";
    case "social.post_cancel":
      return fa ? "پست لغو شد" : "Post canceled";
    case "social.post_publish_now":
      return fa ? "انتشار فوری پست درخواست شد" : "Immediate publishing requested";
    case "social.post_published":
      return fa ? "پست منتشر شد" : "Post published";
    case "social.post_failed":
      return fa ? "انتشار پست ناموفق بود" : "Post could not be published";
    case "report.brand_update":
      return fa ? "نشان تجاری گزارش‌ها تغییر کرد" : "Report branding changed";
    case "integration.test":
      return m.ok === false ? (fa ? `آزمون ${integration} ناموفق بود` : `${integration} test failed`) : fa ? `${integration} آزموده شد` : `${integration} tested`;
    default:
      return null;
  }
}
