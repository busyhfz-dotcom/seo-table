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
};

const ALERT: Record<string, { fa: string; en: string }> = {
  score_drop: { fa: "افت امتیاز", en: "score drop" },
  new_critical: { fa: "مشکل بحرانی تازه", en: "new critical issues" },
  rank_drop: { fa: "افت رتبه", en: "rank drop" },
  page_down: { fa: "از دسترس خارج شدن سایت", en: "site down" },
  cwv_regression: { fa: "افت سرعت", en: "speed regression" },
  index_drop: { fa: "کاهش صفحات ایندکس‌شده", en: "indexed pages drop" },
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
    case "integration.test":
      return m.ok === false ? (fa ? `آزمون ${integration} ناموفق بود` : `${integration} test failed`) : fa ? `${integration} آزموده شد` : `${integration} tested`;
    default:
      return null;
  }
}
