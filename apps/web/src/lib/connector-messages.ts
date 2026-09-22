import type { Locale } from "./i18n";

/**
 * Connector results in the viewer's language.
 *
 * Connectors report a stable `reason` code plus an English message for logs.
 * People get a sentence that says what to change on their site, in fa or en,
 * with the technical detail (HTTP status and WordPress error code) kept at the
 * end so support can still see it.
 */
const REASONS: Record<string, Record<Locale, string>> = {
  invalid_credentials: {
    fa: "نام کاربری یا Application Password درست نیست. در پیشخوان وردپرس به «کاربران ← نمایه» بروید، در بخش Application Passwords یک رمز تازه بسازید و همان را اینجا وارد کنید. رمز معمولی ورود به وردپرس کار نمی‌کند.",
    en: "The username or application password is wrong. In WordPress go to Users → Profile → Application Passwords, create a new one and paste it here. Your normal login password will not work.",
  },
  credentials_not_received: {
    fa: "وردپرس اطلاعات ورود را دریافت نکرد، چون هاست هدر Authorization را حذف می‌کند. این خط را به ابتدای فایل ‎.htaccess‎ سایت اضافه کنید و دوباره امتحان کنید: SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1",
    en: "WordPress did not receive the login because the host strips the Authorization header. Add this line at the top of the site's .htaccess and try again: SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1",
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
    fa: "یک فایروال یا سرویس امنیتی (مثل Cloudflare یا فایروال هاست) درخواست را پیش از رسیدن به وردپرس رد کرد. مسیر ‎/wp-json/‎ را در آن فایروال مجاز کنید.",
    en: "A firewall or security service (such as Cloudflare or the host's firewall) rejected the request before it reached WordPress. Allow the /wp-json/ path in that firewall.",
  },
  app_passwords_disabled: {
    fa: "Application Passwords در این سایت غیرفعال است (معمولاً یک افزونه‌ی امنیتی آن را خاموش کرده). آن را فعال کنید و دوباره امتحان کنید.",
    en: "Application passwords are disabled on this site (usually by a security plugin). Enable them and try again.",
  },
  rest_api_disabled: {
    fa: "REST API وردپرس در آدرس ‎/wp-json/‎ در دسترس نیست. آدرس سایت را بررسی کنید و مطمئن شوید افزونه‌ای REST API را کامل خاموش نکرده باشد.",
    en: "The WordPress REST API is not available at /wp-json/. Check the site address and make sure no plugin disables the REST API entirely.",
  },
  rest_api_unreachable: {
    fa: "REST API وردپرس پاسخ درستی نداد. آدرس سایت را بررسی کنید.",
    en: "The WordPress REST API did not answer correctly. Check the site address.",
  },
  network_error: {
    fa: "اتصال به سایت برقرار نشد. آدرس سایت را بررسی کنید و مطمئن شوید سایت از اینترنت در دسترس است.",
    en: "Could not reach the site. Check the address and that the site is reachable from the internet.",
  },
  unexpected_response: {
    fa: "وردپرس پاسخ غیرمنتظره‌ای داد.",
    en: "WordPress returned an unexpected response.",
  },
};

const NOTES: Array<[RegExp, Record<Locale, string>]> = [
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
  [/^The site blocks the REST users endpoint/, {
    fa: "یک افزونه‌ی امنیتی بخش «کاربران» REST را بسته است؛ مشکلی نیست و ویرایش کار می‌کند.",
    en: "The site blocks the REST users endpoint (usually a security plugin); editing still works.",
  }],
];

export function connectorMessage(
  locale: Locale,
  result: { ok: boolean; reason?: string; message?: string },
): string {
  const message = result.message ?? "";
  if (result.ok) {
    const who = message.match(/^Connected as (.+)\.$/)?.[1];
    if (who) return locale === "fa" ? `متصل شد با حساب ${who}.` : `Connected as ${who}.`;
    return message;
  }
  const text = result.reason ? REASONS[result.reason]?.[locale] : undefined;
  if (!text) return message;
  const detail = message.match(/\((?:HTTP )?\d{3}[^)]*\)/)?.[0];
  return detail ? `${text} ${detail}` : text;
}

export function connectorNotes(locale: Locale, notes: string[] | undefined): string[] {
  return (notes ?? []).map((n) => NOTES.find(([re]) => re.test(n))?.[1][locale] ?? n);
}
