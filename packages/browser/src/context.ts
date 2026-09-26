/**
 * One place that makes a browser context, so a remote session and a one-shot
 * render get the same isolation: incognito (nothing persists), no downloads,
 * no service workers (they would take requests out of interception), no
 * granted permissions, and every request checked by the SSRF guard.
 */
import type { Browser, BrowserContext } from "playwright-core";
import type { HostGuard } from "./guard.js";
import type { Device } from "./types.js";

export const VIEWPORTS: Record<
  Device,
  { width: number; height: number; isMobile: boolean; hasTouch: boolean; deviceScaleFactor: number }
> = {
  desktop: { width: 1366, height: 850, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

/**
 * A regular Chrome user agent. The headless default says "HeadlessChrome",
 * which many sites answer with a bot wall; the point here is to see what a
 * visitor sees.
 */
export function userAgentFor(device: Device, chromeMajor: string): string {
  return device === "mobile"
    ? `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

export type UiLocale = "fa" | "en";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** What the remote browser shows instead of a page on a refused address. */
export function blockedPage(locale: UiLocale, host: string): string {
  const fa = locale === "fa";
  const heading = fa ? "این نشانی مسدود است" : "This address is blocked";
  const body = fa
    ? "مرورگر پنل فقط به سایت‌های عمومی اینترنت وصل می‌شود؛ نشانی‌های شبکه‌ی خصوصی یا داخلی در دسترس نیستند."
    : "The panel's browser only connects to public websites; private and internal network addresses are not reachable.";
  return `<!doctype html><html lang="${locale}" dir="${fa ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${heading}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d120f;color:#e8f1ec;font:15px/1.7 system-ui,sans-serif}
main{max-width:460px;padding:32px;text-align:center}h1{font-size:19px;margin:0 0 10px;color:#f3c24b}code{direction:ltr;unicode-bidi:embed;color:#a3b3aa}</style>
</head><body><main><h1>${heading}</h1><p>${body}</p><p><code>${escapeHtml(host)}</code></p></main></body></html>`;
}

export type HardenedContext = { context: BrowserContext; blockedCount(): number };

export async function newHardenedContext(
  browser: Browser,
  opts: { device: Device; chromeMajor: string; guard: HostGuard; locale: UiLocale },
): Promise<HardenedContext> {
  const vp = VIEWPORTS[opts.device];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    screen: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    userAgent: userAgentFor(opts.device, opts.chromeMajor),
    acceptDownloads: false,
    serviceWorkers: "block",
    permissions: [],
    colorScheme: "light",
  });
  let blocked = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const verdict = await opts.guard.check(request.url());
    if (verdict.ok) {
      // Fails only when the page went away meanwhile.
      await route.continue().catch(() => undefined);
      return;
    }
    blocked++;
    if (request.isNavigationRequest()) {
      let host = request.url();
      try {
        host = new URL(host).host || host;
      } catch {
        /* the raw URL is shown as it is */
      }
      await route
        .fulfill({ status: 403, contentType: "text/html; charset=utf-8", body: blockedPage(opts.locale, host) })
        .catch(() => undefined);
    } else {
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
  return { context, blockedCount: () => blocked };
}
