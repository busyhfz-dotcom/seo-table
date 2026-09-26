/**
 * Render one URL the way a visitor's browser does, and read its SEO from the
 * rendered DOM. The raw HTML (what a crawler that runs no JavaScript sees) is
 * fetched separately and parsed with the same extractor, so any difference
 * between the two is JavaScript's doing — the risk this report exists to show.
 */
import type { BrowserContext, Page } from "playwright-core";
import { extract, guardedFetch, UpstreamError, type Extracted } from "@seo/core";
import { netErrorName } from "./session.js";
import { applyChangesScript, METRICS_SCRIPT } from "./page-scripts.js";
import { VIEWPORTS } from "./context.js";
import type { ConsoleEntry, Device, PageChange, RenderResult, SeoData } from "./types.js";

const LOAD_TIMEOUT_MS = 20_000;
const RAW_TIMEOUT_MS = 15_000;
const RAW_MAX_REDIRECTS = 5;
const CONSOLE_MAX = 50;

function seoFrom(x: Extracted): SeoData {
  return {
    title: x.title,
    description: x.metaDescription,
    canonical: x.canonical,
    robots: x.robotsMeta,
    h1: x.h1s.slice(0, 20),
    hreflang: x.hreflang.slice(0, 100),
    jsonld: x.structuredDataTypes,
    links: { internal: x.internalLinksOut, external: x.externalLinksOut },
    lang: x.lang,
    wordCount: x.wordCount,
    imagesMissingAlt: x.imagesMissingAlt,
  };
}

/** The HTML as served, following redirects hop by hop through the SSRF guard. */
async function fetchRaw(url: string, userAgent: string): Promise<{ html: string; url: string } | null> {
  let current = url;
  for (let hop = 0; hop <= RAW_MAX_REDIRECTS; hop++) {
    const res = await guardedFetch(current, {
      headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
      timeoutMs: RAW_TIMEOUT_MS,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html/i.test(type)) return null;
    return { html: res.body.toString("utf8"), url: current };
  }
  return null;
}

function readMetrics(page: Page): Promise<RenderResult["metrics"]> {
  return page.evaluate<RenderResult["metrics"]>(METRICS_SCRIPT).catch(() => ({}));
}

function applyChanges(page: Page, changes: PageChange[]): Promise<number> {
  return page.evaluate<number>(applyChangesScript(changes));
}

const collapse = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

export async function renderPage(
  context: BrowserContext,
  input: { url: string; device: Device; changes?: PageChange[]; userAgent: string; blockedCount(): number },
): Promise<RenderResult> {
  const page = await context.newPage();
  const consoleEntries: ConsoleEntry[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error" || consoleEntries.length >= CONSOLE_MAX) return;
    const source = msg.location().url;
    consoleEntries.push({ type: "error", text: msg.text().slice(0, 500), ...(source ? { source } : {}) });
  });
  page.on("pageerror", (err) => {
    if (consoleEntries.length < CONSOLE_MAX) consoleEntries.push({ type: "exception", text: err.message.slice(0, 500) });
  });
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));

  // Started now so it runs while the page loads.
  const rawPromise = fetchRaw(input.url, input.userAgent).catch(() => null);

  let status: number | null = null;
  let timedOut = false;
  try {
    const response = await page.goto(input.url, { waitUntil: "networkidle", timeout: LOAD_TIMEOUT_MS });
    status = response?.status() ?? null;
  } catch (err) {
    if ((err as Error).name !== "TimeoutError") {
      throw new UpstreamError("The page could not be loaded", { netError: netErrorName(err) });
    }
    // Analytics beacons and long polling keep some pages from ever going idle;
    // what has rendered by now is still worth reading.
    timedOut = true;
  }

  const metrics = await readMetrics(page);
  const finalUrl = page.url();
  const rendered = extract(await page.content(), finalUrl);
  const raw = await rawPromise;
  const rawExtract = raw ? extract(raw.html, raw.url) : null;

  const rawLinks = new Set(rawExtract?.links.map((l) => l.url) ?? []);
  const comparison: RenderResult["renderedVsRaw"] = rawExtract
    ? {
        available: true,
        titleDiffers: collapse(rendered.title) !== collapse(rawExtract.title),
        descriptionDiffers: collapse(rendered.metaDescription) !== collapse(rawExtract.metaDescription),
        canonicalDiffers: (rendered.canonical ?? "") !== (rawExtract.canonical ?? ""),
        robotsDiffers: collapse(rendered.robotsMeta).toLowerCase() !== collapse(rawExtract.robotsMeta).toLowerCase(),
        h1Differs: rendered.h1s.join("\n") !== rawExtract.h1s.join("\n"),
        linksOnlyInRendered: rendered.links.filter((l) => !rawLinks.has(l.url)).length,
        rawLinks: rawExtract.links.length,
        renderedLinks: rendered.links.length,
      }
    : {
        available: false,
        titleDiffers: false,
        descriptionDiffers: false,
        canonicalDiffers: false,
        robotsDiffers: false,
        h1Differs: false,
        linksOnlyInRendered: 0,
        rawLinks: 0,
        renderedLinks: rendered.links.length,
      };

  const changesApplied = input.changes?.length ? await applyChanges(page, input.changes) : 0;
  const shot = await page.screenshot({ type: "jpeg", quality: 60, scale: "css", timeout: 10_000 });
  const vp = VIEWPORTS[input.device];

  return {
    url: input.url,
    finalUrl,
    status,
    device: input.device,
    timedOut,
    screenshot: shot.toString("base64"),
    width: vp.width,
    height: vp.height,
    seo: seoFrom(rendered),
    console: consoleEntries,
    metrics,
    renderedVsRaw: comparison,
    blockedRequests: input.blockedCount(),
    changesApplied,
  };
}
