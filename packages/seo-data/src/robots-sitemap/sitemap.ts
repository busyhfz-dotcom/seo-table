/**
 * Sitemaps: generate one from the latest scan, validate the site's own, apply
 * the generated one at the edge (or download it), and submit it to Search
 * Console.
 *
 * Generated entries are the pages a sitemap should list and nothing else:
 * answered 200, indexable (no noindex, not blocked by robots.txt), and
 * canonical to themselves. lastmod is the page's Last-Modified header when the
 * server sent one — never the scan date, which would claim every page changed.
 * Image entries (Google's image sitemap extension) are optional. Files split
 * at the protocol's 50,000 URLs (and before 10 MB, the edge's limit per file),
 * with a sitemap index at /sitemap.xml when there is more than one.
 */
import { parseSitemap, parseRobots, type Actor } from "@seo/core";
import { BadRequest } from "@seo/core";
import { submitSitemap } from "@seo/connectors";
import { currentValue, fetchText, key, latestCrawl, projectById, proposeSiteChange, sameHost, type SitePage, type SiteProposal } from "../site.js";
import { liveRobots } from "./robots.js";

export const MAX_URLS_PER_FILE = 50_000;
const MAX_FILE_BYTES = 9.5 * 1024 * 1024;
const MAX_FETCH_BYTES = 50 * 1024 * 1024;
const MAX_CHILD_SITEMAPS = 50;
const MAX_VALIDATED_URLS = 100_000;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export type SitemapFile = { path: string; body: string; urls: number };
export type GeneratedSitemap = {
  status: "ok" | "no_scan";
  runId: string | null;
  scannedAt: string | null;
  files: SitemapFile[];
  urls: number;
  withLastmod: number;
  images: number;
  excluded: Record<string, number>;
};

function exclusion(p: SitePage): string | null {
  if (p.statusCode >= 300 && p.statusCode < 400) return "redirect";
  if (p.statusCode !== 200) return "not_200";
  if (!p.indexable) {
    if (p.noindexReason === "canonicalised_elsewhere") return "not_canonical";
    if (p.noindexReason === "robots_txt_disallow") return "blocked_by_robots";
    if (p.noindexReason === "non_html") return "not_html";
    return "noindex";
  }
  if (p.canonical && p.canonical !== p.normalizedUrl) return "not_canonical";
  return null;
}

function urlEntry(p: Pick<SitePage, "normalizedUrl" | "details">, images: boolean): { text: string; images: number; lastmod: boolean } {
  const lastmod = p.details?.lastModified ? `<lastmod>${p.details.lastModified.toISOString()}</lastmod>` : "";
  const imgs = images ? (p.details?.images ?? []).filter((i) => /^https?:\/\//.test(i.src)).slice(0, 1000) : [];
  const imageXml = imgs.map((i) => `<image:image><image:loc>${xml(i.src)}</image:loc></image:image>`).join("");
  return { text: `<url><loc>${xml(p.normalizedUrl)}</loc>${lastmod}${imageXml}</url>`, images: imgs.length, lastmod: Boolean(lastmod) };
}

function urlset(entries: string[], images: boolean): string {
  const ns = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${images ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' : ""}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${ns}>\n${entries.join("\n")}\n</urlset>\n`;
}

export async function generateSitemap(projectId: string, opts: { images?: boolean } = {}): Promise<GeneratedSitemap> {
  const project = await projectById(projectId);
  const crawl = await latestCrawl(projectId);
  if (!crawl) return { status: "no_scan", runId: null, scannedAt: null, files: [], urls: 0, withLastmod: 0, images: 0, excluded: {} };
  const images = opts.images ?? false;
  const excluded: Record<string, number> = {};
  const listed: SitePage[] = [];
  const seen = new Set<string>();
  for (const p of crawl.pages) {
    const why = exclusion(p) ?? (sameHost(p.normalizedUrl, project.baseUrl) ? null : "other_host");
    if (why) {
      excluded[why] = (excluded[why] ?? 0) + 1;
      continue;
    }
    if (seen.has(p.normalizedUrl)) continue;
    seen.add(p.normalizedUrl);
    listed.push(p);
  }
  // Home first, then by click depth, so the file reads like the site.
  listed.sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99) || a.normalizedUrl.localeCompare(b.normalizedUrl));
  const built = buildSitemapFiles(listed, new URL(project.baseUrl).origin, images);
  return {
    status: "ok",
    runId: crawl.runId,
    scannedAt: crawl.finishedAt?.toISOString() ?? null,
    ...built,
    urls: listed.length,
    excluded,
  };
}

/** The sitemap file(s) for pages already chosen: one urlset, or an index plus parts past 50,000 URLs / ~10 MB. */
export function buildSitemapFiles(
  listed: Array<Pick<SitePage, "normalizedUrl" | "details">>,
  origin: string,
  images: boolean,
): { files: SitemapFile[]; withLastmod: number; images: number } {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  let imageCount = 0;
  let withLastmod = 0;
  for (const p of listed) {
    const entry = urlEntry(p, images);
    imageCount += entry.images;
    if (entry.lastmod) withLastmod++;
    const size = Buffer.byteLength(entry.text, "utf8") + 1;
    if (current.length >= MAX_URLS_PER_FILE || (current.length && bytes + size > MAX_FILE_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry.text);
    bytes += size;
  }
  if (current.length || !chunks.length) chunks.push(current);

  let files: SitemapFile[];
  if (chunks.length === 1) {
    files = [{ path: "/sitemap.xml", body: urlset(chunks[0]!, images), urls: chunks[0]!.length }];
  } else {
    const parts = chunks.map((c, i) => ({ path: `/sitemap-${i + 1}.xml`, body: urlset(c, images), urls: c.length }));
    const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts
      .map((p) => `<sitemap><loc>${xml(`${origin}${p.path}`)}</loc></sitemap>`)
      .join("\n")}\n</sitemapindex>\n`;
    files = [{ path: "/sitemap.xml", body: index, urls: 0 }, ...parts];
  }
  return { files, withLastmod, images: imageCount };
}

// ---------------------------------------------------------------- validation

export type SitemapProblem = "not_200" | "redirect" | "noindex" | "not_canonical" | "blocked_by_robots" | "other_host" | "not_crawled";

export type SitemapValidation = {
  sources: Array<{ url: string; status: number | null; kind: "urlset" | "index" | "invalid" | "unreachable"; urls: number; error?: string }>;
  urls: number;
  truncated: boolean;
  issues: Array<{ code: string; level: "error" | "warning" | "info"; message: { fa: string; en: string }; count?: number }>;
  problems: Record<SitemapProblem, number>;
  /** Up to 500 listed URLs per problem, with what the scan saw. */
  examples: Array<{ url: string; problem: SitemapProblem; status: number | null; detail: string | null }>;
  scannedAt: string | null;
};

const t = (fa: string, en: string) => ({ fa, en });

/**
 * Check the sitemaps the site publishes (the given URL, else the Sitemap lines
 * in robots.txt, else /sitemap.xml) against the latest scan: every listed URL
 * should be a 200, indexable, self-canonical page on this site.
 */
export async function validateSitemaps(projectId: string, input: { url?: string } = {}): Promise<SitemapValidation> {
  const project = await projectById(projectId);
  if (input.url && !sameHost(input.url, project.baseUrl)) throw new BadRequest("The sitemap must be on this project's site", { field: "url" });
  let roots: string[];
  if (input.url) roots = [input.url];
  else {
    const robots = await liveRobots(projectId);
    const declared = robots.state === "ok" ? parseRobots(robots.body).sitemaps : [];
    roots = declared.length ? declared.slice(0, 10) : [new URL("/sitemap.xml", project.baseUrl).toString()];
  }
  const sources: SitemapValidation["sources"] = [];
  const issues: SitemapValidation["issues"] = [];
  const listed: string[] = [];
  const queue = [...roots];
  const visited = new Set<string>();
  let truncated = false;
  while (queue.length && visited.size < MAX_CHILD_SITEMAPS) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (!sameHost(url, project.baseUrl)) {
      issues.push({ code: "sitemap_other_host", level: "warning", message: t(`نقشهٔ ${url} روی دامنهٔ دیگری است و بررسی نشد.`, `${url} is on another host and was not checked.`) });
      continue;
    }
    let res;
    try {
      res = await fetchText(url, { accept: "application/xml,text/xml,*/*", maxBytes: MAX_FETCH_BYTES, sameSiteAs: project.baseUrl });
    } catch (err) {
      sources.push({ url, status: null, kind: "unreachable", urls: 0, error: (err as Error).message });
      continue;
    }
    if (res.hops.length) issues.push({ code: "sitemap_redirects", level: "warning", message: t(`نشانی نقشهٔ ${url} ریدایرکت می‌شود؛ نشانی نهایی را معرفی کنید.`, `${url} redirects; list the final address instead.`) });
    if (res.status !== 200) {
      sources.push({ url, status: res.status, kind: "unreachable", urls: 0 });
      continue;
    }
    if (res.truncated) issues.push({ code: "sitemap_too_large", level: "error", message: t(`${url} از ۵۰ مگابایت بزرگ‌تر است.`, `${url} is larger than 50 MB.`) });
    const body = res.body.trim();
    const isXml = /^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<(?:[\w-]+:)?(urlset|sitemapindex)\b/i.exec(body);
    if (!isXml) {
      sources.push({ url, status: res.status, kind: "invalid", urls: 0, error: "not a sitemap XML document" });
      issues.push({ code: "sitemap_invalid", level: "error", message: t(`${url} سند XML نقشهٔ سایت نیست.`, `${url} is not a sitemap XML document.`) });
      continue;
    }
    if (!/xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/.test(body)) {
      issues.push({ code: "sitemap_namespace", level: "warning", message: t(`${url} فضای نام استاندارد sitemaps.org را اعلام نکرده است.`, `${url} does not declare the sitemaps.org namespace.`) });
    }
    const parsed = parseSitemap(body);
    const badLastmod = [...body.matchAll(/<lastmod>\s*([^<]*?)\s*<\/lastmod>/gi)].filter((m) => !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(m[1]!)).length;
    if (badLastmod) issues.push({ code: "bad_lastmod", level: "warning", count: badLastmod, message: t(`${badLastmod} مقدار lastmod در ${url} قالب W3C Datetime ندارد.`, `${badLastmod} lastmod values in ${url} are not W3C Datetime.`) });
    if (isXml[3]?.toLowerCase() === "sitemapindex") {
      sources.push({ url, status: res.status, kind: "index", urls: parsed.sitemaps.length });
      queue.push(...parsed.sitemaps);
      continue;
    }
    if (parsed.urls.length > MAX_URLS_PER_FILE) issues.push({ code: "too_many_urls", level: "error", message: t(`${url} بیش از ۵۰٬۰۰۰ نشانی دارد؛ آن را تقسیم کنید.`, `${url} lists more than 50,000 URLs; split it.`) });
    sources.push({ url, status: res.status, kind: "urlset", urls: parsed.urls.length });
    for (const u of parsed.urls) {
      if (listed.length >= MAX_VALIDATED_URLS) {
        truncated = true;
        break;
      }
      listed.push(u);
    }
  }
  if (queue.length) truncated = true;

  const crawl = await latestCrawl(projectId);
  const problems: Record<SitemapProblem, number> = { not_200: 0, redirect: 0, noindex: 0, not_canonical: 0, blocked_by_robots: 0, other_host: 0, not_crawled: 0 };
  const examples: SitemapValidation["examples"] = [];
  const perProblem = new Map<SitemapProblem, number>();
  const note = (url: string, problem: SitemapProblem, status: number | null, detail: string | null) => {
    problems[problem]++;
    const n = perProblem.get(problem) ?? 0;
    if (n < 500) examples.push({ url, problem, status, detail });
    perProblem.set(problem, n + 1);
  };
  const dupes = new Set<string>();
  let duplicates = 0;
  for (const raw of listed) {
    const k = key(raw);
    if (dupes.has(k)) {
      duplicates++;
      continue;
    }
    dupes.add(k);
    if (!sameHost(raw, project.baseUrl)) {
      note(raw, "other_host", null, null);
      continue;
    }
    const page = crawl?.byUrl.get(k);
    if (!page) {
      note(raw, "not_crawled", null, null);
      continue;
    }
    const why = exclusion(page);
    if (why === "redirect") note(raw, "redirect", page.statusCode, page.redirectTarget);
    else if (why === "not_200") note(raw, "not_200", page.statusCode, null);
    else if (why === "not_canonical") note(raw, "not_canonical", page.statusCode, page.canonical);
    else if (why === "blocked_by_robots") note(raw, "blocked_by_robots", page.statusCode, null);
    else if (why === "noindex" || why === "not_html") note(raw, "noindex", page.statusCode, page.noindexReason);
  }
  if (duplicates) issues.push({ code: "duplicate_urls", level: "info", count: duplicates, message: t(`${duplicates} نشانی بیش از یک بار آمده است.`, `${duplicates} URLs are listed more than once.`) });
  if (!sources.some((s) => s.kind === "urlset" || s.kind === "index")) {
    issues.push({ code: "no_sitemap", level: "error", message: t("هیچ نقشهٔ سایت معتبری پیدا نشد.", "No valid sitemap was found.") });
  }
  if (!crawl) issues.push({ code: "no_scan", level: "info", message: t("سایت هنوز اسکن نشده؛ وضعیت نشانی‌ها بررسی نشد.", "The site has not been scanned yet, so the listed URLs were not checked.") });
  return { sources, urls: listed.length, truncated, issues, problems, examples, scannedAt: crawl?.finishedAt?.toISOString() ?? null };
}

// ---------------------------------------------------------------- apply and submit

/** Serve the generated sitemap files from the edge, through the fix pipeline (SITEMAP_XML, SENSITIVE). */
export async function proposeSitemap(input: { projectId: string; orgId: string; actor: Actor; images?: boolean }): Promise<SiteProposal & { sitemap: GeneratedSitemap }> {
  const sitemap = await generateSitemap(input.projectId, { images: input.images ?? false });
  if (sitemap.status !== "ok" || sitemap.urls === 0) throw new BadRequest("Scan the site first: the sitemap is built from the latest scan");
  const project = await projectById(input.projectId);
  const origin = new URL(project.baseUrl).origin;
  const changes = [];
  for (const file of sitemap.files) {
    const url = `${origin}${file.path}`;
    changes.push({ url, field: "sitemap_xml", before: await currentValue(input.projectId, url, "sitemap_xml"), after: file.body });
  }
  const result = await proposeSiteChange({
    projectId: input.projectId,
    orgId: input.orgId,
    actor: input.actor,
    action: "SITEMAP_XML",
    ruleId: "tool.sitemap_xml",
    title: "Serve a sitemap generated from the latest scan",
    rationale: `${sitemap.urls} indexable, self-canonical pages in ${sitemap.files.length} file(s)${sitemap.images ? ` with ${sitemap.images} images` : ""}.`,
    changes,
  });
  return { ...result, sitemap };
}

export async function submitToSearchConsole(projectId: string, sitemapUrl?: string): Promise<{ sitemapUrl: string }> {
  const project = await projectById(projectId);
  const url = sitemapUrl ?? new URL("/sitemap.xml", project.baseUrl).toString();
  if (!sameHost(url, project.baseUrl)) throw new BadRequest("The sitemap must be on this project's site", { field: "sitemapUrl" });
  await submitSitemap(projectId, url);
  return { sitemapUrl: url };
}
