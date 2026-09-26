import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18n";
import { toPersianDigits } from "./format";

/**
 * Connector results in the viewer's language.
 *
 * Connectors report a stable `reason` code plus an English message for logs.
 * People get a sentence that says what to change on their site, in fa or en,
 * with the technical detail (HTTP status and WordPress error code) kept at the
 * end so support can still see it.
 */
export const REASONS: Record<string, Record<Locale, string>> = {
  invalid_credentials: {
    fa: "نام کاربری یا Application Password درست نیست. در پیشخوان وردپرس به «کاربران ← نمایه» بروید، در بخش Application Passwords یک رمز تازه بسازید و همان را اینجا وارد کنید. رمز معمولی ورود به وردپرس کار نمی‌کند.",
    en: "The username or application password is wrong. In WordPress go to Users → Profile → Application Passwords, create a new one and paste it here. Your normal login password will not work.",
  },
  credentials_not_received: {
    fa: "وردپرس اطلاعات ورود را دریافت نکرد، چون هاست هدر Authorization را حذف می‌کند. این خط را به ابتدای فایل ‎.htaccess‎ سایت اضافه کنید و دوباره امتحان کنید: `SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1`",
    en: "WordPress did not receive the login because the host strips the Authorization header. Add this line at the top of the site's .htaccess and try again: `SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1`",
  },
  insufficient_role: {
    fa: "این حساب وارد شد ولی اجازه‌ی ویرایش نوشته‌ها را ندارد. از حسابی با نقش «ویرایشگر» یا «مدیر کل» استفاده کنید.",
    en: "The account signed in but cannot edit posts. Use an account with the Editor or Administrator role.",
  },
  security_plugin_blocked: {
    fa: "یک افزونه‌ی امنیتی (مثل Wordfence، Solid Security/iThemes یا All In One WP Security) یا قانون هاست، REST API را برای این حساب بسته است. در تنظیمات همان افزونه، دسترسی REST API را برای کاربرانِ واردشده مجاز کنید.",
    en: "A security plugin (such as Wordfence, Solid Security/iThemes or All In One WP Security) or a host rule blocks the REST API for this account. Allow REST API access for logged-in users in that plugin's settings.",
  },
  firewall_blocked: {
    fa: "یک فایروال یا سرویس امنیتی (مثل Cloudflare یا فایروال هاست) درخواست را پیش از رسیدن به وردپرس رد کرد. مسیر `/wp-json/` را در آن فایروال مجاز کنید.",
    en: "A firewall or security service (such as Cloudflare or the host's firewall) rejected the request before it reached WordPress. Allow the `/wp-json/` path in that firewall.",
  },
  app_passwords_disabled: {
    fa: "Application Passwords در این سایت غیرفعال است (معمولاً یک افزونه‌ی امنیتی آن را خاموش کرده). آن را فعال کنید و دوباره امتحان کنید.",
    en: "Application passwords are disabled on this site (usually by a security plugin). Enable them and try again.",
  },
  rest_api_disabled: {
    fa: "REST API وردپرس در آدرس `/wp-json/` در دسترس نیست. آدرس سایت را بررسی کنید و مطمئن شوید افزونه‌ای REST API را کامل خاموش نکرده باشد.",
    en: "The WordPress REST API is not available at `/wp-json/`. Check the site address and make sure no plugin disables the REST API entirely.",
  },
  rest_api_unreachable: {
    fa: "REST API وردپرس پاسخ درستی نداد. آدرس سایت را بررسی کنید.",
    en: "The WordPress REST API did not answer correctly. Check the site address.",
  },
  network_error: {
    fa: "اتصال به سایت برقرار نشد. آدرس سایت را بررسی کنید و مطمئن شوید سایت از اینترنت در دسترس است.",
    en: "Could not reach the site. Check the address and that the site is reachable from the internet.",
  },
  blocked_address: {
    fa: "این آدرس به یک شبکه‌ی داخلی یا خصوصی اشاره می‌کند و اتصال به آن مجاز نیست. آدرس عمومی سایت را وارد کنید.",
    en: "That address points to an internal or private network, which this service does not connect to. Enter the site's public address.",
  },
  redirected: {
    fa: "سایت به آدرس دیگری ریدایرکت می‌کند. آدرس نهایی سایت (همان که در مرورگر باز می‌شود، مثلاً با `https` یا `www`) را وارد کنید.",
    en: "The site redirects to another address. Enter the final address (the one your browser ends up on, e.g. with https or www).",
  },
  response_too_large: {
    fa: "پاسخ سایت بیش از حد بزرگ بود و خوانده نشد.",
    en: "The site's response was too large to read.",
  },
  no_site_access: {
    fa: "این حساب گوگل به این سایت در Search Console دسترسی ندارد. ایمیل حساب سرویس را در Search Console به‌عنوان کاربر اضافه کنید.",
    en: "This Google account has no access to the Search Console property. Add the service account's email as a user in Search Console.",
  },
  site_not_found: {
    fa: "این سایت در حساب Search Console پیدا نشد. نشانی را دقیقاً مانند Search Console وارد کنید (مثلاً sc-domain:example.com).",
    en: "That property is not in this Search Console account. Enter it exactly as Search Console shows it (e.g. sc-domain:example.com).",
  },
  no_property_access: {
    fa: "این حساب گوگل به این ویژگی در GA4 دسترسی ندارد. ایمیل حساب سرویس را با نقش Viewer به همان ویژگی اضافه کنید.",
    en: "This Google account has no access to the GA4 property. Add the service account's email to the property with the Viewer role.",
  },
  property_not_found: {
    fa: "در GA4 ویژگی‌ای با این شناسه وجود ندارد. شناسه‌ی عددی ویژگی را بررسی کنید.",
    en: "No GA4 property has that id. Check the numeric property id.",
  },
  unexpected_response: {
    fa: "وردپرس پاسخ غیرمنتظره‌ای داد.",
    en: "WordPress returned an unexpected response.",
  },

  // ---- Cloudflare edge
  invalid_token: {
    fa: "Cloudflare این توکن API را نپذیرفت (نادرست، منقضی یا لغوشده). در داشبورد Cloudflare به «My Profile ← API Tokens» بروید، توکن تازه‌ای با دسترسی‌های گفته‌شده بسازید و همان را اینجا وارد کنید. کلید Global API Key کار نمی‌کند.",
    en: "Cloudflare rejected this API token (wrong, expired or revoked). In the Cloudflare dashboard go to My Profile → API Tokens, create a new token with the listed permissions and paste it here. The Global API Key does not work.",
  },
  missing_permission: {
    fa: "توکن API این دسترسی را ندارد:",
    en: "The API token lacks this permission:",
  },
  zone_not_found: {
    fa: "دامنه‌ی این سایت در حساب Cloudflare که این توکن به آن دسترسی دارد پیدا نشد. سایت را به Cloudflare اضافه کنید یا به توکن دسترسی به همین دامنه بدهید.",
    en: "This site's domain is not a zone this token can see in Cloudflare. Add the site to Cloudflare, or give the token access to the domain's zone.",
  },
  zone_not_active: {
    fa: "این دامنه در Cloudflare هنوز فعال نیست؛ نیم‌سرورهای دامنه باید به Cloudflare اشاره کنند.",
    en: "The domain is not active in Cloudflare yet: its nameservers must point to Cloudflare.",
  },
  not_proxied: {
    fa: "ترافیک این نشانی از Cloudflare عبور نمی‌کند (ابر خاکستری، فقط DNS). در بخش DNS داشبورد Cloudflare، پراکسی (ابر نارنجی) را برای رکورد این نشانی روشن کنید.",
    en: "This address's traffic does not pass through Cloudflare (grey cloud, DNS only). In the Cloudflare DNS settings, turn on the proxy (orange cloud) for its record.",
  },
  dns_record_missing: {
    fa: "برای این نشانی هیچ رکورد `A`، `AAAA` یا `CNAME` در DNS حساب Cloudflare نیست.",
    en: "There is no `A`, `AAAA` or `CNAME` record for this address in Cloudflare DNS.",
  },
  route_conflict: {
    fa: "Worker دیگری از قبل روی این نشانی در Cloudflare فعال است. ابتدا مسیر آن را در بخش Workers Routes حذف یا جابه‌جا کنید؛ هیچ تغییری اعمال نشد.",
    en: "Another Worker already runs on this address in Cloudflare. Remove or move its route under Workers Routes first; nothing was changed.",
  },
  edge_not_installed: {
    fa: "Worker لبه هنوز برای این سایت نصب نشده است.",
    en: "The edge worker is not installed for this site yet.",
  },
  bypass_failed: {
    fa: "Worker لبه هنوز در حال به‌روزرسانی است و مقدار اصلی سایت خوانده نشد. یک دقیقه دیگر دوباره امتحان کنید.",
    en: "The edge worker is still updating, so the site's own value could not be read. Try again in a minute.",
  },
  cloudflare_error: {
    fa: "Cloudflare خطای غیرمنتظره‌ای داد.",
    en: "Cloudflare returned an unexpected error.",
  },

  // ---- platform detection and live pages
  site_unreachable: {
    fa: "سایت باز نشد. نشانی سایت را بررسی کنید و مطمئن شوید از اینترنت در دسترس است.",
    en: "The site could not be loaded. Check the address and that it is reachable from the internet.",
  },
  too_many_redirects: {
    fa: "سایت بیش از حد ریدایرکت می‌کند.",
    en: "The site redirects too many times.",
  },

  // ---- Search Console actions
  insufficient_scope: {
    fa: "اتصال گوگل برای این کار مجوز کافی ندارد. برای ثبت نقشه‌ی سایت، اتصال Search Console را با دسترسی کامل (webmasters، نه فقط‌خواندنی) دوباره برقرار کنید.",
    en: "The Google connection lacks the scope for this. To submit sitemaps, reconnect Search Console with full access (webmasters, not read-only).",
  },
  insufficient_permission: {
    fa: "این حساب گوگل در Search Console نقش Owner یا Full ندارد؛ ثبت نقشه‌ی سایت به یکی از این دو نقش نیاز دارد.",
    en: "This Google account is not an Owner or Full user of the Search Console property; submitting sitemaps needs one of those roles.",
  },
  quota_exceeded: {
    fa: "سهمیه‌ی روزانه‌ی گوگل برای این سایت تمام شده است (بازرسی نشانی: ۲۰۰۰ در روز). فردا دوباره امتحان کنید.",
    en: "Google's daily quota for this property is used up (URL inspection: 2,000 a day). Try again tomorrow.",
  },
  sitemap_outside_property: {
    fa: "این نقشه‌ی سایت داخل سایتِ متصل در Search Console نیست.",
    en: "This sitemap is not inside the connected Search Console property.",
  },
  url_outside_property: {
    fa: "این نشانی داخل سایتِ متصل در Search Console نیست.",
    en: "This address is not inside the connected Search Console property.",
  },
  token_exchange_failed: {
    fa: "گوگل اطلاعات ورود را نپذیرفت. اتصال Search Console را دوباره برقرار کنید.",
    en: "Google did not accept the credentials. Reconnect Search Console.",
  },
};

/**
 * Per-change result codes the connectors added for Cloudflare and for
 * WordPress SEO-plugin writes, for the fixes screen's result list (merge into
 * RESULT_CODES in labels.ts).
 */
export const CONNECTOR_RESULT_CODES: Record<string, Record<Locale, string>> = {
  not_visible_on_page: {
    fa: "پس از نوشتن، تغییر روی صفحه دیده نشد (قالب، افزونه‌ی دیگر یا کش آن را می‌پوشاند)؛ تغییر برگردانده شد",
    en: "The change did not show on the page after writing (a theme, another plugin or a cache overrides it); it was undone",
  },
  collateral_change: {
    fa: "نوشتن این فیلد فیلد دیگری را هم تغییر داد؛ تغییر برگردانده شد",
    en: "Writing this field also changed another one; it was undone",
  },
  description_not_from_excerpt: {
    fa: "توضیحات متای این صفحه از «چکیده» نمی‌آید، پس تغییر چکیده اثری ندارد",
    en: "This page's meta description does not come from its excerpt, so changing the excerpt would not change it",
  },
  redirect_loop: { fa: "این ریدایرکت حلقه می‌سازد؛ چیزی نوشته نشد", en: "This redirect would loop; nothing was written" },
  invalid_value: { fa: "مقدار پیشنهادی معتبر نیست؛ چیزی نوشته نشد", en: "The proposed value is not valid; nothing was written" },
  edge_not_installed: { fa: "Worker لبه در Cloudflare نصب نیست", en: "The edge worker is not installed in Cloudflare" },
  bypass_failed: { fa: "Worker لبه هنوز به‌روز نشده؛ یک دقیقه دیگر دوباره امتحان کنید", en: "The edge worker is still updating; try again in a minute" },
  cloudflare_error: { fa: "Cloudflare خطا داد", en: "Cloudflare returned an error" },
  manifest_conflict: { fa: "فهرست قوانین لبه هم‌زمان تغییر کرد؛ دوباره امتحان کنید", en: "The edge rule index changed at the same time; try again" },
  corrupt_rule: { fa: "قانون ذخیره‌شده در Cloudflare خراب است", en: "The rule stored in Cloudflare is corrupt" },
  missing_permission: { fa: "توکن Cloudflare دسترسی لازم را ندارد", en: "The Cloudflare token lacks a required permission" },
  invalid_token: { fa: "توکن Cloudflare دیگر معتبر نیست", en: "The Cloudflare token is no longer valid" },
  page_unreachable: { fa: "صفحه برای خواندن مقدار فعلی باز نشد", en: "The page could not be loaded to read its current value" },
  page_unavailable: { fa: "صفحه با خطا پاسخ داد و مقدار فعلی خوانده نشد", en: "The page answered with an error, so its current value was not read" },
  page_redirects: { fa: "این صفحه اکنون ریدایرکت می‌شود", en: "This page now redirects" },
  image_not_found: { fa: "این تصویر دیگر روی صفحه نیست", en: "This image is no longer on the page" },
  blocked_address: { fa: "نشانی به شبکه‌ی داخلی اشاره می‌کند و مجاز نیست", en: "The address points to a private network and is refused" },
  response_too_large: { fa: "پاسخ صفحه بیش از حد بزرگ بود", en: "The page's response was too large" },
};

export const NOTES: Array<[RegExp, Record<Locale, string>]> = [
  [/^SEO Table bridge plugin detected/, {
    fa: "افزونه‌ی SEO Table Bridge پیدا شد: عنوان سئو، توضیحات متا، canonical، robots و ریدایرکت‌ها قابل ویرایش‌اند.",
    en: "SEO Table bridge plugin detected: SEO title, meta description, canonical, robots and redirects are writable.",
  }],
  [/^No SEO Table bridge plugin found/, {
    fa: "افزونه‌ی SEO Table Bridge نصب نیست؛ عنوان سئو، توضیحات متا، canonical و robots از طریق REST قابل ویرایش نیستند.",
    en: "No SEO Table bridge plugin found. SEO title, meta description, canonical and robots are not writable over the core REST API.",
  }],
  [/^Yoast detected/, {
    fa: "Yoast پیدا شد (فقط‌خواندنی). برای ویرایش فیلدهای آن، افزونه‌ی Bridge را نصب کنید.",
    en: "Yoast detected (read-only over REST). Install the bridge plugin to let fixes write its fields.",
  }],
  [/^Rank Math detected/, {
    fa: "Rank Math پیدا شد (فقط‌خواندنی). برای ویرایش فیلدهای آن، افزونه‌ی Bridge را نصب کنید.",
    en: "Rank Math detected (read-only over REST). Install the bridge plugin to let fixes write its fields.",
  }],
  [/^Redirection plugin detected/, {
    fa: "افزونه‌ی Redirection پیدا شد: ریدایرکت ساخته می‌شود (همچنان با تأیید شما).",
    en: "Redirection plugin detected: redirects can be created (still requires human approval).",
  }],
  [/^No redirect plugin found/, {
    fa: "افزونه‌ی ریدایرکت پیدا نشد؛ اصلاح‌های ریدایرکت روی این سایت اجرا نمی‌شوند.",
    en: "No redirect plugin found, so redirect fixes cannot be executed on this site.",
  }],
  [/^SEO Table bridge plugin \S+ detected/, {
    fa: "افزونه‌ی SEO Table Bridge پیدا شد: عنوان سئو، توضیحات متا، canonical، robots و ریدایرکت‌ها قابل ویرایش‌اند.",
    en: "SEO Table bridge plugin detected: SEO title, meta description, canonical, robots and redirects are writable.",
  }],
  [/^The SEO Table bridge plugin on this site is outdated/, {
    fa: "نسخه‌ی افزونه‌ی SEO Table Bridge این سایت قدیمی است؛ برای ویرایش فیلدهای سئو و ریدایرکت‌ها آن را به ۰٫۵٫۰ یا بالاتر به‌روز کنید.",
    en: "The SEO Table bridge plugin on this site is outdated; update it to 0.5.0 or later to enable SEO fields and redirects.",
  }],
  [/^(Rank Math|SEOPress|All in One SEO) detected: SEO title/, {
    fa: "افزونه‌ی سئوی سایت پیدا شد: عنوان سئو، توضیحات متا، canonical و robots از راه API خود همین افزونه نوشته می‌شوند و هر تغییر روی صفحه‌ی زنده بررسی می‌شود؛ چیزی نصب نمی‌شود.",
    en: "The site's SEO plugin was found: SEO title, meta description, canonical and robots are written through that plugin's own API, and every change is checked on the live page; nothing is installed.",
  }],
  [/^Several SEO plugins are active/, {
    fa: "چند افزونه‌ی سئو هم‌زمان فعال‌اند؛ اصلاح‌ها از راه یکی از آن‌ها نوشته می‌شوند و روی صفحه بررسی می‌شوند.",
    en: "Several SEO plugins are active; fixes are written through one of them and checked on the page.",
  }],
  [/^Yoast SEO detected: Yoast has no API/, {
    fa: "Yoast SEO پیدا شد: Yoast هیچ API برای تغییر فیلدهایش ندارد، پس عنوان سئو، توضیحات متا، canonical و robots از راه REST قابل نوشتن نیستند. Cloudflare را وصل کنید (بدون نصب روی سایت) یا افزونه‌ی SEO Table Bridge را نصب کنید.",
    en: "Yoast SEO detected: Yoast has no API for changing its fields, so SEO title, meta description, canonical and robots cannot be written over the REST API. Connect Cloudflare (nothing to install on the site) or install the SEO Table bridge plugin.",
  }],
  [/^No SEO Table bridge plugin and no supported SEO plugin/, {
    fa: "نه افزونه‌ی SEO Table Bridge نصب است و نه افزونه‌ی سئوی پشتیبانی‌شده (Rank Math، SEOPress، All in One SEO)؛ عنوان سئو، canonical و robots از راه REST وردپرس قابل نوشتن نیستند.",
    en: "No SEO Table bridge plugin and no supported SEO plugin (Rank Math, SEOPress, All in One SEO): SEO title, canonical and robots are not writable over the WordPress REST API.",
  }],
  [/^This site shows each post's excerpt as its meta description/, {
    fa: "این سایت «چکیده»ی هر نوشته را به‌عنوان توضیحات متا نشان می‌دهد، پس توضیحات در چکیده نوشته می‌شوند (پیش از هر نوشتن، روی همان صفحه بررسی می‌شود).",
    en: "This site shows each post's excerpt as its meta description, so descriptions are written to the excerpt (checked on each page before writing).",
  }],
  [/^Redirects need the SEO Table bridge plugin or the Cloudflare edge/, {
    fa: "برای ریدایرکت‌ها افزونه‌ی SEO Table Bridge یا اتصال Cloudflare لازم است.",
    en: "Redirects need the SEO Table bridge plugin or the Cloudflare edge.",
  }],
  [/^The Redirection plugin is detected, but/, {
    fa: "افزونه‌ی Redirection پیدا شد، اما SEO Table ریدایرکت‌ها را فقط از راه افزونه‌ی پل می‌نویسد.",
    en: "The Redirection plugin is detected, but SEO Table writes redirects only through its bridge plugin.",
  }],
  [/^Cloudflare edge worker is not installed yet/, {
    fa: "Worker لبه در Cloudflare هنوز نصب نشده است؛ برای اعمال اصلاح‌ها در لبه‌ی Cloudflare آن را نصب کنید.",
    en: "The Cloudflare edge worker is not installed yet: install it to apply fixes at the edge.",
  }],
  [/^Cloudflare edge: title, meta description/, {
    fa: "لبه‌ی Cloudflare: عنوان، توضیحات متا، canonical، robots، متن جانشین تصاویر و ریدایرکت‌ها در لبه‌ی Cloudflare اعمال می‌شوند؛ هیچ چیزی روی سایت نصب نمی‌شود.",
    en: "Cloudflare edge: title, meta description, canonical, robots, image alt text and redirects are applied at Cloudflare's edge; nothing is installed on the site.",
  }],
  [/^Edge changes reach every Cloudflare location/, {
    fa: "تغییرات لبه حداکثر ظرف حدود یک دقیقه به همه‌ی مراکز Cloudflare می‌رسند.",
    en: "Edge changes reach every Cloudflare location within about a minute.",
  }],
  [/^The edge worker on Cloudflare is outdated/, {
    fa: "Worker لبه در Cloudflare قدیمی است؛ برای به‌روزرسانی دوباره نصبش کنید.",
    en: "The edge worker on Cloudflare is outdated: reinstall it to update.",
  }],
  [/^Other Workers own these routes/, {
    fa: "Workerهای دیگری این مسیرها را در اختیار دارند و این مسیرها بازنویسی نمی‌شوند.",
    en: "Other Workers own some routes on this site, so those paths are not rewritten.",
  }],
  [/^Another Worker already serves/, {
    fa: "Worker دیگری از قبل روی این نشانی فعال است؛ تا مسیر آن برداشته نشود، Worker لبه نصب نمی‌شود.",
    en: "Another Worker already runs on this address; the edge worker cannot be installed until its route is removed.",
  }],
  [/^Supplies query, impression, click and position data/, {
    fa: "داده‌های جست‌وجو (نمایش، کلیک و جایگاه) را برای فرصت‌های محتوایی می‌آورد، نشانی‌ها را بازرسی می‌کند و نقشه‌ی سایت ثبت می‌کند (ثبت به نقش Owner یا Full نیاز دارد).",
    en: "Supplies query, impression, click and position data for Content Opportunities, inspects URLs, and submits sitemaps (submitting needs Owner or Full access).",
  }],
  [/^The site is not behind Cloudflare/, {
    fa: "سایت پشت Cloudflare نیست: برای اعمال اصلاح‌ها در لبه، DNS دامنه را به Cloudflare منتقل کنید (پلن رایگان کافی است).",
    en: "The site is not behind Cloudflare: move the domain's DNS to Cloudflare (the free plan is enough) to apply fixes at the edge.",
  }],
  [/^Not a WordPress site\.$/, {
    fa: "این سایت وردپرسی نیست.",
    en: "Not a WordPress site.",
  }],
  [/^Yoast SEO has no API for writing its fields/, {
    fa: "Yoast SEO هیچ API برای نوشتن فیلدهایش ندارد: بدون افزونه‌ی پل فقط متن جانشین تصاویر قابل تغییر است.",
    en: "Yoast SEO has no API for writing its fields: without the bridge plugin only image alt text can be changed.",
  }],
  [/^Recommended: the site is behind Cloudflare/, {
    fa: "پیشنهاد ما: سایت پشت Cloudflare است، پس همه‌ی اصلاح‌های پشتیبانی‌شده بدون نصب هیچ چیزی روی سایت، در لبه‌ی Cloudflare اعمال می‌شوند.",
    en: "Recommended: the site is behind Cloudflare, so every supported fix can be applied at the edge without installing anything on the site.",
  }],
  [/^Recommended: (Rank Math|SEOPress|All in One SEO) can be written through its own API/, {
    fa: "پیشنهاد ما: افزونه‌ی سئوی سایت را می‌توان با یک Application Password وردپرس از راه API خودش نوشت؛ نصب چیزی لازم نیست.",
    en: "Recommended: the site's SEO plugin can be written through its own API with a WordPress application password; nothing to install.",
  }],
  [/^Recommended: this WordPress site's SEO fields can only be changed with the SEO Table bridge plugin/, {
    fa: "پیشنهاد ما: فیلدهای سئوی این سایت وردپرسی فقط با افزونه‌ی SEO Table Bridge (یا از راه Cloudflare) قابل تغییرند.",
    en: "Recommended: this WordPress site's SEO fields can only be changed with the SEO Table bridge plugin (or through Cloudflare).",
  }],
  [/^Recommended: nothing on this site can be connected for writing/, {
    fa: "پیشنهاد ما: هیچ بخشی از این سایت برای نوشتن قابل اتصال نیست؛ بسته‌ی اصلاحات را دانلود کنید و فایل‌هایش را دستی اعمال کنید.",
    en: "Recommended: nothing on this site can be connected for writing; download the fix pack and apply its files by hand.",
  }],
  [/^Always available: every proposed fix as files/, {
    fa: "همیشه در دسترس: همه‌ی اصلاح‌های پیشنهادی به‌صورت فایل (قوانین ریدایرکت، جدول متا، نقشه‌ی سایت، robots.txt) برای اعمال دستی.",
    en: "Always available: every proposed fix as files (redirect rules, a meta table, a sitemap, robots.txt) to apply by hand.",
  }],
  [/^The site's platform has not been detected yet/, {
    fa: "پلتفرم سایت هنوز شناسایی نشده، پس هنوز روشی پیشنهاد نمی‌شود.",
    en: "The site's platform has not been detected yet, so no connection method is recommended.",
  }],
  [/^The site blocks the REST users endpoint/, {
    fa: "یک افزونه‌ی امنیتی بخش «کاربران» REST را بسته است؛ مشکلی نیست و ویرایش کار می‌کند.",
    en: "The site blocks the REST users endpoint (usually a security plugin); editing still works.",
  }],
];

/** The sentence for a connector reason code alone, or null when the code is not one of ours. */
export function reasonText(locale: Locale, reason: string | null | undefined): string | null {
  return (reason && REASONS[reason]?.[locale]) || null;
}

export function connectorMessage(
  locale: Locale,
  result: { ok: boolean; reason?: string; message?: string },
): string {
  const message = result.message ?? "";
  if (result.ok) {
    const who = message.match(/^Connected as (.+)\.$/)?.[1];
    if (who) return locale === "fa" ? `متصل شد با حساب ${who}.` : `Connected as ${who}.`;
    const zone = message.match(/^Connected to Cloudflare zone (.+)\.$/)?.[1];
    if (zone) return locale === "fa" ? `به دامنه‌ی ${zone} در Cloudflare متصل شد.` : `Connected to Cloudflare zone ${zone}.`;
    return message;
  }
  // A network failure's message is the raw socket error (resolver output,
  // internal addresses): it is logged, never shown or stored.
  if (result.reason === "network_error") return REASONS.network_error![locale];
  const text = result.reason ? REASONS[result.reason]?.[locale] : undefined;
  if (!text) return message;
  if (result.reason === "missing_permission") {
    // The permission's name as Cloudflare's token editor shows it, never translated.
    // From Cloudflare's own message, or from one this function worded before (stored errors).
    const permission =
      message.match(/lacks the "([^"]+)" permission/)?.[1] ?? message.match(/lacks this permission: `?([^`]+?)`?$/)?.[1];
    return permission ? `${text} \`${permission}\`` : text;
  }
  if (result.reason === "redirected") {
    const location = message.match(/redirecting to (\S+?);/)?.[1];
    return location ? `${text} (${location})` : text;
  }
  // The HTTP status (and WordPress's error code) stays for support, in the reader's digits.
  const detail = message.match(/\((?:HTTP )?(\d{3})(?: ([^)]*))?\)/);
  if (!detail) return text;
  const [, status, code] = detail;
  if (locale === "en") return `${text} ${detail[0]}`;
  return `${text} (کد ${toPersianDigits(status!)}${code ? `، \`${code}\`` : ""})`;
}

/**
 * Audit-log sentences for the actions the connection routes record
 * (connector.install_edge, connector.uninstall_edge,
 * search_console.submit_sitemap, project.write_target, fixpack.download);
 * null for any other action. activity.ts falls back to this.
 */
export function describeConnectionAction(action: string, metadata: unknown, locale: Locale): string | null {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const fa = locale === "fa";
  const failed = m.ok === false;
  const target = (kind: unknown) =>
    kind === "CLOUDFLARE" ? "Cloudflare" : kind === "WORDPRESS" ? (fa ? "وردپرس" : "WordPress") : fa ? "خودکار" : "automatic";
  switch (action) {
    case "connector.install_edge":
      if (failed) return fa ? "نصب Worker لبه در Cloudflare ناموفق بود" : "Installing the Cloudflare edge worker failed";
      return fa ? "Worker لبه در Cloudflare نصب شد" : "Cloudflare edge worker installed";
    case "connector.uninstall_edge":
      if (failed) return fa ? "حذف Worker لبه از Cloudflare ناموفق بود" : "Removing the Cloudflare edge worker failed";
      return fa ? "Worker لبه از Cloudflare حذف شد" : "Cloudflare edge worker removed";
    case "search_console.submit_sitemap":
      if (failed) return fa ? "ثبت نقشه‌ی سایت در Search Console ناموفق بود" : "Sitemap submission to Search Console failed";
      return fa ? "نقشه‌ی سایت در Search Console ثبت شد" : "Sitemap submitted to Search Console";
    case "project.write_target":
      return fa ? `مقصد اعمال اصلاح‌ها: ${target(m.to)}` : `Fixes are now written through: ${target(m.to)}`;
    case "fixpack.download":
      return fa ? "بسته‌ی اصلاحات دانلود شد" : "Fix pack downloaded";
    default:
      return null;
  }
}

/** The viewer's language from the locale cookie, as every page reads it. */
export function requestLocale(req: { cookies: { get(name: string): { value: string } | undefined } }): Locale {
  const value = req.cookies.get("locale")?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** A per-change result code from the connectors listed above, or null when it is not one of theirs. */
export function connectorResultMessage(code: string | undefined, locale: Locale): string | null {
  return (code && CONNECTOR_RESULT_CODES[code]?.[locale]) || null;
}

/** What goes in `connectors.last_error`: the reason code and an English sentence safe to show later. */
export function storedConnectorError(result: { reason?: string; message?: string }): string {
  const reason = result.reason ?? "unknown";
  return `${reason}: ${connectorMessage("en", { ok: false, reason, message: result.message ?? "" }) || "Connection failed"}`;
}

export function connectorNotes(locale: Locale, notes: string[] | undefined): string[] {
  return (notes ?? []).map((n) => NOTES.find(([re]) => re.test(n))?.[1][locale] ?? n);
}
