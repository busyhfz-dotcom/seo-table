/**
 * HTML → PDF with the worker's Chromium, for generated reports.
 *
 * The document is the panel's own template, but it carries text that came from
 * crawled sites (titles, URLs), so it is printed in a context that cannot reach
 * anything: offline, every request aborted, no downloads, no service workers.
 * Fonts, logos and charts must therefore be inline (data: URLs, SVG).
 */
import type { Browser } from "playwright-core";

export type PdfOptions = {
  /** Chromium header/footer templates (spans with class pageNumber / totalPages are filled in). */
  headerTemplate?: string;
  footerTemplate?: string;
  /** CSS lengths; the header and footer live inside the top and bottom margins. */
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  landscape?: boolean;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function printPdf(browser: Browser, html: string, opts: PdfOptions = {}): Promise<Buffer> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context = await browser.newContext({
    offline: true,
    acceptDownloads: false,
    serviceWorkers: "block",
    permissions: [],
    colorScheme: "light",
  });
  try {
    // data: URLs never reach the router, so inline fonts and images still load.
    await context.route("**/*", (route) => route.abort("blockedbyclient").catch(() => undefined));
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.setContent(html, { waitUntil: "load", timeout });
    // Web fonts may still be decoding after load; printing before they are ready
    // would lay the Persian text out in a fallback face.
    await page.evaluate("document.fonts.ready.then(() => true)");
    const header = opts.headerTemplate ?? "<span></span>";
    const footer = opts.footerTemplate ?? "<span></span>";
    return await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: Boolean(opts.headerTemplate || opts.footerTemplate),
      headerTemplate: header,
      footerTemplate: footer,
      margin: { top: "18mm", right: "14mm", bottom: "18mm", left: "14mm", ...opts.margin },
      landscape: opts.landscape ?? false,
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}
