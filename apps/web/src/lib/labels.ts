/**
 * Human labels for machine identifiers — rule ids, categories, fix actions,
 * roles, execution result codes — in both languages. The engine and the API
 * speak English and enums (that is also what the CSV export returns); the
 * interface translates by id so a Persian reader never sees an English sentence
 * or a raw enum. Unknown values fall back to what the server sent rather than
 * being hidden.
 */
import type { Locale } from "./i18n";
import { toPersianDigits } from "./format";
import { CONNECTOR_RESULT_CODES } from "./connector-messages";

type Pair = { fa: string; en: string };

function pick(map: Record<string, Pair>, key: string | null | undefined, locale: Locale): string | null {
  if (!key) return null;
  return map[key]?.[locale] ?? null;
}

// ---------------------------------------------------------------- rules

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
  "rule.robots.unreachable": { fa: "robots.txt دریافت نشد", en: "robots.txt could not be fetched" },
  "rule.robots.blocks_sitemap_url": { fa: "نقشه‌ی سایت نشانی‌ای را دارد که robots.txt مسدود کرده", en: "Sitemap lists a URL that robots.txt blocks" },
  "rule.sitemap.missing": { fa: "نقشه‌ی سایت پیدا نشد", en: "No sitemap found" },
  "rule.sitemap.page_missing": { fa: "صفحه‌ی قابل ایندکس در نقشه‌ی سایت نیست", en: "Indexable page is not in the sitemap" },
  "rule.sitemap.url_not_indexable": { fa: "نقشه‌ی سایت نشانی غیرقابل‌ایندکس دارد", en: "Sitemap lists a URL that cannot be indexed" },
  "rule.sitemap.redirect": { fa: "نقشه‌ی سایت نشانی ریدایرکت‌شده دارد", en: "Sitemap lists a redirecting URL" },
  "rule.index.http_error": { fa: "نشانی خطای HTTP برمی‌گرداند", en: "URL returns an HTTP error" },
  "rule.index.redirect_chain": { fa: "زنجیره‌ی ریدایرکت یا حلقه", en: "Redirect chain or loop" },
  "rule.links.orphan": { fa: "هیچ لینک داخلی به صفحه اشاره نمی‌کند", en: "Page has no internal links pointing to it" },
  "rule.links.dead_internal": { fa: "لینک داخلی به نشانی خراب", en: "Internal link points to a broken URL" },
  "rule.links.depth": { fa: "صفحه از خانه خیلی دور است", en: "Page is too many clicks from home" },
  "rule.links.nofollow_internal": { fa: "لینک داخلی nofollow شده", en: "Internal link is nofollowed" },
  "rule.duplicate.content": { fa: "محتوای یکسان در چند نشانی", en: "Identical content on several URLs" },
  "rule.url.numeric_slug": { fa: "نشانی، نامک توصیفی ندارد", en: "URL has no descriptive slug" },
  "rule.engine.error": { fa: "اجرای یک قاعده ناموفق بود", en: "A rule failed to run" },
};

/** What each rule checks, for the Rules tab. English comes from the engine itself. */
export const RULE_DESCRIPTIONS_FA: Record<string, string> = {
  "rule.title.missing": "صفحه‌ی قابل ایندکس عنوان ندارد یا عنوانش خالی است.",
  "rule.title.length": "عنوان کوتاه‌تر یا بلندتر از بازه‌ای است که نتایج جستجو به‌خوبی نمایش می‌دهند.",
  "rule.title.duplicate": "چند صفحه‌ی قابل ایندکس یک عنوان مشترک دارند و در نتایج از هم تشخیص داده نمی‌شوند.",
  "rule.meta.missing": "صفحه‌ی قابل ایندکس متا دیسکریپشن ندارد.",
  "rule.meta.length": "طول متا دیسکریپشن خارج از بازه‌ای است که نتایج جستجو نمایش می‌دهند.",
  "rule.meta.duplicate": "چند صفحه یک متا دیسکریپشن مشترک دارند.",
  "rule.h1.structure": "صفحه H1 ندارد یا بیش از یک H1 دارد.",
  "rule.alt.missing": "تصویر اصلاً ویژگی alt ندارد (alt خالی انتخابی معتبر است و گزارش نمی‌شود).",
  "rule.content.thin": "صفحه‌ی قابل ایندکس متن بسیار کمی دارد.",
  "rule.canonical.missing": "صفحه‌ی قابل ایندکس هیچ نشانی canonical اعلام نکرده است.",
  "rule.canonical.broken": "canonical به نشانی‌ای اشاره می‌کند که خطا می‌دهد، ریدایرکت می‌شود یا بررسی نشد.",
  "rule.index.noindex_linked": "صفحه‌ای که سایت به آن لینک داخلی می‌دهد noindex است.",
  "rule.robots.blocks_sitemap_url": "نشانی‌ای که در نقشه‌ی سایت آمده با robots.txt مسدود شده است.",
  "rule.robots.missing": "سایت فایل robots.txt ندارد.",
  "rule.robots.unreachable": "robots.txt خطای سرور داد یا دریافت نشد؛ در این حالت خزنده‌ها خزش را متوقف می‌کنند.",
  "rule.sitemap.missing": "هیچ نقشه‌ی سایتی از راه robots.txt یا ‎/sitemap.xml پیدا نشد.",
  "rule.sitemap.page_missing": "یک صفحه‌ی قابل ایندکس در نقشه‌ی سایت نیامده است.",
  "rule.sitemap.url_not_indexable": "نقشه‌ی سایت نشانی‌ای دارد که خطا می‌دهد، ریدایرکت می‌شود یا noindex است.",
  "rule.sitemap.redirect": "نقشه‌ی سایت به‌جای مقصد، نشانی ریدایرکت‌شونده را فهرست کرده است.",
  "rule.index.http_error": "یک نشانی خزش‌شده وضعیت خطا برگرداند یا پاسخ نداد.",
  "rule.index.redirect_chain": "نشانی از هاپ‌های بیش از حد لازم ریدایرکت می‌شود یا در حلقه می‌افتد.",
  "rule.links.orphan": "هیچ لینک داخلی به یک صفحه‌ی قابل ایندکس اشاره نمی‌کند.",
  "rule.links.dead_internal": "یک لینک داخلی به نشانی‌ای اشاره می‌کند که خطا می‌دهد.",
  "rule.links.depth": "صفحه بیش از عمق تعیین‌شده از صفحه‌ی اصلی فاصله دارد.",
  "rule.links.nofollow_internal": "یک لینک داخلی nofollow است و اعتبار لینک هدر می‌رود.",
  "rule.duplicate.content": "دو یا چند صفحه‌ی قابل ایندکس متن قابل‌مشاهده‌ی یکسان دارند.",
  "rule.url.numeric_slug": "نشانی صفحه را فقط با یک عدد و بدون کلمه مشخص می‌کند.",
  "rule.engine.error": "یک قاعده هنگام اجرا با خطا مواجه شد.",
};

/**
 * Finding titles that say more than the rule's own title (a count, a variant
 * such as "too short" vs "too long"). Matched against the English the engine
 * stored; numbers are carried over in the reader's digits.
 */
const TITLE_VARIANTS: Array<{ re: RegExp; fa: (m: RegExpMatchArray) => string }> = [
  { re: /^Canonical target could not be verified$/, fa: () => "مقصد canonical قابل بررسی نبود" },
  { re: /^robots\.txt could not be fetched$/, fa: () => "robots.txt دریافت نشد" },
  { re: /^URL did not respond$/, fa: () => "نشانی پاسخ نداد" },
  { re: /^URL returns HTTP (\d+)$/, fa: (m) => `نشانی خطای HTTP ${toPersianDigits(m[1]!)} برمی‌گرداند` },
  { re: /^Redirect loop$/, fa: () => "حلقه‌ی ریدایرکت" },
  { re: /^Redirect chain of (\d+) hops$/, fa: (m) => `زنجیره‌ی ریدایرکت با ${toPersianDigits(m[1]!)} هاپ` },
  { re: /^Title is longer than search results show$/, fa: () => "عنوان بلندتر از چیزی است که نتایج جستجو نشان می‌دهند" },
  { re: /^Title is very short$/, fa: () => "عنوان خیلی کوتاه است" },
  { re: /^Duplicate title across (\d+) pages$/, fa: (m) => `عنوان تکراری در ${toPersianDigits(m[1]!)} صفحه` },
  { re: /^Meta description longer than (\d+) characters$/, fa: (m) => `متا دیسکریپشن بلندتر از ${toPersianDigits(m[1]!)} نویسه` },
  { re: /^Meta description is very short$/, fa: () => "متا دیسکریپشن خیلی کوتاه است" },
  { re: /^Duplicate meta description across (\d+) pages$/, fa: (m) => `متا دیسکریپشن تکراری در ${toPersianDigits(m[1]!)} صفحه` },
  { re: /^Page has no H1$/, fa: () => "صفحه H1 ندارد" },
  { re: /^Page has (\d+) H1 elements$/, fa: (m) => `صفحه ${toPersianDigits(m[1]!)} عنصر H1 دارد` },
  { re: /^Page has fewer than (\d+) words$/, fa: (m) => `صفحه کمتر از ${toPersianDigits(m[1]!)} کلمه دارد` },
  { re: /^Page is (\d+) clicks from the home page$/, fa: (m) => `صفحه ${toPersianDigits(m[1]!)} کلیک از صفحه‌ی اصلی فاصله دارد` },
  { re: /^Identical content on (\d+) URLs$/, fa: (m) => `محتوای یکسان در ${toPersianDigits(m[1]!)} نشانی` },
  { re: /^Rule (\S+) failed to run$/, fa: (m) => `اجرای قاعده‌ی ${m[1]} ناموفق بود` },
];

export function ruleTitle(ruleId: string, fallback: string, locale: Locale): string {
  // English keeps the engine's own, more specific wording ("…across 2 pages").
  if (locale === "en") return fallback;
  for (const v of TITLE_VARIANTS) {
    const m = fallback.match(v.re);
    if (m) return v.fa(m);
  }
  return RULE_TITLES[ruleId]?.fa ?? fallback;
}

/** The rule's own name, independent of any one finding. */
export function ruleName(ruleId: string, locale: Locale): string {
  return RULE_TITLES[ruleId]?.[locale] ?? ruleId;
}

export function ruleDescription(ruleId: string, fallback: string, locale: Locale): string {
  return locale === "fa" ? (RULE_DESCRIPTIONS_FA[ruleId] ?? fallback) : fallback;
}

export const CATEGORY_LABELS: Record<string, Pair> = {
  title: { fa: "عنوان", en: "Title" },
  meta: { fa: "متا دیسکریپشن", en: "Meta description" },
  structure: { fa: "ساختار", en: "Structure" },
  accessibility: { fa: "دسترس‌پذیری", en: "Accessibility" },
  content: { fa: "محتوا", en: "Content" },
  internal_links: { fa: "لینک داخلی", en: "Internal links" },
  duplicate: { fa: "محتوای تکراری", en: "Duplicate content" },
  url: { fa: "نشانی", en: "URL" },
  canonical: { fa: "canonical", en: "Canonical" },
  indexability: { fa: "ایندکس‌پذیری", en: "Indexability" },
  robots: { fa: "robots.txt", en: "robots.txt" },
  sitemap: { fa: "نقشه‌ی سایت", en: "Sitemap" },
  engine: { fa: "موتور قواعد", en: "Rule engine" },
};

export function categoryLabel(category: string, locale: Locale): string {
  return pick(CATEGORY_LABELS, category, locale) ?? category;
}

/** Why a crawled page cannot be indexed (page_snapshots.noindex_reason). */
export function noindexLabel(reason: string | null, locale: Locale): string {
  if (!reason) return "—";
  const http = reason.match(/^http_(\d+)$/);
  if (http) return locale === "fa" ? `خطای HTTP ${toPersianDigits(http[1]!)}` : `HTTP ${http[1]}`;
  return (
    pick(
      {
        redirect: { fa: "ریدایرکت", en: "Redirect" },
        non_html: { fa: "غیر HTML", en: "Not HTML" },
        meta_noindex: { fa: "noindex", en: "noindex" },
        meta_none: { fa: "noindex کامل", en: "noindex (none)" },
        robots_txt_disallow: { fa: "مسدود در robots.txt", en: "Blocked by robots.txt" },
        canonicalised_elsewhere: { fa: "canonical به صفحه‌ی دیگر", en: "Canonical elsewhere" },
        fetch_failed: { fa: "دریافت نشد", en: "Fetch failed" },
      },
      reason,
      locale,
    ) ?? reason
  );
}

/** audit_runs.error_code */
export function runErrorLabel(code: string, locale: Locale): string {
  return (
    pick(
      {
        BLOCKED_ADDRESS: { fa: "نشانی سایت داخلی یا خصوصی است", en: "The site address is private or internal" },
        RETRIES_EXHAUSTED: { fa: "پس از چند تلاش ناموفق ماند", en: "Failed after every retry" },
        ATTEMPT_FAILED: { fa: "تلاش ناموفق بود؛ دوباره امتحان می‌شود", en: "Attempt failed; it will be retried" },
        ENQUEUE_FAILED: { fa: "قرار دادن در صف ناموفق بود", en: "Could not be queued" },
        STALE: { fa: "اسکن متوقف مانده بود و رها شد", en: "The scan stalled and was abandoned" },
      },
      code,
      locale,
    ) ?? (locale === "fa" ? "خطای اسکن" : "Scan error")
  );
}

// ---------------------------------------------------------------- fixes

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
  SITEMAP_ADD: { fa: "افزودن به نقشه‌ی سایت", en: "Add to sitemap" },
};

/** What each fix does, in the reader's language. Numbers live in the UI, not here. */
export const FIX_TITLES: Record<string, Pair> = {
  REDIRECT: { fa: "زنجیره را به یک ریدایرکت کاهش بده", en: "Collapse the chain to a single redirect" },
  URL_CHANGE: { fa: "انتقال به نامک توصیفی", en: "Move to a descriptive slug" },
  PAGE_MERGE: { fa: "ادغام در صفحه‌ی اصلی", en: "Merge into the primary page" },
  TITLE_REWRITE: { fa: "بازنویسی عنوان", en: "Rewrite the title" },
  META_REWRITE: { fa: "کوتاه‌سازی متا دیسکریپشن", en: "Trim the meta description" },
  CANONICAL_FIX: { fa: "اصلاح canonical", en: "Fix the canonical" },
  ROBOTS_FIX: { fa: "حذف دستور noindex", en: "Remove the noindex directive" },
  H1_FIX: { fa: "یک H1 نگه دار و بقیه را H2 کن", en: "Keep one H1 and demote the rest to H2" },
  INTERNAL_LINK: { fa: "از یک صفحه‌ی والد به این صفحه لینک بده", en: "Link to the page from a relevant parent" },
  ALT_TEXT: { fa: "توصیف تصویر", en: "Describe the image" },
  SITEMAP_ADD: { fa: "افزودن صفحه به نقشه‌ی سایت", en: "Add the page to the sitemap" },
};

export const FIX_WHY: Record<string, Pair> = {
  REDIRECT: { fa: "هر هاپ اضافه سیگنال را کم و بارگذاری را کند می‌کند.", en: "Each hop loses signal and slows the first byte." },
  URL_CHANGE: { fa: "نامک فعلی هیچ کلمه‌ای ندارد و چیزی به کاربر یا موتور جستجو نمی‌گوید.", en: "The slug carries no words, so neither people nor search engines learn anything from it." },
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

export function actionLabel(action: string, locale: Locale): string {
  return pick(ACTION_LABELS, action, locale) ?? action;
}

export function fixTitle(action: string, fallback: string, locale: Locale): string {
  if (locale === "en") return fallback;
  const base = FIX_TITLES[action]?.fa ?? fallback;
  // Keep the "(2/3)" batch suffix the proposal splitter adds, in Persian digits.
  const batch = fallback.match(/\(\d+\/\d+\)$/)?.[0];
  return batch ? `${base} ${toPersianDigits(batch)}` : base;
}

export function fixWhy(action: string, fallback: string | null, locale: Locale): string | null {
  if (locale === "en") return fallback;
  return FIX_WHY[action]?.fa ?? fallback;
}

/**
 * Per-change result codes from a dry run, an apply or a rollback
 * (pipeline execute.ts and the WordPress connector).
 */
const RESULT_CODES: Record<string, Pair> = {
  unreadable: { fa: "مقدار فعلی خوانده نشد؛ چیزی نوشته نشد", en: "The current value could not be read; nothing was written" },
  changed_since_scan: { fa: "صفحه پس از اسکن ویرایش شده؛ این تغییر رد شد", en: "The page was edited after the scan; this change was skipped" },
  changed_since_apply: { fa: "پس از اعمال ویرایش شده؛ دست‌نخورده ماند", en: "Edited after the fix was applied; left as it is" },
  already_applied: { fa: "از قبل همین مقدار را دارد", en: "Already holds this value" },
  already_restored: { fa: "از قبل به مقدار قبلی برگشته", en: "Already back to its previous value" },
  nothing_to_restore: { fa: "چیزی برای بازگردانی نبود", en: "Nothing to restore" },
  unsupported_action: { fa: "سایت متصل این نوع اصلاح را پشتیبانی نمی‌کند", en: "The connected site cannot perform this kind of fix" },
  unsupported_field: { fa: "این فیلد بدون افزونه‌ی پل وردپرس قابل نوشتن نیست", en: "This field cannot be written without the WordPress bridge plugin" },
  post_url_mismatch: { fa: "نشانی نوشته در وردپرس با نشانی صفحه یکی نیست", en: "The WordPress post's address does not match the page" },
  post_not_found: { fa: "نوشته یا برگه‌ای با این نشانی در وردپرس پیدا نشد", en: "No WordPress post or page has this address" },
  post_ambiguous: { fa: "چند نوشته‌ی وردپرس این نشانی را دارند؛ چیزی نوشته نشد", en: "Several WordPress posts claim this address; nothing was written" },
  url_outside_site: { fa: "این نشانی متعلق به سایت متصل نیست", en: "This address is not on the connected site" },
  home_page_unsupported: { fa: "صفحه‌ی اصلی از این راه قابل ویرایش نیست", en: "The home page cannot be edited this way" },
  media_not_found: { fa: "فایل رسانه‌ای مطابق پیدا نشد", en: "No matching media item was found" },
  media_ambiguous: { fa: "چند فایل رسانه‌ای این نشانی را دارند", en: "Several media items have this address" },
  image_ambiguous: { fa: "تصویر با متن‌های جانشین متفاوت تکرار شده؛ دستی ویرایش کن", en: "The image appears with different alt texts; edit it by hand" },
  content_unreadable: { fa: "محتوای نوشته خوانده نشد", en: "The post content could not be read" },
  missing_selector: { fa: "تصویر هدف مشخص نشده است", en: "The target image is not specified" },
  not_writable: { fa: "این اتصال امکان نوشتن ندارد", en: "This connector cannot write" },
  network_error: { fa: "خطای شبکه در ارتباط با سایت", en: "Network error talking to the site" },
};

export function resultCodeLabel(code: string | undefined, ok: boolean, locale: Locale): string {
  if (!code) {
    return ok ? (locale === "fa" ? "آماده‌ی اعمال" : "Ready to apply") : locale === "fa" ? "ناموفق" : "Failed";
  }
  const http = code.match(/^http_(\d+)$/);
  if (http) return locale === "fa" ? `سایت خطای HTTP ${toPersianDigits(http[1]!)} داد` : `The site answered HTTP ${http[1]}`;
  return pick(RESULT_CODES, code, locale) ?? CONNECTOR_RESULT_CODES[code]?.[locale] ?? code;
}

/** Search Console opportunity buckets. The table stores the English sentence. */
const SUGGESTED_ACTIONS: Array<{ code: string; en: string; fa: string }> = [
  {
    code: "create_or_index_page",
    en: "High demand but ranking past page one — check whether a page for this query exists and is indexable",
    fa: "تقاضای بالا اما رتبه بعد از صفحه‌ی اول — بررسی کن صفحه‌ای برای این عبارت وجود دارد و قابل ایندکس است",
  },
  {
    code: "rewrite_title_and_meta",
    en: "Ranks on page one but is rarely clicked — rewrite the title and meta description",
    fa: "در صفحه‌ی اول است اما کم کلیک می‌خورد — عنوان و متا دیسکریپشن را بازنویسی کن",
  },
  {
    code: "expand_content_and_links",
    en: "Just below page one — expand the content and add internal links",
    fa: "درست زیر صفحه‌ی اول — محتوا را گسترش بده و لینک داخلی اضافه کن",
  },
  {
    code: "test_clearer_title",
    en: "Strong position, weak click-through — test a clearer title",
    fa: "جایگاه خوب، نرخ کلیک ضعیف — عنوان روشن‌تری را امتحان کن",
  },
  { code: "none", en: "No action needed", fa: "اقدامی لازم نیست" },
];

/** Accepts either the action code or the stored English sentence. */
export function suggestedActionLabel(value: string, locale: Locale): string {
  const hit = SUGGESTED_ACTIONS.find((a) => a.code === value || a.en === value);
  return hit ? hit[locale] : value;
}

// ---------------------------------------------------------------- people & system

export const ROLE_LABELS: Record<string, Pair> = {
  OWNER: { fa: "مالک", en: "Owner" },
  ADMIN: { fa: "مدیر", en: "Admin" },
  EDITOR: { fa: "ویرایشگر", en: "Editor" },
  VIEWER: { fa: "بیننده", en: "Viewer" },
};

export function roleLabel(role: string, locale: Locale): string {
  return pick(ROLE_LABELS, role, locale) ?? role;
}

export const CONNECTOR_LABELS: Record<string, string> = {
  WORDPRESS: "WordPress",
  CLOUDFLARE: "Cloudflare",
  SEARCH_CONSOLE: "Search Console",
  GA4: "GA4",
  INSTAGRAM: "Instagram",
  YOUTUBE: "YouTube",
};

export function connectorLabel(kind: string): string {
  return CONNECTOR_LABELS[kind] ?? kind;
}

export function targetTypeLabel(type: string | null, locale: Locale): string {
  if (!type) return "";
  return (
    pick(
      {
        api_key: { fa: "کلید API", en: "API key" },
        audit_run: { fa: "اجرای اسکن", en: "Scan run" },
        connector: { fa: "اتصال", en: "Connector" },
        fix_execution: { fa: "اجرای اصلاح", en: "Fix execution" },
        fix_proposal: { fa: "پیشنهاد اصلاح", en: "Fix proposal" },
        organization: { fa: "سازمان", en: "Organization" },
        project: { fa: "پروژه", en: "Project" },
        user: { fa: "کاربر", en: "User" },
        session: { fa: "نشست", en: "Session" },
      },
      type,
      locale,
    ) ?? type
  );
}

// ---------------------------------------------------------------- misc

/** Percent-encoded Persian slugs are unreadable; show them decoded. */
export function readableUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}
