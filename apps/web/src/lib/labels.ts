/**
 * Human labels for machine identifiers — rule ids and fix actions — in both
 * languages. The rule engine stores English titles (they are also what the API
 * and CSV export return); the interface translates by id so a Persian reader
 * never sees an English sentence or a raw enum.
 */
import type { Locale } from "./i18n";

type Pair = { fa: string; en: string };

export const RULE_TITLES: Record<string, Pair> = {
  "rule.title.missing": { fa: "صفحه عنوان ندارد", en: "Page has no title" },
  "rule.title.length": { fa: "طول عنوان خارج از محدوده‌ی نمایش است", en: "Title length outside the displayed range" },
  "rule.title.duplicate": { fa: "عنوان تکراری در چند صفحه", en: "Duplicate title across pages" },
  "rule.meta.missing": { fa: "صفحه متا دیسکریپشن ندارد", en: "Page has no meta description" },
  "rule.meta.length": { fa: "طول متا دیسکریپشن نامناسب است", en: "Meta description length is off" },
  "rule.meta.duplicate": { fa: "متا دیسکریپشن تکراری", en: "Duplicate meta description" },
  "rule.h1.structure": { fa: "ساختار H1 نادرست است", en: "H1 structure is wrong" },
  "rule.alt.missing": { fa: "تصویر متن جانشین ندارد", en: "Image is missing alt text" },
  "rule.content.thin": { fa: "محتوای صفحه کم است", en: "Page has thin content" },
  "rule.canonical.missing": { fa: "صفحه canonical ندارد", en: "Page has no canonical URL" },
  "rule.canonical.broken": { fa: "canonical به صفحه‌ی غیرقابل‌ایندکس اشاره می‌کند", en: "Canonical points to a page that cannot be indexed" },
  "rule.index.noindex_linked": { fa: "صفحه‌ی لینک‌شده از ایندکس مسدود است", en: "Linked page is blocked from indexing" },
  "rule.robots.missing": { fa: "سایت robots.txt ندارد", en: "Site has no robots.txt" },
  "rule.robots.blocks_sitemap_url": { fa: "sitemap نشانی‌ای را دارد که robots.txt مسدود کرده", en: "Sitemap lists a URL that robots.txt blocks" },
  "rule.sitemap.missing": { fa: "sitemap پیدا نشد", en: "No sitemap found" },
  "rule.sitemap.page_missing": { fa: "صفحه‌ی قابل ایندکس در sitemap نیست", en: "Indexable page is not in the sitemap" },
  "rule.sitemap.url_not_indexable": { fa: "sitemap نشانی غیرقابل‌ایندکس دارد", en: "Sitemap lists a URL that cannot be indexed" },
  "rule.sitemap.redirect": { fa: "sitemap نشانی ریدایرکت‌شده دارد", en: "Sitemap lists a redirecting URL" },
  "rule.index.http_error": { fa: "نشانی خطای HTTP برمی‌گرداند", en: "URL returns an HTTP error" },
  "rule.index.redirect_chain": { fa: "زنجیره‌ی ریدایرکت یا حلقه", en: "Redirect chain or loop" },
  "rule.links.orphan": { fa: "هیچ لینک داخلی به صفحه اشاره نمی‌کند", en: "Page has no internal links pointing to it" },
  "rule.links.dead_internal": { fa: "لینک داخلی به نشانی خراب", en: "Internal link points to a broken URL" },
  "rule.links.depth": { fa: "صفحه از خانه خیلی دور است", en: "Page is too many clicks from home" },
  "rule.links.nofollow_internal": { fa: "لینک داخلی nofollow شده", en: "Internal link is nofollowed" },
  "rule.duplicate.content": { fa: "محتوای یکسان در چند نشانی", en: "Identical content on several URLs" },
  "rule.url.numeric_slug": { fa: "نشانی slug توصیفی ندارد", en: "URL has no descriptive slug" },
  "rule.engine.error": { fa: "اجرای یک قاعده ناموفق بود", en: "A rule failed to run" },
};

export const ACTION_LABELS: Record<string, Pair> = {
  REDIRECT: { fa: "ریدایرکت", en: "Redirect" },
  URL_CHANGE: { fa: "تغییر URL", en: "URL change" },
  PAGE_MERGE: { fa: "ادغام صفحات", en: "Page merge" },
  TITLE_REWRITE: { fa: "بازنویسی عنوان", en: "Title rewrite" },
  META_REWRITE: { fa: "بازنویسی متا", en: "Meta rewrite" },
  CANONICAL_FIX: { fa: "اصلاح canonical", en: "Canonical fix" },
  ROBOTS_FIX: { fa: "اصلاح robots", en: "Robots fix" },
  H1_FIX: { fa: "اصلاح H1", en: "H1 fix" },
  INTERNAL_LINK: { fa: "لینک داخلی", en: "Internal link" },
  ALT_TEXT: { fa: "متن جانشین تصویر", en: "Image alt text" },
  SITEMAP_ADD: { fa: "افزودن به sitemap", en: "Add to sitemap" },
};

/** What each fix does, in the reader's language. Numbers live in the UI, not here. */
export const FIX_TITLES: Record<string, Pair> = {
  REDIRECT: { fa: "زنجیره را به یک ریدایرکت کاهش بده", en: "Collapse the chain to a single redirect" },
  URL_CHANGE: { fa: "انتقال به slug توصیفی", en: "Move to a descriptive slug" },
  PAGE_MERGE: { fa: "ادغام در صفحه‌ی اصلی", en: "Merge into the primary page" },
  TITLE_REWRITE: { fa: "بازنویسی عنوان", en: "Rewrite the title" },
  META_REWRITE: { fa: "کوتاه‌سازی متا دیسکریپشن", en: "Trim the meta description" },
  CANONICAL_FIX: { fa: "اصلاح canonical", en: "Fix the canonical" },
  ROBOTS_FIX: { fa: "حذف دستور noindex", en: "Remove the noindex directive" },
  H1_FIX: { fa: "یک H1 نگه دار و بقیه را H2 کن", en: "Keep one H1 and demote the rest to H2" },
  INTERNAL_LINK: { fa: "از یک صفحه‌ی والد به این صفحه لینک بده", en: "Link to the page from a relevant parent" },
  ALT_TEXT: { fa: "توصیف تصویر", en: "Describe the image" },
  SITEMAP_ADD: { fa: "افزودن صفحه به sitemap", en: "Add the page to the sitemap" },
};

export const FIX_WHY: Record<string, Pair> = {
  REDIRECT: { fa: "هر هاپ اضافه سیگنال را کم و بارگذاری را کند می‌کند.", en: "Each hop loses signal and slows the first byte." },
  URL_CHANGE: { fa: "slug فعلی هیچ کلمه‌ای ندارد و چیزی به کاربر یا موتور جستجو نمی‌گوید.", en: "The slug carries no words, so neither people nor search engines learn anything from it." },
  PAGE_MERGE: { fa: "این دو نشانی برای یک عبارت با هم رقابت می‌کنند.", en: "These URLs compete for the same query." },
  TITLE_REWRITE: { fa: "عنوان همان چیزی است که جستجوگر می‌بیند؛ الان تکراری یا بلند است.", en: "The title is what searchers see; right now it is duplicated or too long." },
  META_REWRITE: { fa: "بخش انتهایی متا در نتایج جستجو بریده می‌شود.", en: "The end of the description is cut off in results." },
  CANONICAL_FIX: { fa: "canonical فعلی سیگنال‌های صفحه را به جای درستی نمی‌فرستد.", en: "The current canonical sends this page's signals to the wrong place." },
  ROBOTS_FIX: { fa: "سایت به این صفحه لینک می‌دهد اما دستور noindex آن را پنهان کرده.", en: "The site links to this page, but the directive hides it." },
  H1_FIX: { fa: "چند H1 موضوع اصلی صفحه را مبهم می‌کند.", en: "Several H1s leave the page's main topic ambiguous." },
  INTERNAL_LINK: { fa: "خزنده‌ها از طریق لینک به صفحات می‌رسند؛ صفحه‌ی یتیم کشف نمی‌شود.", en: "Crawlers reach pages through links; an orphan is barely discoverable." },
  ALT_TEXT: { fa: "بدون alt، صفحه‌خوان و جستجوی تصویر چیزی برای کار ندارند.", en: "Without alt, screen readers and image search have nothing to work with." },
  SITEMAP_ADD: { fa: "صفحه قابل ایندکس است اما به خزنده‌ها معرفی نشده.", en: "The page is indexable but crawlers are not told about it." },
};

export function ruleTitle(ruleId: string, fallback: string, locale: Locale): string {
  const pair = RULE_TITLES[ruleId];
  if (!pair) return fallback;
  // English keeps the engine's own, more specific wording ("…across 2 pages").
  return locale === "fa" ? pair.fa : fallback;
}

export function actionLabel(action: string, locale: Locale): string {
  const pair = ACTION_LABELS[action];
  return pair ? pair[locale] : action;
}

export function fixTitle(action: string, fallback: string, locale: Locale): string {
  if (locale === "en") return fallback;
  const base = FIX_TITLES[action]?.fa ?? fallback;
  // Keep the "(2/3)" batch suffix the proposal splitter adds.
  const batch = fallback.match(/\(\d+\/\d+\)$/)?.[0];
  return batch ? `${base} ${batch}` : base;
}

export function fixWhy(action: string, fallback: string | null, locale: Locale): string | null {
  if (locale === "en") return fallback;
  return FIX_WHY[action]?.fa ?? fallback;
}

/** Percent-encoded Persian slugs are unreadable; show them decoded. */
export function readableUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}
