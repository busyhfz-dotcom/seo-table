/**
 * The fix pack: every fix the audit proposes, as files a site owner (or their
 * developer) can apply by hand when nothing can be connected.
 *
 * Only what the audit actually found goes in. A pack for a site with no
 * redirect proposals has no redirect files; a site with a robots.txt gets no
 * robots.txt suggestion. The README (Persian, then English) describes exactly
 * the files that are present.
 *
 * Sources: proposals that are still open (not applied, rejected or rolled
 * back) and the page snapshots of the run — the latest successful one unless
 * a run is named — for the values each page has now. With a run named, only
 * proposals whose issue that run saw are included.
 */
import { zipSync } from "fflate";
import {
  and,
  auditRuns,
  db,
  desc,
  eq,
  fixProposals,
  inArray,
  pageSnapshots,
  projects,
  seoIssues,
  type FixProposal,
  type PageSnapshot,
} from "@seo/db";
import { NotFound } from "@seo/core";

export type FixPackFile = { path: string; contentType: string; body: string };
export type FixPack = { files: FixPackFile[]; runId: string | null; counts: Record<string, number> };

type Change = { url: string; field: string; before: string | null; after: string; selector?: string };
type Row = { proposal: FixProposal; change: Change };

const OPEN_STATUSES: FixProposal["status"][] = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "FAILED"];
const SITEMAP_LIMIT = 50_000;
const META_FIELDS = ["title", "meta_description", "canonical", "meta_robots"] as const;

export async function buildFixPack(projectId: string, runId?: string): Promise<FixPack> {
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) throw new NotFound("Project not found");

  const run = runId
    ? (await db.select().from(auditRuns).where(and(eq(auditRuns.id, runId), eq(auditRuns.projectId, projectId))).limit(1))[0]
    : (
        await db
          .select()
          .from(auditRuns)
          .where(and(eq(auditRuns.projectId, projectId), eq(auditRuns.status, "SUCCEEDED")))
          .orderBy(desc(auditRuns.finishedAt), desc(auditRuns.id))
          .limit(1)
      )[0];
  if (runId && !run) throw new NotFound("Run not found");

  const snapshots = run ? await db.select().from(pageSnapshots).where(eq(pageSnapshots.auditRunId, run.id)) : [];
  const byUrl = new Map(snapshots.map((s) => [s.normalizedUrl, s]));

  let proposals = await db
    .select()
    .from(fixProposals)
    .where(and(eq(fixProposals.projectId, projectId), inArray(fixProposals.status, OPEN_STATUSES)))
    .orderBy(fixProposals.createdAt);
  const issues = await db.select().from(seoIssues).where(and(eq(seoIssues.projectId, projectId), eq(seoIssues.status, "OPEN")));
  const openRules = new Set(issues.filter((i) => !runId || i.lastSeenRunId === runId).map((i) => i.ruleId));
  if (runId) {
    const seen = new Set(issues.filter((i) => i.lastSeenRunId === runId).map((i) => i.id));
    proposals = proposals.filter((p) => p.issueId && seen.has(p.issueId));
  }

  const rows: Row[] = proposals.flatMap((proposal) => ((proposal.changes as Change[]) ?? []).map((change) => ({ proposal, change })));
  const redirects = rows.filter((r) => r.change.field === "redirect" && r.proposal.action === "REDIRECT");
  const meta = rows.filter((r) => (META_FIELDS as readonly string[]).includes(r.change.field));
  const alts = rows.filter((r) => r.change.field === "img.alt");
  const jsonld = rows.filter((r) => r.change.field === "jsonld");

  const files: FixPackFile[] = [];
  const counts: Record<string, number> = {};
  const base = project.baseUrl;

  if (redirects.length) {
    files.push(nginxRedirects(redirects), apacheRedirects(redirects));
    const csv = cloudflareBulkRedirects(redirects);
    if (csv) files.push(csv);
    counts.redirects = redirects.length;
  }
  if (meta.length) {
    files.push(metaTable(meta, byUrl));
    counts.meta = new Set(meta.map((r) => r.change.url)).size;
  }
  if (alts.length) {
    files.push(altTable(alts));
    counts.images = alts.length;
  }
  for (const r of jsonld) files.push(jsonLdSnippet(r));
  if (jsonld.length) counts.jsonld = jsonld.length;

  const needsSitemap = openRules.has("rule.sitemap.missing") || rows.some((r) => r.proposal.action === "SITEMAP_ADD");
  if (needsSitemap && snapshots.length) {
    files.push(sitemap(snapshots));
    counts.sitemap = Math.min(snapshots.filter(indexable).length, SITEMAP_LIMIT);
  }
  if (openRules.has("rule.robots.missing")) {
    files.push(robotsTxt(base, files.some((f) => f.path === "sitemap.xml")));
    counts.robots = 1;
  }

  files.unshift(readme(project.name, base, files, redirects));
  return { files, runId: run?.id ?? null, counts };
}

export function zipFixPack(pack: FixPack): Uint8Array {
  const enc = new TextEncoder();
  return zipSync(Object.fromEntries(pack.files.map((f) => [f.path, enc.encode(f.body)])), { level: 6 });
}

// ---- redirects --------------------------------------------------------------

function redirectPairs(rows: Row[]): Array<{ from: URL; to: string }> {
  const seen = new Set<string>();
  const out: Array<{ from: URL; to: string }> = [];
  for (const r of rows) {
    let from: URL;
    try {
      from = new URL(r.change.url);
      new URL(r.change.after);
    } catch {
      continue;
    }
    const key = from.pathname + from.search;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to: r.change.after });
  }
  return out;
}

function nginxRedirects(rows: Row[]): FixPackFile {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines = [
    "# SEO Table — redirects for nginx.",
    "# 1) Put the map block in the http { } context (e.g. /etc/nginx/conf.d/seo-table-redirects.conf).",
    "# 2) Put the if block inside the site's server { } block. Then: nginx -t && nginx -s reload",
    "",
    "map $request_uri $seo_table_redirect {",
    "    default \"\";",
    ...redirectPairs(rows).map((p) => `    ${q(p.from.pathname + p.from.search)} ${q(p.to)};`),
    "}",
    "",
    "# server { ...",
    "#     if ($seo_table_redirect) { return 301 $seo_table_redirect; }",
    "# }",
    "",
  ];
  return { path: "redirects/nginx.conf", contentType: "text/plain; charset=utf-8", body: lines.join("\n") };
}

function apacheRedirects(rows: Row[]): FixPackFile {
  const lines = [
    "# SEO Table — redirects for Apache (.htaccess or the virtual host).",
    "# Paste above the WordPress block (# BEGIN WordPress) if there is one.",
    "<IfModule mod_rewrite.c>",
    "RewriteEngine On",
  ];
  for (const p of redirectPairs(rows)) {
    let path = p.from.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* matched as written */
    }
    // RewriteRule sees the decoded path without its leading slash.
    const pattern = `^${escapeRegex(path.replace(/^\//, ""))}$`;
    const query = p.from.search.slice(1);
    // Without a query in the source, any query (campaign tags) still redirects and is kept.
    if (query) lines.push(`RewriteCond %{QUERY_STRING} ^${escapeRegex(query)}$`);
    lines.push(`RewriteRule ${pattern.replace(/ /g, "\\ ")} ${p.to.replace(/ /g, "%20")} [R=301,L${query ? ",QSD" : ""}]`);
  }
  lines.push("</IfModule>", "");
  return { path: "redirects/apache.htaccess", contentType: "text/plain; charset=utf-8", body: lines.join("\n") };
}

/** Cloudflare Bulk Redirects list import: no header row, source without scheme, no query. */
function cloudflareBulkRedirects(rows: Row[]): FixPackFile | null {
  const lines = redirectPairs(rows)
    .filter((p) => !p.from.search)
    .map((p) => [`${p.from.host}${p.from.pathname}`, p.to, "301", "TRUE", "FALSE", "FALSE", "FALSE"].map(csvCell).join(","));
  if (!lines.length) return null;
  return { path: "redirects/cloudflare-bulk-redirects.csv", contentType: "text/csv; charset=utf-8", body: `${lines.join("\r\n")}\r\n` };
}

// ---- tables -----------------------------------------------------------------

function metaTable(rows: Row[], byUrl: Map<string, PageSnapshot>): FixPackFile {
  const header = [
    "url",
    "current_title",
    "proposed_title",
    "current_meta_description",
    "proposed_meta_description",
    "current_canonical",
    "proposed_canonical",
    "current_robots",
    "proposed_robots",
    "status",
  ];
  const pages = new Map<string, { proposed: Partial<Record<(typeof META_FIELDS)[number], string>>; statuses: Set<string> }>();
  for (const r of rows) {
    const page = pages.get(r.change.url) ?? { proposed: {}, statuses: new Set<string>() };
    page.proposed[r.change.field as (typeof META_FIELDS)[number]] = r.change.after;
    page.statuses.add(r.proposal.status);
    pages.set(r.change.url, page);
  }
  const lines = [header.join(",")];
  for (const [url, page] of pages) {
    const snap = byUrl.get(url);
    const current = {
      title: snap?.title ?? "",
      meta_description: snap?.metaDescription ?? "",
      canonical: snap?.canonical ?? "",
      meta_robots: snap?.robotsMeta ?? snap?.xRobotsTag ?? "",
    };
    lines.push(
      [
        url,
        current.title,
        page.proposed.title ?? "",
        current.meta_description,
        page.proposed.meta_description ?? "",
        current.canonical,
        page.proposed.canonical ?? "",
        current.meta_robots,
        page.proposed.meta_robots ?? "",
        [...page.statuses].join(" "),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // The BOM makes Excel read the Persian text as UTF-8.
  return { path: "meta/pages.csv", contentType: "text/csv; charset=utf-8", body: `\uFEFF${lines.join("\r\n")}\r\n` };
}

function altTable(rows: Row[]): FixPackFile {
  const lines = ["page_url,image_src,proposed_alt,status"];
  for (const r of rows) lines.push([r.change.url, r.change.selector ?? "", r.change.after, r.proposal.status].map(csvCell).join(","));
  return { path: "meta/image-alt.csv", contentType: "text/csv; charset=utf-8", body: `\uFEFF${lines.join("\r\n")}\r\n` };
}

function jsonLdSnippet(r: Row): FixPackFile {
  let pretty = r.change.after;
  try {
    pretty = JSON.stringify(JSON.parse(r.change.after), null, 2);
  } catch {
    /* shipped as proposed */
  }
  const slug = (new URL(r.change.url).pathname.replace(/^\/|\/$/g, "").replace(/[^\p{L}\p{N}]+/gu, "-") || "home").slice(0, 80);
  return {
    path: `jsonld/${slug}.html`,
    contentType: "text/html; charset=utf-8",
    body: `<!-- ${r.change.url} — paste inside <head> -->\n<script type="application/ld+json">\n${pretty.replace(/</g, "\\u003c")}\n</script>\n`,
  };
}

// ---- sitemap and robots.txt ---------------------------------------------------

const indexable = (s: PageSnapshot) => s.statusCode === 200 && s.indexable;

function sitemap(snapshots: PageSnapshot[]): FixPackFile {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const urls = snapshots
    .filter(indexable)
    .map((s) => s.normalizedUrl)
    .sort()
    .slice(0, SITEMAP_LIMIT);
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
  return { path: "sitemap.xml", contentType: "application/xml; charset=utf-8", body };
}

/** Allows everything; names the sitemap only when this pack ships one (the site's own may live anywhere). */
function robotsTxt(base: string, withSitemap: boolean): FixPackFile {
  const lines = ["User-agent: *", "Disallow:", ""];
  if (withSitemap) lines.push(`Sitemap: ${new URL("/sitemap.xml", base).toString()}`, "");
  return { path: "robots.txt", contentType: "text/plain; charset=utf-8", body: lines.join("\n") };
}

// ---- README ---------------------------------------------------------------------

function readme(projectName: string, base: string, files: FixPackFile[], redirects: Row[]): FixPackFile {
  const has = (path: string) => files.some((f) => f.path === path);
  const hasJsonLd = files.some((f) => f.path.startsWith("jsonld/"));
  const skippedQueryRedirects = redirectPairs(redirects).filter((p) => p.from.search).length;
  const fa: string[] = [`# بستهٔ اصلاحات سئو — ${projectName}`, "", `سایت: ${base}`, "", "این بسته فقط اصلاح‌هایی را دارد که بررسی سایت پیشنهاد کرده است. هر فایل را پیش از اعمال بخوانید و از سایت نسخهٔ پشتیبان بگیرید.", ""];
  const en: string[] = [`# SEO fix pack — ${projectName}`, "", `Site: ${base}`, "", "This pack holds only the fixes the audit proposed. Read each file before applying it, and back up the site first.", ""];
  if (has("redirects/nginx.conf")) {
    fa.push(
      "## ریدایرکت‌ها",
      "- `redirects/nginx.conf` برای nginx: بلوک map را در بخش http بگذارید و خط if را داخل بلوک server سایت؛ سپس `nginx -t` و بارگذاری دوباره.",
      "- `redirects/apache.htaccess` برای Apache: محتوا را بالای بخش «BEGIN WordPress» در فایل ‎.htaccess‎ بچسبانید.",
    );
    en.push(
      "## Redirects",
      "- `redirects/nginx.conf` for nginx: put the map block in the http context and the if line inside the site's server block, then `nginx -t` and reload.",
      "- `redirects/apache.htaccess` for Apache: paste it above the `# BEGIN WordPress` block in .htaccess.",
    );
    if (has("redirects/cloudflare-bulk-redirects.csv")) {
      fa.push("- `redirects/cloudflare-bulk-redirects.csv` برای Cloudflare: در داشبورد Cloudflare به Rules ← Redirect Rules ← Bulk Redirects بروید، یک فهرست بسازید و این فایل را وارد کنید، سپس یک قانون Bulk Redirect برای آن فهرست فعال کنید.");
      en.push("- `redirects/cloudflare-bulk-redirects.csv` for Cloudflare: in the dashboard go to Rules → Redirect Rules → Bulk Redirects, create a list, import this file, then enable a Bulk Redirect rule for the list.");
    }
    if (skippedQueryRedirects) {
      fa.push(`- ${skippedQueryRedirects} ریدایرکت نشانی دارای پارامتر دارد و Bulk Redirects کلادفلر از آن پشتیبانی نمی‌کند؛ این‌ها فقط در فایل‌های nginx و Apache آمده‌اند.`);
      en.push(`- ${skippedQueryRedirects} redirect(s) have a query string, which Cloudflare Bulk Redirects cannot match; they are only in the nginx and Apache files.`);
    }
    fa.push("- ریدایرکت مسیر نشانی را تغییر می‌دهد؛ پیش از اعمال، مقصد هر مورد را بررسی کنید.", "");
    en.push("- Redirects change where URLs lead; check every destination before applying.", "");
  }
  if (has("meta/pages.csv")) {
    fa.push("## عنوان، توضیحات متا، canonical و robots", "- `meta/pages.csv` برای هر صفحه مقدار فعلی و پیشنهادی را دارد. مقدار پیشنهادی را در ویرایشگر صفحه یا فیلدهای افزونهٔ سئو (مثل Yoast یا Rank Math) وارد کنید. ستون‌های خالی یعنی آن فیلد تغییری لازم ندارد.", "");
    en.push("## Title, meta description, canonical and robots", "- `meta/pages.csv` lists each page's current and proposed values. Enter the proposed value in the page editor or in your SEO plugin's fields (Yoast, Rank Math, …). An empty proposed column means that field needs no change.", "");
  }
  if (has("meta/image-alt.csv")) {
    fa.push("## متن جایگزین تصاویر", "- `meta/image-alt.csv`: برای هر تصویر، متن alt پیشنهادی را در کتابخانهٔ رسانه یا ویرایشگر صفحه وارد کنید.", "");
    en.push("## Image alt text", "- `meta/image-alt.csv`: enter each image's proposed alt text in the media library or the page editor.", "");
  }
  if (hasJsonLd) {
    fa.push("## داده‌های ساختاریافته", "- هر فایل در پوشهٔ `jsonld/` را داخل بخش head همان صفحه قرار دهید.", "");
    en.push("## Structured data", "- Paste each file in `jsonld/` inside the head of the page it names.", "");
  }
  if (has("sitemap.xml")) {
    fa.push("## نقشهٔ سایت", "- `sitemap.xml` همهٔ صفحه‌های قابل ایندکسی را دارد که بررسی دید. آن را در ریشهٔ سایت بارگذاری کنید (یا نقشهٔ سایت افزونهٔ سئو را روشن کنید) و در Search Console ثبت کنید.", "");
    en.push("## Sitemap", "- `sitemap.xml` lists every indexable page the audit saw. Upload it to the site root (or enable your SEO plugin's sitemap) and submit it in Search Console.", "");
  }
  if (has("robots.txt")) {
    fa.push("## robots.txt", "- سایت فایل robots.txt ندارد. `robots.txt` این بسته همه‌چیز را مجاز می‌گذارد؛ آن را در ریشهٔ سایت بارگذاری کنید و اگر نقشهٔ سایت دارید، خط `Sitemap:` با نشانی آن را به آن اضافه کنید.", "");
    en.push("## robots.txt", "- The site has no robots.txt. The `robots.txt` here allows everything; upload it to the site root, and add a `Sitemap:` line with your sitemap's address if it does not name one.", "");
  }
  if (files.length === 0) {
    fa.push("بررسی آخر هیچ اصلاحی پیشنهاد نکرد که بتوان آن را به‌صورت فایل ارائه داد.", "");
    en.push("The last audit proposed no fixes that can be shipped as files.", "");
  }
  return { path: "README.md", contentType: "text/markdown; charset=utf-8", body: [...fa, "---", "", ...en].join("\n") };
}

// ---- helpers -------------------------------------------------------------------

/**
 * A CSV cell, quoted when needed, and never read as a formula: spreadsheet
 * apps execute cells that start with = + - @ (CSV injection).
 */
function csvCell(value: string): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
