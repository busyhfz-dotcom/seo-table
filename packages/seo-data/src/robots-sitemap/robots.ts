/**
 * robots.txt: read the live file, test URLs against it, validate an edited
 * version, show the diff and what it would newly block, and apply it through
 * the fix pipeline (the Cloudflare edge serves it) — or download it.
 *
 * The verdict for a URL always comes from @seo/core's parser (the one the
 * crawler obeys, RFC 9309: longest match wins, Allow wins a tie, a named
 * group replaces `*`). This module adds the explanation: which group and
 * which line decided, found with the same matching rules.
 */
import { BadRequest, isAllowed, normalizeRobotsPath, parseRobots, productToken, type Actor } from "@seo/core";
import { withDeps, type Deps } from "../deps.js";
import { currentValue, fetchText, key, latestCrawl, projectById, proposeSiteChange, type SiteProposal } from "../site.js";
import { cachedGsc } from "../content/context.js";
import { diffLines, type DiffLine } from "./diff.js";

export const MAX_ROBOTS_BYTES = 500 * 1024;
export const DEFAULT_AGENTS = ["Googlebot", "Bingbot", "*"];

const t = (fa: string, en: string) => ({ fa, en });

export type RobotsFile = {
  url: string;
  /** ok: 200; missing: 4xx (everything allowed); unreachable: 5xx/network (Google stops crawling). */
  state: "ok" | "missing" | "unreachable";
  status: number | null;
  body: string;
  /** Served by the SEO Table edge worker instead of the origin. */
  servedByEdge: boolean;
};

export async function liveRobots(projectId: string): Promise<RobotsFile> {
  const project = await projectById(projectId);
  const url = new URL("/robots.txt", project.baseUrl).toString();
  try {
    const res = await fetchText(url, { accept: "text/plain,*/*", maxBytes: MAX_ROBOTS_BYTES + 1024, sameSiteAs: project.baseUrl });
    const state = res.status === 200 ? "ok" : res.status >= 400 && res.status < 500 ? "missing" : "unreachable";
    return { url, state, status: res.status, body: state === "ok" ? res.body : "", servedByEdge: false };
  } catch {
    return { url, state: "unreachable", status: null, body: "", servedByEdge: false };
  }
}

// ---------------------------------------------------------------- explanation

type LineRule = { allow: boolean; pattern: string; raw: string; line: number };

function groupsWithLines(text: string): Map<string, LineRule[]> {
  const groups = new Map<string, LineRule[]>();
  let agents: string[] = [];
  let lastWasAgent = false;
  text.split(/\r?\n|\r/).forEach((rawLine, i) => {
    const line = rawLine.replace(/#.*$/, "").trim();
    const idx = line.indexOf(":");
    if (!line || idx === -1) return;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent) agents = [];
      const agent = productToken(value);
      agents.push(agent);
      if (!groups.has(agent)) groups.set(agent, []);
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if ((field === "allow" || field === "disallow") && value && agents.length) {
      for (const a of agents) groups.get(a)!.push({ allow: field === "allow", pattern: normalizeRobotsPath(value), raw: rawLine.trim(), line: i + 1 });
    }
  });
  return groups;
}

function patternRegex(pattern: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") src += ".*";
    else if (ch === "$" && i === pattern.length - 1) src += "$";
    else src += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}`);
}

export type RobotsVerdict = {
  url: string;
  userAgent: string;
  allowed: boolean;
  /** The group that applied: the agent's product token, "*", or null (no group: everything allowed). */
  group: string | null;
  rule: { allow: boolean; pattern: string; line: number; text: string } | null;
};

export function explain(robotsText: string, url: string, userAgent: string): RobotsVerdict {
  const robots = parseRobots(robotsText);
  const allowed = isAllowed(robots, url, userAgent);
  const groups = groupsWithLines(robotsText);
  const token = productToken(userAgent);
  const group = token && token !== "*" && groups.has(token) ? token : groups.has("*") ? "*" : null;
  let rule: RobotsVerdict["rule"] = null;
  if (group) {
    let path = "/";
    try {
      const u = new URL(url);
      path = normalizeRobotsPath(`${u.pathname}${u.search}`);
    } catch {
      /* the verdict above already refused an invalid URL */
    }
    let best = -1;
    for (const r of groups.get(group) ?? []) {
      if (!patternRegex(r.pattern).test(path)) continue;
      if (r.pattern.length > best || (r.pattern.length === best && r.allow)) {
        best = r.pattern.length;
        rule = { allow: r.allow, pattern: r.pattern, line: r.line, text: r.raw };
      }
    }
  }
  return { url, userAgent, allowed, group, rule };
}

// ---------------------------------------------------------------- validation

export type RobotsIssue = { line: number | null; level: "error" | "warning" | "info"; code: string; message: { fa: string; en: string } };

const KNOWN = new Set(["user-agent", "allow", "disallow", "sitemap", "crawl-delay", "host", "clean-param", "noindex"]);

export function validateRobots(text: string, siteUrl: string): RobotsIssue[] {
  const issues: RobotsIssue[] = [];
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_ROBOTS_BYTES) {
    issues.push({ line: null, level: "error", code: "too_large", message: t("فایل از ۵۰۰ کیلوبایت بزرگ‌تر است؛ گوگل بقیهٔ آن را نمی‌خواند.", "The file is over 500 KiB; Google ignores everything after that.") });
  }
  if (/<\s*(html|body|head)\b/i.test(text)) {
    issues.push({ line: null, level: "error", code: "html", message: t("این محتوا صفحهٔ HTML است، نه robots.txt.", "This is an HTML page, not a robots.txt file.") });
  }
  let sawAgent = false;
  text.split(/\r?\n|\r/).forEach((rawLine, i) => {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) return;
    const n = i + 1;
    const idx = line.indexOf(":");
    if (idx === -1) {
      issues.push({ line: n, level: "error", code: "no_colon", message: t("این خط «نام: مقدار» نیست و نادیده گرفته می‌شود.", 'This line is not "field: value" and is ignored.') });
      return;
    }
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!KNOWN.has(field)) {
      issues.push({ line: n, level: "warning", code: "unknown_directive", message: t(`دستور «${field}» شناخته‌شده نیست و گوگل آن را نادیده می‌گیرد.`, `"${field}" is not a known directive; Google ignores it.`) });
      return;
    }
    if (field === "user-agent") {
      sawAgent = true;
      if (!value) issues.push({ line: n, level: "error", code: "empty_agent", message: t("User-agent بدون مقدار است.", "User-agent has no value.") });
      return;
    }
    if (field === "sitemap") {
      let ok = false;
      try {
        ok = /^https?:$/.test(new URL(value).protocol);
      } catch {
        ok = false;
      }
      if (!ok) issues.push({ line: n, level: "error", code: "sitemap_not_absolute", message: t("نشانی Sitemap باید کامل باشد (با https://).", "A Sitemap address must be absolute (with https://).") });
      return;
    }
    if (field === "crawl-delay") {
      issues.push({ line: n, level: "info", code: "crawl_delay_ignored", message: t("گوگل Crawl-delay را نادیده می‌گیرد (بینگ و یاندکس رعایت می‌کنند).", "Google ignores Crawl-delay (Bing and Yandex honour it).") });
      return;
    }
    if (field === "noindex") {
      issues.push({ line: n, level: "error", code: "noindex_unsupported", message: t("دستور noindex در robots.txt از ۲۰۱۹ پشتیبانی نمی‌شود؛ از متای robots استفاده کنید.", "noindex in robots.txt has not been supported since 2019; use the robots meta tag.") });
      return;
    }
    if (field === "host" || field === "clean-param") {
      issues.push({ line: n, level: "info", code: "yandex_only", message: t(`«${field}» فقط برای یاندکس معنا دارد.`, `"${field}" only means something to Yandex.`) });
      return;
    }
    if (!sawAgent) {
      issues.push({ line: n, level: "error", code: "rule_before_agent", message: t("این قانون پیش از هر User-agent آمده و به هیچ خزنده‌ای اعمال نمی‌شود.", "This rule comes before any User-agent line and applies to no crawler.") });
      return;
    }
    if (value && !value.startsWith("/") && !value.startsWith("*")) {
      issues.push({ line: n, level: "warning", code: "pattern_not_path", message: t("الگو باید با / یا * شروع شود.", "A pattern should start with / or *.") });
    }
  });
  const robots = parseRobots(text);
  for (const agent of ["googlebot", "*"]) {
    const rules = robots.groups.get(agent);
    if (rules?.some((r) => !r.allow && r.pattern === "/") && !isAllowed(robots, new URL("/", siteUrl).toString(), agent === "*" ? "AnyBot" : "Googlebot")) {
      issues.push({
        line: null,
        level: "warning",
        code: "blocks_site",
        message: t(`«Disallow: /» برای ${agent === "*" ? "همهٔ خزنده‌ها" : "گوگل"} کل سایت را از خزش خارج می‌کند.`, `"Disallow: /" for ${agent === "*" ? "every crawler" : "Google"} keeps the whole site from being crawled.`),
      });
    }
  }
  for (const asset of ["/wp-includes/js/jquery/jquery.min.js", "/wp-content/themes/x/style.css"]) {
    const url = new URL(asset, siteUrl).toString();
    if (!isAllowed(robots, url, "Googlebot") && /wp-(includes|content)/.test(text)) {
      issues.push({ line: null, level: "warning", code: "blocks_assets", message: t("فایل‌های CSS/JS قالب مسدود شده‌اند؛ گوگل صفحه را بدون آن‌ها درست نمی‌بیند.", "Theme CSS/JS files are blocked; Google cannot render pages properly without them.") });
      break;
    }
  }
  if (!robots.sitemaps.length) {
    issues.push({ line: null, level: "info", code: "no_sitemap_line", message: t("خط Sitemap ندارد؛ افزودن آن به خزنده‌ها نقشهٔ سایت را معرفی می‌کند.", "No Sitemap line; adding one tells every crawler where the sitemap is.") });
  }
  return issues;
}

// ---------------------------------------------------------------- review and apply

export type RobotsReview = {
  issues: RobotsIssue[];
  diff: DiffLine[];
  /** Important URLs Googlebot may crawl now but not under the new file. */
  newlyBlocked: Array<{ url: string; clicks: number | null; rule: RobotsVerdict["rule"] }>;
  newlyAllowed: number;
  checkedUrls: number;
  current: RobotsFile;
};

/** Homepage, top Search Console pages and indexable crawled pages: what must stay crawlable. */
async function importantUrls(projectId: string, baseUrl: string, deps: Deps): Promise<Array<{ url: string; clicks: number | null }>> {
  const out = new Map<string, { url: string; clicks: number | null }>();
  out.set(key(baseUrl), { url: new URL("/", baseUrl).toString(), clicks: null });
  const gsc = await cachedGsc(projectId, deps);
  if (gsc) {
    for (const [url, c] of [...gsc.clicks].sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 200)) out.set(url, { url, clicks: c.clicks });
  }
  const crawl = await latestCrawl(projectId);
  for (const p of crawl?.pages ?? []) {
    if (out.size >= 1000) break;
    if (p.statusCode === 200 && p.indexable && !out.has(p.normalizedUrl)) out.set(p.normalizedUrl, { url: p.url, clicks: gsc?.clicks.get(p.normalizedUrl)?.clicks ?? null });
  }
  return [...out.values()];
}

export async function reviewRobots(projectId: string, proposed: string, partial: Partial<Deps> = {}): Promise<RobotsReview> {
  const deps = withDeps(partial);
  const project = await projectById(projectId);
  const current = await liveRobots(projectId);
  const currentRobots = parseRobots(current.body, current.state);
  const next = parseRobots(proposed);
  const urls = await importantUrls(projectId, project.baseUrl, deps);
  const newlyBlocked: RobotsReview["newlyBlocked"] = [];
  let newlyAllowed = 0;
  for (const u of urls) {
    const before = isAllowed(currentRobots, u.url, "Googlebot");
    const after = isAllowed(next, u.url, "Googlebot");
    if (before && !after) newlyBlocked.push({ ...u, rule: explain(proposed, u.url, "Googlebot").rule });
    if (!before && after) newlyAllowed++;
  }
  newlyBlocked.sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1));
  return {
    issues: validateRobots(proposed, project.baseUrl),
    diff: diffLines(current.body, proposed),
    newlyBlocked: newlyBlocked.slice(0, 200),
    newlyAllowed,
    checkedUrls: urls.length,
    current,
  };
}

/**
 * Propose the file through the fix pipeline (ROBOTS_TXT, SENSITIVE). A file
 * with errors is refused; one that newly blocks pages Googlebot crawls today
 * is raised to RESTRICTED, so the approver sees it as a site-level risk.
 */
export async function proposeRobots(input: { projectId: string; orgId: string; actor: Actor; content: string }, partial: Partial<Deps> = {}): Promise<SiteProposal & { review: RobotsReview }> {
  const content = input.content.replace(/\r\n?/g, "\n");
  const review = await reviewRobots(input.projectId, content, partial);
  const errors = review.issues.filter((i) => i.level === "error");
  if (errors.length) throw new BadRequest("The robots.txt has errors; fix them before applying", { issues: errors });
  if (content.trim() === review.current.body.trim()) throw new BadRequest("The file is the same as the live one");
  const url = review.current.url;
  const before = await currentValue(input.projectId, url, "robots_txt");
  const result = await proposeSiteChange({
    projectId: input.projectId,
    orgId: input.orgId,
    actor: input.actor,
    action: "ROBOTS_TXT",
    ruleId: "tool.robots_txt",
    title: "Replace robots.txt",
    rationale: `Edited robots.txt: ${review.diff.filter((d) => d.op !== "=").length} lines change; ${review.newlyBlocked.length} crawled pages become blocked for Googlebot.`,
    changes: [{ url, field: "robots_txt", before, after: content.endsWith("\n") ? content : `${content}\n` }],
    ...(review.newlyBlocked.length ? { risk: "RESTRICTED" as const } : {}),
  });
  return { ...result, review };
}

/** A sensible starting file for a site without one: everything crawlable, the sitemap announced. */
export function defaultRobots(siteUrl: string): string {
  return ["User-agent: *", "Disallow:", "", `Sitemap: ${new URL("/sitemap.xml", siteUrl).toString()}`, ""].join("\n");
}
