/**
 * A small site with deliberate SEO defects, served over real HTTP.
 *
 * The pipeline is tested against this rather than against mocked fetches, so the
 * crawler's robots handling, redirect following, status handling and HTML parsing
 * are all exercised for real. Each page below is commented with the rule it is
 * there to trigger.
 */
import { createServer, type Server } from "node:http";

const html = (body: string, head = "") =>
  `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

type Route = { status?: number; headers?: Record<string, string>; body: string };

export const ROUTES: Record<string, Route> = {
  "/robots.txt": {
    headers: { "content-type": "text/plain" },
    body: ["User-agent: *", "Disallow: /private", "Sitemap: {{BASE}}/sitemap.xml", ""].join("\n"),
  },

  "/sitemap.xml": {
    headers: { "content-type": "application/xml" },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>{{BASE}}/</loc></url>
  <url><loc>{{BASE}}/shop</loc></url>
  <url><loc>{{BASE}}/p/1204</loc></url>
  <url><loc>{{BASE}}/p/1205</loc></url>
  <url><loc>{{BASE}}/gone</loc></url>
  <url><loc>{{BASE}}/private/secret</loc></url>
</urlset>`,
  },

  // Home: healthy. Links everything else so nothing is an accidental orphan.
  "/": {
    body: html(
      `<h1>فروشگاه کتانی مثال</h1>
       <p>${"متن نمونه برای صفحه اصلی فروشگاه. ".repeat(20)}</p>
       <nav>
         <a href="/shop">فروشگاه</a>
         <a href="/p/1204">کتانی ۱۲۰۴</a>
         <a href="/p/1205">کتانی ۱۲۰۵</a>
         <a href="/blog/guide">راهنما</a>
         <a href="/blog/guide-2024">راهنمای ۲۰۲۴</a>
         <a href="/no-title">بدون عنوان</a>
         <a href="/noindexed">صفحه مخفی</a>
         <a href="/broken-canonical">کانونیکال شکسته</a>
         <a href="/gone">صفحه حذف‌شده</a>
         <a href="/old-shoes">نشانی قدیمی</a>
         <a href="/deep/a">مسیر عمیق</a>
       </nav>`,
      `<title>فروشگاه کتانی مثال | خرید کفش ورزشی اصل</title>
       <meta name="description" content="خرید کتانی دویدن و کفش ورزشی اصل با ارسال سریع. راهنمای انتخاب سایز و مقایسه مدل‌ها در فروشگاه مثال.">
       <link rel="canonical" href="{{BASE}}/">`,
    ),
  },

  // rule.title.length (too long) + rule.meta.length (too long)
  "/shop": {
    body: html(
      `<h1>همه محصولات</h1><p>${"توضیح دسته‌بندی محصولات. ".repeat(30)}</p>
       <a href="/p/1204">۱۲۰۴</a><a href="/p/1205">۱۲۰۵</a>`,
      `<title>${"فروشگاه کتانی دویدن مردانه و زنانه اصل با بهترین قیمت و ارسال سریع به سراسر کشور".slice(0, 120)}</title>
       <meta name="description" content="${"در این صفحه می‌توانید همه محصولات فروشگاه را به صورت کامل و جامع مشاهده کنید و با استفاده از فیلترهای پیشرفته بهترین انتخاب را داشته باشید و سپس سفارش خود را ثبت نمایید.".repeat(2)}">
       <link rel="canonical" href="{{BASE}}/shop">`,
    ),
  },

  // rule.title.duplicate + rule.alt.missing + rule.url.numeric_slug
  "/p/1204": {
    body: html(
      `<h1>کتانی دویدن مردانه ۱۲۰۴</h1>
       <img src="/img/1204.webp">
       <img src="/img/1204-side.webp" alt="">
       <p>${"مشخصات محصول. ".repeat(20)}</p><a href="/shop">بازگشت</a>`,
      `<title>محصول</title>
       <meta name="description" content="کتانی دویدن مردانه مدل ۱۲۰۴ با رویه مشبک و کفی طبی، مناسب دویدن روزانه و پیاده‌روی طولانی.">
       <link rel="canonical" href="{{BASE}}/p/1204">`,
    ),
  },

  // Same title as /p/1204 → duplicate title. Two H1s → rule.h1.structure.
  "/p/1205": {
    body: html(
      `<h1>کتانی دویدن زنانه ۱۲۰۵</h1><h1>مشخصات</h1>
       <img src="/img/1205.webp">
       <p>${"مشخصات این محصول. ".repeat(20)}</p><a href="/shop">بازگشت</a>`,
      `<title>محصول</title>
       <meta name="description" content="کتانی دویدن زنانه مدل ۱۲۰۵ با وزن سبک و زیره ضد لغزش، مناسب تمرین روزانه در باشگاه و خیابان.">
       <link rel="canonical" href="{{BASE}}/p/1205">`,
    ),
  },

  // rule.duplicate.content: identical visible text to /blog/guide-2024
  "/blog/guide": {
    body: html(
      `<h1>راهنمای انتخاب کتانی</h1><p>${"یک متن راهنما که در دو نشانی تکرار شده است. ".repeat(25)}</p>`,
      `<title>راهنمای انتخاب کتانی دویدن مناسب برای شما</title>
       <meta name="description" content="راهنمای کامل انتخاب کتانی دویدن بر اساس نوع قدم، سایز پا و سطح تمرین، با جدول مقایسه مدل‌ها.">
       <link rel="canonical" href="{{BASE}}/blog/guide">`,
    ),
  },
  "/blog/guide-2024": {
    body: html(
      `<h1>راهنمای انتخاب کتانی</h1><p>${"یک متن راهنما که در دو نشانی تکرار شده است. ".repeat(25)}</p>`,
      `<title>راهنمای انتخاب کتانی دویدن مناسب برای شما ۲۰۲۴</title>
       <meta name="description" content="راهنمای کامل انتخاب کتانی دویدن بر اساس نوع قدم، سایز پا و سطح تمرین، با جدول مقایسه مدل‌ها.">
       <link rel="canonical" href="{{BASE}}/blog/guide-2024">`,
    ),
  },

  // rule.title.missing + rule.meta.missing + rule.canonical.missing
  "/no-title": {
    body: html(`<h1>صفحه بدون عنوان</h1><p>${"متن این صفحه. ".repeat(20)}</p>`),
  },

  // rule.index.noindex_linked — linked from the home page but blocked
  "/noindexed": {
    body: html(
      `<h1>صفحه مخفی</h1><p>${"این صفحه نباید ایندکس شود. ".repeat(20)}</p>`,
      `<title>صفحه مخفی که نباید ایندکس شود در نتایج</title>
       <meta name="robots" content="noindex, nofollow">`,
    ),
  },

  // rule.canonical.broken — canonical points at a 404
  "/broken-canonical": {
    body: html(
      `<h1>کانونیکال شکسته</h1><p>${"متن صفحه با کانونیکال اشتباه. ".repeat(20)}</p>`,
      `<title>صفحه‌ای با کانونیکال اشتباه به نشانی حذف‌شده</title>
       <meta name="description" content="این صفحه کانونیکال خود را به یک نشانی حذف‌شده اشاره داده است و به همین دلیل سیگنال‌هایش هدر می‌رود.">
       <link rel="canonical" href="{{BASE}}/gone">`,
    ),
  },

  // rule.index.http_error (404) and it is in the sitemap → rule.sitemap.url_not_indexable
  "/gone": { status: 404, body: html("<h1>یافت نشد</h1>") },

  // rule.index.redirect_chain — three hops to /shop
  "/old-shoes": { status: 301, headers: { location: "{{BASE}}/old-shoes-2" }, body: "" },
  "/old-shoes-2": { status: 301, headers: { location: "{{BASE}}/shoes-legacy" }, body: "" },
  "/shoes-legacy": { status: 301, headers: { location: "{{BASE}}/shop" }, body: "" },

  // rule.links.depth — a genuine click chain, not a page linked straight from
  // the home page. Depth is measured in clicks from home, so the fixture has to
  // make the crawler walk there: a → b → c → d → e puts the leaf at depth 5.
  ...Object.fromEntries(
    (["/deep/a", "/deep/a/b", "/deep/a/b/c", "/deep/a/b/c/d", "/deep/a/b/c/d/e"] as const).map(
      (path, i, all) => [
        path,
        {
          body: html(
            `<h1>سطح ${i + 1}</h1><p>${"متن صفحه‌ای در عمق ساختار سایت. ".repeat(20)}</p>` +
              (all[i + 1] ? `<a href="${all[i + 1]}">سطح بعدی</a>` : ""),
            `<title>سطح ${i + 1} از مسیر عمیق سایت نمونه فروشگاه</title>
             <meta name="description" content="صفحه سطح ${i + 1} از یک مسیر عمیق که برای آزمودن قاعده عمق پیمایش ساخته شده است و از خانه فاصله دارد.">
             <link rel="canonical" href="{{BASE}}${path}">`,
          ),
        } satisfies Route,
      ],
    ),
  ),

  // Disallowed by robots.txt but listed in the sitemap →
  // rule.robots.blocks_sitemap_url. The crawler must not fetch it.
  "/private/secret": {
    body: html("<h1>خصوصی</h1>", "<title>این صفحه هرگز نباید خزش شود</title>"),
  },

  // An orphan: in no sitemap and linked from nowhere. Reached only if the
  // crawler wrongly invents URLs — its absence from results is itself a check.
  "/unlinked": { body: html("<h1>بدون لینک</h1>", "<title>صفحه بدون هیچ لینک ورودی</title>") },
};

export type Fixture = { server: Server; baseUrl: string; requests: string[]; close: () => Promise<void> };

export async function startFixture(listenPort = 0): Promise<Fixture> {
  const requests: string[] = [];
  let baseUrl = "";

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push(path);
    const route = ROUTES[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(html("<h1>404</h1>"));
      return;
    }
    const headers: Record<string, string> = {
      "content-type": "text/html; charset=utf-8",
      ...Object.fromEntries(
        Object.entries(route.headers ?? {}).map(([k, v]) => [k, v.replaceAll("{{BASE}}", baseUrl)]),
      ),
    };
    res.writeHead(route.status ?? 200, headers);
    res.end(route.body.replaceAll("{{BASE}}", baseUrl));
  });

  await new Promise<void>((resolve) => server.listen(listenPort, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
