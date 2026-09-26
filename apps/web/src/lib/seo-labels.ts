/**
 * Wording for the machine values of the SEO data features (alert kinds,
 * schedules, Core Web Vitals ratings, Lighthouse audits, sitemap problems, SERP
 * features, schema types). Client-safe: no server imports.
 *
 * A value missing from a table is shown as code (left-to-right, monospace)
 * rather than guessed at, so an unknown Lighthouse audit never passes itself off
 * as translated text.
 */
import type { Locale } from "./i18n";

export type Pair = { fa: string; en: string };

export function pickLabel(table: Record<string, Pair>, key: string | null | undefined, locale: Locale): string | null {
  if (!key) return null;
  return table[key]?.[locale] ?? null;
}

export const ALERT_KIND_LABELS: Record<string, Pair> = {
  score_drop: { fa: "افت امتیاز سایت", en: "Site score drop" },
  new_critical: { fa: "مشکل بحرانی تازه", en: "New critical issues" },
  rank_drop: { fa: "افت رتبه‌ی کلمه‌ی کلیدی", en: "Keyword rank drop" },
  page_down: { fa: "از دسترس خارج شدن سایت", en: "Site down" },
  cwv_regression: { fa: "افت سرعت صفحه", en: "Page speed regression" },
  index_drop: { fa: "کاهش صفحات دیده‌شده در گوگل", en: "Fewer pages seen in Google" },
  follower_drop: { fa: "افت دنبال‌کننده یا عضو", en: "Follower or member drop" },
  engagement_drop: { fa: "افت تعامل یا نرخ بازدید", en: "Engagement or view-rate drop" },
  token_expiring: { fa: "نزدیک شدن انقضای اتصال اینستاگرام", en: "Instagram connection expiring" },
  publish_failed: { fa: "انتشار ناموفق پست", en: "Post failed to publish" },
};

export const ALERT_KIND_HELP: Record<string, Pair> = {
  follower_drop: {
    fa: "وقتی تعداد دنبال‌کنندگان یا اعضا نسبت به هفت روز قبل دست‌کم به اندازه‌ی آستانه (درصد) کم شود.",
    en: "When followers or members fall by at least the threshold (percent) against seven days earlier.",
  },
  engagement_drop: {
    fa: "وقتی نرخ تعامل (اینستاگرام) یا نرخ بازدید (تلگرام) ۱۰ پست اخیر دست‌کم به اندازه‌ی آستانه (درصد) از ۱۰ پست قبل کمتر باشد.",
    en: "When the engagement rate (Instagram) or view rate (Telegram) of the last 10 posts is at least the threshold (percent) below the 10 before.",
  },
  token_expiring: {
    fa: "وقتی اتصال اینستاگرام در کمتر از آستانه (روز) منقضی می‌شود و تمدید خودکار نشده است؛ باید دوباره وصل کنید.",
    en: "When the Instagram connection expires within the threshold (days) and could not be renewed automatically; reconnect it.",
  },
  publish_failed: {
    fa: "وقتی پست برنامه‌ریزی‌شده‌ای منتشر نشود یا معلوم نباشد منتشر شده است یا نه.",
    en: "When a planned post could not be published, or it is unknown whether it went out.",
  },
  score_drop: {
    fa: "وقتی امتیاز سایت نسبت به اسکن موفق قبلی دست‌کم به اندازه‌ی آستانه (امتیاز) کم شود.",
    en: "When the site score falls by at least the threshold (points) since the previous successful scan.",
  },
  new_critical: {
    fa: "وقتی اسکنی مشکل بحرانی تازه‌ای پیدا کند (در اولین اسکن هشدار نمی‌دهد).",
    en: "When a scan finds a critical issue it had not seen before (not on a first scan).",
  },
  rank_drop: {
    fa: "وقتی میانگین جایگاه یک کلمه‌ی ردیابی‌شده در ۷ روز اخیر نسبت به ۷ روز قبل دست‌کم به اندازه‌ی آستانه (جایگاه) بدتر شود.",
    en: "When a tracked keyword's average position over the last 7 days is worse by at least the threshold (positions) than the 7 before.",
  },
  page_down: {
    fa: "وقتی صفحه‌ی اصلی سایت باز نشود یا با خطای سرور، ۴۰۴ یا ۴۱۰ پاسخ دهد.",
    en: "When the homepage cannot be reached or answers 5xx, 404 or 410.",
  },
  cwv_regression: {
    fa: "وقتی امتیاز عملکرد صفحه‌ای دست‌کم به اندازه‌ی آستانه (امتیاز) کم شود یا Core Web Vitals از قبولی به ردی برسد.",
    en: "When a page loses at least the threshold (points) of performance score, or Core Web Vitals go from pass to fail.",
  },
  index_drop: {
    fa: "وقتی تعداد صفحاتی که در Search Console نمایش گرفته‌اند در ۷ روز اخیر دست‌کم به اندازه‌ی آستانه (درصد) کمتر شود.",
    en: "When the number of pages with Search Console impressions over the last 7 days falls by at least the threshold (percent).",
  },
};

/** The unit a kind's threshold is measured in; null = the kind has no threshold. */
export const ALERT_THRESHOLD_UNIT: Record<string, Pair | null> = {
  score_drop: { fa: "امتیاز", en: "points" },
  new_critical: null,
  rank_drop: { fa: "جایگاه", en: "positions" },
  page_down: null,
  cwv_regression: { fa: "امتیاز", en: "points" },
  index_drop: { fa: "درصد", en: "percent" },
  follower_drop: { fa: "درصد", en: "percent" },
  engagement_drop: { fa: "درصد", en: "percent" },
  token_expiring: { fa: "روز", en: "days" },
  publish_failed: null,
};

export const CHANNEL_LABELS: Record<string, Pair> = {
  in_app: { fa: "داخل پنل", en: "In the panel" },
  webhook: { fa: "وب‌هوک", en: "Webhook" },
  telegram: { fa: "تلگرام", en: "Telegram" },
};

export const SCHEDULE_KIND_LABELS: Record<string, Pair> = {
  scan: { fa: "اسکن سایت", en: "Site scan" },
  rank: { fa: "به‌روزرسانی رتبه‌ها", en: "Rank update" },
  pagespeed: { fa: "سنجش سرعت صفحه", en: "Page speed check" },
  competitors: { fa: "تحلیل رقبا", en: "Competitor analysis" },
  report: { fa: "گزارش مدیریتی PDF", en: "Executive PDF report" },
  social_sync: { fa: "همگام‌سازی صفحه و ممیزی", en: "Profile sync and audit" },
};

export const CWV_RATING: Record<string, Pair & { tone: string }> = {
  good: { fa: "خوب", en: "Good", tone: "ok" },
  needs_improvement: { fa: "نیازمند بهبود", en: "Needs improvement", tone: "warn" },
  poor: { fa: "ضعیف", en: "Poor", tone: "crit" },
};

/** Lighthouse audits that PageSpeed reports as opportunities (classic ids and v12 insights). */
export const LIGHTHOUSE_AUDITS: Record<string, Pair> = {
  "render-blocking-resources": { fa: "حذف منابعی که نمایش صفحه را متوقف می‌کنند", en: "Eliminate render-blocking resources" },
  "render-blocking-insight": { fa: "درخواست‌هایی که نمایش صفحه را متوقف می‌کنند", en: "Render-blocking requests" },
  "unused-css-rules": { fa: "کاهش CSS استفاده‌نشده", en: "Reduce unused CSS" },
  "unused-javascript": { fa: "کاهش JavaScript استفاده‌نشده", en: "Reduce unused JavaScript" },
  "modern-image-formats": { fa: "ارائه‌ی تصاویر در قالب‌های فشرده‌ی جدید", en: "Serve images in next-gen formats" },
  "uses-optimized-images": { fa: "فشرده‌سازی بهتر تصاویر", en: "Efficiently encode images" },
  "offscreen-images": { fa: "بارگذاری تنبل تصاویر خارج از دید", en: "Defer offscreen images" },
  "uses-responsive-images": { fa: "تصاویر با اندازه‌ی مناسب هر نمایشگر", en: "Properly size images" },
  "image-delivery-insight": { fa: "بهبود تحویل تصاویر", en: "Improve image delivery" },
  "efficient-animated-content": { fa: "ویدیو به‌جای تصویر متحرک", en: "Use video formats for animated content" },
  "unminified-css": { fa: "کوچک‌سازی CSS", en: "Minify CSS" },
  "unminified-javascript": { fa: "کوچک‌سازی JavaScript", en: "Minify JavaScript" },
  "uses-text-compression": { fa: "فعال کردن فشرده‌سازی متن", en: "Enable text compression" },
  "uses-rel-preconnect": { fa: "اتصال زودهنگام به دامنه‌های لازم", en: "Preconnect to required origins" },
  "server-response-time": { fa: "کاهش زمان پاسخ اولیه‌ی سرور", en: "Reduce initial server response time" },
  "document-latency-insight": { fa: "تأخیر درخواست سند اصلی", en: "Document request latency" },
  redirects: { fa: "پرهیز از ریدایرکت‌های پشت‌سرهم", en: "Avoid multiple page redirects" },
  "uses-long-cache-ttl": { fa: "زمان نگهداری طولانی‌تر در حافظه‌ی مرورگر", en: "Serve static assets with an efficient cache policy" },
  "cache-insight": { fa: "زمان نگهداری بهتر در حافظه‌ی مرورگر", en: "Use efficient cache lifetimes" },
  "total-byte-weight": { fa: "کاهش حجم کل صفحه", en: "Avoid enormous network payloads" },
  "dom-size": { fa: "کاهش تعداد عناصر صفحه", en: "Avoid an excessive DOM size" },
  "dom-size-insight": { fa: "بهینه‌سازی تعداد عناصر صفحه", en: "Optimize DOM size" },
  "bootup-time": { fa: "کاهش زمان اجرای JavaScript", en: "Reduce JavaScript execution time" },
  "mainthread-work-breakdown": { fa: "کاهش کار رشته‌ی اصلی مرورگر", en: "Minimize main-thread work" },
  "font-display": { fa: "نمایش متن در حین بارگذاری فونت", en: "Ensure text remains visible during webfont load" },
  "font-display-insight": { fa: "نمایش متن در حین بارگذاری فونت", en: "Font display" },
  "third-party-summary": { fa: "کاهش اثر کدهای شخص ثالث", en: "Reduce the impact of third-party code" },
  "third-parties-insight": { fa: "اثر کدهای شخص ثالث", en: "Third parties" },
  "lcp-lazy-loaded": { fa: "تصویر اصلی صفحه نباید تنبل بارگذاری شود", en: "Largest Contentful Paint image was lazily loaded" },
  "prioritize-lcp-image": { fa: "اولویت دادن به تصویر اصلی صفحه", en: "Preload the Largest Contentful Paint image" },
  "lcp-discovery-insight": { fa: "کشف زودتر تصویر اصلی صفحه", en: "LCP request discovery" },
  "lcp-phases-insight": { fa: "مراحل نمایش بزرگ‌ترین محتوا", en: "LCP breakdown" },
  "legacy-javascript": { fa: "نفرستادن JavaScript قدیمی به مرورگرهای جدید", en: "Avoid serving legacy JavaScript to modern browsers" },
  "legacy-javascript-insight": { fa: "JavaScript قدیمی", en: "Legacy JavaScript" },
  "duplicated-javascript": { fa: "حذف ماژول‌های تکراری JavaScript", en: "Remove duplicate modules in JavaScript bundles" },
  "duplicated-javascript-insight": { fa: "JavaScript تکراری", en: "Duplicated JavaScript" },
  "long-tasks": { fa: "پرهیز از کارهای طولانی روی رشته‌ی اصلی", en: "Avoid long main-thread tasks" },
  "unsized-images": { fa: "تعیین عرض و ارتفاع صریح برای تصاویر", en: "Image elements do not have explicit width and height" },
  "layout-shift-elements": { fa: "عناصری که صفحه را جابه‌جا می‌کنند", en: "Avoid large layout shifts" },
  "cls-culprits-insight": { fa: "عوامل جابه‌جایی چیدمان", en: "Layout shift culprits" },
  "critical-request-chains": { fa: "کوتاه کردن زنجیره‌ی درخواست‌های حیاتی", en: "Avoid chaining critical requests" },
  "network-dependency-tree-insight": { fa: "زنجیره‌ی وابستگی درخواست‌ها", en: "Network dependency tree" },
  "uses-http2": { fa: "استفاده از HTTP/۲", en: "Use HTTP/2" },
  "modern-http-insight": { fa: "استفاده از HTTP نسل جدید", en: "Modern HTTP" },
  "forced-reflow-insight": { fa: "محاسبه‌ی دوباره‌ی اجباری چیدمان", en: "Forced reflow" },
  "no-document-write": { fa: "پرهیز از document.write", en: "Avoid document.write()" },
  "uses-passive-event-listeners": { fa: "رویدادهای غیرمسدودکننده برای اسکرول", en: "Use passive listeners to improve scrolling" },
  "viewport-insight": { fa: "تنظیم نمای موبایل", en: "Optimize viewport for mobile" },
  "inp-breakdown-insight": { fa: "اجزای تأخیر پاسخ به تعامل", en: "INP breakdown" },
};

export const SITEMAP_PROBLEMS: Record<string, Pair> = {
  not_200: { fa: "پاسخ غیر ۲۰۰", en: "Not a 200 response" },
  redirect: { fa: "ریدایرکت می‌شود", en: "Redirects" },
  noindex: { fa: "noindex است", en: "Marked noindex" },
  not_canonical: { fa: "canonical آن صفحه‌ی دیگری است", en: "Canonical points elsewhere" },
  blocked_by_robots: { fa: "با robots.txt مسدود است", en: "Blocked by robots.txt" },
  other_host: { fa: "روی دامنه‌ی دیگری است", en: "On another host" },
  not_crawled: { fa: "در اسکن دیده نشد", en: "Not seen in the scan" },
  not_html: { fa: "صفحه‌ی HTML نیست", en: "Not an HTML page" },
};

export const SITEMAP_SOURCE_KIND: Record<string, Pair> = {
  urlset: { fa: "فهرست نشانی‌ها", en: "URL list" },
  index: { fa: "فهرست نقشه‌ها", en: "Sitemap index" },
  invalid: { fa: "نامعتبر", en: "Invalid" },
  unreachable: { fa: "در دسترس نیست", en: "Unreachable" },
};

export const SERP_FEATURES: Record<string, Pair> = {
  featured_snippet: { fa: "پاسخ برجسته", en: "Featured snippet" },
  people_also_ask: { fa: "پرسش‌های مرتبط", en: "People also ask" },
  local_pack: { fa: "نتایج محلی", en: "Local pack" },
  images: { fa: "تصاویر", en: "Images" },
  video: { fa: "ویدیو", en: "Video" },
  top_stories: { fa: "اخبار برتر", en: "Top stories" },
  knowledge_graph: { fa: "پنل دانش", en: "Knowledge panel" },
  related_searches: { fa: "جستجوهای مرتبط", en: "Related searches" },
  paid: { fa: "تبلیغات", en: "Ads" },
  shopping: { fa: "خرید", en: "Shopping" },
  twitter: { fa: "شبکه‌های اجتماعی", en: "Social posts" },
  answer_box: { fa: "جعبه‌ی پاسخ", en: "Answer box" },
  map: { fa: "نقشه", en: "Map" },
  carousel: { fa: "کاروسل", en: "Carousel" },
  perspectives: { fa: "دیدگاه‌ها", en: "Perspectives" },
  ai_overview: { fa: "خلاصه‌ی هوش مصنوعی", en: "AI overview" },
};

export const SCHEMA_TYPE_LABELS: Record<string, Pair> = {
  Organization: { fa: "سازمان", en: "Organization" },
  LocalBusiness: { fa: "کسب‌وکار محلی", en: "Local business" },
  WebSite: { fa: "وب‌سایت", en: "Website" },
  BreadcrumbList: { fa: "مسیر راهنما", en: "Breadcrumbs" },
  Article: { fa: "مقاله", en: "Article" },
  BlogPosting: { fa: "نوشته‌ی وبلاگ", en: "Blog post" },
  NewsArticle: { fa: "خبر", en: "News article" },
  Product: { fa: "محصول", en: "Product" },
  FAQPage: { fa: "پرسش‌های متداول", en: "FAQ" },
  HowTo: { fa: "راهنمای گام‌به‌گام", en: "How-to" },
  Person: { fa: "شخص", en: "Person" },
  Event: { fa: "رویداد", en: "Event" },
};

export const REPORT_KIND_LABELS: Record<string, Pair> = {
  audit: { fa: "گزارش فنی اسکن", en: "Technical audit" },
  executive: { fa: "گزارش مدیریتی", en: "Executive summary" },
  keywords: { fa: "گزارش کلمات کلیدی", en: "Keywords" },
};

export const REPORT_KIND_HELP: Record<string, Pair> = {
  audit: { fa: "امتیاز، مشکلات به تفکیک شدت و دسته، و صفحه‌های گرفتار.", en: "Score, issues by severity and category, and the affected pages." },
  executive: { fa: "یک نگاه کلی: روند امتیاز، رتبه‌ها، سرعت و کارهای انجام‌شده.", en: "The big picture: score trend, rankings, speed and work done." },
  keywords: { fa: "کلمات ردیابی‌شده، جایگاه‌ها، بیشترین جابه‌جایی‌ها و فرصت‌ها.", en: "Tracked keywords, positions, biggest movers and opportunities." },
};

export const PUBLISH_STATUS: Record<string, Pair & { tone: string }> = {
  pending: { fa: "در انتظار تأیید", en: "Awaiting approval", tone: "warn" },
  publishing: { fa: "در حال انتشار", en: "Publishing", tone: "info" },
  rejected: { fa: "رد شد", en: "Rejected", tone: "crit" },
  published: { fa: "منتشر شد", en: "Published", tone: "ok" },
  failed: { fa: "ناموفق", en: "Failed", tone: "crit" },
  rolled_back: { fa: "برگردانده شد", en: "Rolled back", tone: "mute" },
};

export const LINK_REASON: Record<string, Pair> = {
  orphan: { fa: "صفحه‌ی یتیم", en: "Orphan page" },
  weak: { fa: "مهم اما کم‌لینک", en: "Important but weakly linked" },
  related: { fa: "موضوع مرتبط", en: "Related topic" },
};

export const ANCHOR_SOURCE: Record<string, Pair> = {
  gsc: { fa: "از جستجوهای Search Console", en: "From Search Console queries" },
  h1: { fa: "از H1 صفحه", en: "From the page's H1" },
  title: { fa: "از عنوان صفحه", en: "From the page title" },
};

export const ISSUE_LEVEL: Record<string, Pair & { tone: string }> = {
  error: { fa: "خطا", en: "Error", tone: "crit" },
  warning: { fa: "هشدار", en: "Warning", tone: "warn" },
  info: { fa: "نکته", en: "Note", tone: "info" },
};

export const INTEGRATION_LABELS: Record<string, Pair> = {
  DATAFORSEO: { fa: "DataForSEO", en: "DataForSEO" },
  PAGESPEED: { fa: "کلید PageSpeed Insights", en: "PageSpeed Insights key" },
  TELEGRAM_ALERTS: { fa: "هشدار تلگرام", en: "Telegram alerts" },
};

/** Country names from the runtime's own CLDR data, in the reader's language. */
export function countryName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([locale === "fa" ? "fa" : "en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/**
 * A server-worded {fa, en} message in the reader's language. Messages built on
 * the server interpolate numbers as Latin digits; Persian text shows them in
 * Persian digits like the rest of the interface.
 */
export function localized(pair: Pair | null | undefined, locale: Locale): string {
  if (!pair) return "";
  // Digits inside a name like H2 stay as they are.
  return locale === "fa" ? pair.fa.replace(/(?<![A-Za-z0-9])[0-9]+/g, (n) => n.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!)) : pair.en;
}
