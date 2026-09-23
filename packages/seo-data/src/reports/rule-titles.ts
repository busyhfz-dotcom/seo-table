/**
 * Persian and English titles of the audit rules, for reports rendered in the
 * worker (which cannot import the web app). Mirrors RULE_TITLES in
 * apps/web/src/lib/labels.ts; a test checks every rule in @seo/core has one.
 */
export const RULE_TITLES: Record<string, { fa: string; en: string }> = {
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

/** Rule categories, mirroring CATEGORY_LABELS in apps/web/src/lib/labels.ts. */
export const CATEGORY_TITLES: Record<string, { fa: string; en: string }> = {
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

