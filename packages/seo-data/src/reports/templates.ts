/**
 * Report HTML: one document per kind (audit, executive, keywords) in Persian
 * (RTL, Jalali dates, Persian digits) or English (LTR), white-labelled with
 * the organisation's name, logo and colour. Printed to A4 by Chromium; the
 * page header and footer (with page numbers) are separate templates because
 * Chromium draws them outside the document.
 *
 * Every number names its source; a missing source prints a "not connected"
 * note rather than an empty chart.
 */
import type { ReportKind, Severity } from "@seo/db";
import type { ReportFacts } from "./data.js";
import { CATEGORY_TITLES, RULE_TITLES } from "./rule-titles.js";
import { SEVERITY_COLORS, bar, brandColor, date, delta, esc, fontFaces, gauge, lineChart, logoSrc, num, pct, reportFonts, shortDate, type ReportLocale } from "./kit.js";

type Pair = { fa: string; en: string };
const L = {
  audit: { fa: "گزارش ممیزی سئو", en: "SEO audit report" },
  executive: { fa: "گزارش مدیریتی سئو", en: "Executive SEO report" },
  keywords: { fa: "گزارش کلمات کلیدی", en: "Keyword report" },
  generated: { fa: "تاریخ تهیه", en: "Generated" },
  site: { fa: "سایت", en: "Site" },
  score: { fa: "امتیاز سئو", en: "SEO score" },
  scoreTrend: { fa: "روند امتیاز در اسکن‌های اخیر", en: "Score across recent scans" },
  lastScan: { fa: "آخرین اسکن", en: "Last scan" },
  pagesCrawled: { fa: "صفحهٔ بررسی‌شده", en: "pages crawled" },
  vsPrevious: { fa: "نسبت به اسکن قبلی", en: "vs previous scan" },
  noScan: { fa: "این سایت هنوز اسکن نشده است؛ پس از نخستین اسکن این بخش پر می‌شود.", en: "The site has not been scanned yet; this section fills in after the first scan." },
  issues: { fa: "مشکلات باز", en: "Open issues" },
  topIssues: { fa: "مهم‌ترین مشکلات", en: "Top issues" },
  issue: { fa: "مشکل", en: "Issue" },
  severity: { fa: "شدت", en: "Severity" },
  category: { fa: "دسته", en: "Category" },
  pagesAffected: { fa: "صفحه‌های درگیر", en: "Pages" },
  noIssues: { fa: "مشکل بازی ثبت نشده است.", en: "No open issues." },
  categories: { fa: "کسر امتیاز بر اساس دسته", en: "Score penalty by category" },
  penalty: { fa: "کسر امتیاز", en: "Penalty" },
  worstPages: { fa: "صفحه‌های با کمترین امتیاز", en: "Lowest-scoring pages" },
  page: { fa: "صفحه", en: "Page" },
  crawl: { fa: "وضعیت صفحه‌ها", en: "Pages at a glance" },
  total: { fa: "کل", en: "Total" },
  ok200: { fa: "پاسخ ۲۰۰", en: "HTTP 200" },
  redirects: { fa: "ریدایرکت", en: "Redirects" },
  errors: { fa: "خطا", en: "Errors" },
  indexable: { fa: "قابل ایندکس", en: "Indexable" },
  avgResponse: { fa: "میانگین زمان پاسخ", en: "Average response" },
  ms: { fa: "میلی‌ثانیه", en: "ms" },
  fixes: { fa: "اصلاحات", en: "Fixes" },
  applied30: { fa: "تغییر اعمال‌شده در ۳۰ روز گذشته", en: "changes applied in the last 30 days" },
  awaiting: { fa: "پیشنهاد در انتظار تأیید", en: "proposals awaiting approval" },
  search: { fa: "عملکرد در جست‌وجوی گوگل", en: "Google Search performance" },
  gscSource: { fa: "منبع: Google Search Console", en: "Source: Google Search Console" },
  gscMissing: { fa: "Search Console وصل نیست؛ داده‌ای از عملکرد جست‌وجو در دست نیست.", en: "Search Console is not connected, so there is no search performance data." },
  clicks: { fa: "کلیک", en: "Clicks" },
  impressions: { fa: "نمایش", en: "Impressions" },
  ctr: { fa: "نرخ کلیک", en: "CTR" },
  avgPosition: { fa: "میانگین جایگاه", en: "Avg. position" },
  dailyClicks: { fa: "کلیک روزانه", en: "Daily clicks" },
  topQueries: { fa: "پربازدیدترین جست‌وجوها", en: "Top queries" },
  topPages: { fa: "پربازدیدترین صفحه‌ها", en: "Top pages" },
  query: { fa: "عبارت", en: "Query" },
  position: { fa: "جایگاه", en: "Position" },
  previous: { fa: "دورهٔ قبل", en: "Previous period" },
  cwv: { fa: "سرعت و Core Web Vitals", en: "Speed and Core Web Vitals" },
  cwvSource: { fa: "منبع: PageSpeed Insights (داده‌های میدانی CrUX در صورت وجود)", en: "Source: PageSpeed Insights (CrUX field data where available)" },
  cwvMissing: { fa: "هنوز سرعت صفحه‌ها سنجیده نشده است.", en: "Page speed has not been measured yet." },
  mobile: { fa: "موبایل", en: "Mobile" },
  desktop: { fa: "دسکتاپ", en: "Desktop" },
  passed: { fa: "قبول", en: "Passed" },
  failed: { fa: "رد", en: "Failed" },
  perfScore: { fa: "میانگین امتیاز عملکرد", en: "Avg. performance score" },
  keywordsSection: { fa: "کلمات کلیدی ردیابی‌شده", en: "Tracked keywords" },
  keywordsMissing: { fa: "هنوز کلمهٔ کلیدی‌ای ردیابی نمی‌شود.", en: "No keywords are tracked yet." },
  keyword: { fa: "کلمهٔ کلیدی", en: "Keyword" },
  change: { fa: "تغییر", en: "Change" },
  gains: { fa: "بیشترین بهبود", en: "Biggest gains" },
  losses: { fa: "بیشترین افت", en: "Biggest losses" },
  visibility: { fa: "شاخص دیده‌شدن (۹۰ روز)", en: "Visibility index (90 days)" },
  visibilityNote: {
    fa: "شاخص دیده‌شدن: سهم کلیک‌هایی که جایگاه فعلی کلمه‌های ردیابی‌شده به دست می‌آورد، وزن‌دهی‌شده با تعداد نمایش هر کلمه (۱۰۰ یعنی همه در رتبهٔ ۱).",
    en: "Visibility: the share of available clicks the tracked keywords' positions capture, weighted by each keyword's impressions (100 = all at #1).",
  },
  tracked: { fa: "کلمهٔ ردیابی‌شده", en: "tracked keywords" },
  noData: { fa: "بدون داده", en: "no data" },
  last7: { fa: "جایگاه، کلیک و نمایش: ۷ روز آخر داده؛ تغییر نسبت به ۷ روز پیش از آن.", en: "Position, clicks and impressions: the last 7 days with data; change against the 7 days before." },
  pageOf: { fa: "صفحه", en: "Page" },
  of: { fa: "از", en: "of" },
  summary: { fa: "خلاصه", en: "Summary" },
} satisfies Record<string, Pair>;

const SEVERITY: Record<Severity, Pair> = {
  CRITICAL: { fa: "بحرانی", en: "Critical" },
  SERIOUS: { fa: "جدی", en: "Serious" },
  WARNING: { fa: "هشدار", en: "Warning" },
  INFO: { fa: "اطلاع", en: "Info" },
};


function tr(p: Pair, locale: ReportLocale): string {
  return p[locale];
}

function category(c: string, locale: ReportLocale): string {
  return CATEGORY_TITLES[c]?.[locale] ?? c;
}

/**
 * Issues are stored with the rule's English title; reports print the rule's
 * title in the report's language, and a rule without one (never expected, see
 * the test) by its category rather than leaking English into a Persian page.
 */
function issueTitle(i: { ruleId: string; title: string; category: string }, locale: ReportLocale): string {
  const known = RULE_TITLES[i.ruleId];
  if (known) return known[locale];
  return locale === "en" ? i.title : `${tr(L.issue, locale)} — ${category(i.category, locale)}`;
}

function css(color: string, locale: ReportLocale): string {
  const rtl = locale === "fa";
  return `${fontFaces()}
@page{size:A4}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:"Vazirmatn",sans-serif;color:#17201b;font-size:10.5pt;line-height:1.7;direction:${rtl ? "rtl" : "ltr"}}
h1{font-size:20pt;margin:0 0 2mm;line-height:1.3}
h2{font-size:13pt;margin:8mm 0 3mm;padding-bottom:1.5mm;border-bottom:2px solid ${color};break-after:avoid}
h3{font-size:11pt;margin:5mm 0 2mm;break-after:avoid}
.cover{display:flex;align-items:center;justify-content:space-between;gap:8mm;padding:6mm 0 5mm;border-bottom:4px solid ${color}}
.cover img{max-height:18mm;max-width:50mm}
.brand{font-weight:700;color:${color};font-size:12pt}
.meta{color:#56615b;font-size:9.5pt}
.ltr{direction:ltr;unicode-bidi:embed;display:inline-block}
.kpis{display:flex;gap:4mm;flex-wrap:wrap;margin:3mm 0}
.kpi{flex:1 1 30mm;border:1px solid #dfe5e1;border-radius:3mm;padding:3mm 4mm;break-inside:avoid}
.kpi .v{font-size:16pt;font-weight:700}
.kpi .l{color:#56615b;font-size:9pt}
.kpi .d{font-size:9pt;color:#56615b}
.up{color:#0e8a52}.down{color:#c23b34}
table{width:100%;border-collapse:collapse;margin:2mm 0 4mm;font-size:9.5pt}
th{background:#f3f6f4;text-align:${rtl ? "right" : "left"};font-weight:700;padding:1.8mm 2mm;border-bottom:1px solid #dfe5e1}
td{padding:1.6mm 2mm;border-bottom:1px solid #eef1ef;vertical-align:middle}
tr{break-inside:avoid}
td.n,th.n{text-align:${rtl ? "left" : "right"};white-space:nowrap}
td.url{direction:ltr;text-align:left;word-break:break-all;font-size:8.5pt;color:#2b3a33}
.sev{display:inline-block;padding:0 2mm;border-radius:2mm;color:#fff;font-size:8.5pt;font-weight:700}
.note{color:#56615b;font-size:9pt;margin:1mm 0 3mm}
.empty{border:1px dashed #cfd8d3;border-radius:3mm;padding:4mm;color:#56615b;background:#fafbfa}
.chart{border:1px solid #dfe5e1;border-radius:3mm;padding:2mm;break-inside:avoid;margin:2mm 0 4mm}
.row{display:flex;gap:6mm;align-items:center}
section{break-inside:auto}`;
}

function cover(f: ReportFacts, locale: ReportLocale): string {
  const logo = logoSrc(f.brand);
  const name = f.brand.name || f.orgName;
  return `<header class="cover"><div>
<div class="brand">${esc(name)}</div>
<h1>${esc(tr(L[f.kind], locale))}</h1>
<div class="meta">${esc(tr(L.site, locale))}: <strong>${esc(f.project.name)}</strong> — <span class="ltr">${esc(f.project.baseUrl)}</span></div>
<div class="meta">${esc(tr(L.generated, locale))}: ${esc(date(f.generatedAt, locale))}</div>
</div>${logo ? `<img src="${logo}" alt="">` : ""}</header>`;
}

function kpi(label: string, value: string, note = ""): string {
  return `<div class="kpi"><div class="v">${value}</div><div class="l">${esc(label)}</div>${note ? `<div class="d">${note}</div>` : ""}</div>`;
}

function change(cur: number | null, prev: number | null, locale: ReportLocale, lowerIsBetter = false, digits = 0): string {
  if (cur === null || prev === null) return "";
  const d = cur - prev;
  const good = lowerIsBetter ? d < 0 : d > 0;
  const cls = d === 0 ? "" : good ? "up" : "down";
  return `<span class="${cls}">${esc(delta(d, locale, digits))}</span> ${esc(tr(L.vsPrevious, locale))}`;
}

function sevBadge(s: Severity, locale: ReportLocale): string {
  return `<span class="sev" style="background:${SEVERITY_COLORS[s]}">${esc(SEVERITY[s][locale])}</span>`;
}

// ---------------------------------------------------------------- sections

function auditSection(f: ReportFacts, locale: ReportLocale, color: string, full: boolean): string {
  const a = f.audit;
  if (!a.run) return `<h2>${esc(tr(L.summary, locale))}</h2><p class="empty">${esc(tr(L.noScan, locale))}</p>`;
  const out: string[] = [];
  out.push(`<h2>${esc(tr(L.summary, locale))}</h2>`);
  out.push(`<div class="row">${gauge(a.run.score, color, locale)}<div class="kpis" style="flex:1">
${kpi(tr(L.score, locale), esc(num(a.run.score, locale)), change(a.run.score, a.previousScore, locale))}
${kpi(tr(L.pagesCrawled, locale), esc(num(a.run.pagesCrawled, locale)), `${esc(tr(L.lastScan, locale))}: ${esc(date(a.run.finishedAt, locale))}`)}
${kpi(tr(L.issues, locale), esc(num(Object.values(a.severity).reduce((s, n) => s + n, 0), locale)), (["CRITICAL", "SERIOUS"] as Severity[]).map((s) => `${esc(SEVERITY[s][locale])}: ${esc(num(a.severity[s], locale))}`).join(" · "))}
</div></div>`);
  if (a.history.length >= 2) {
    out.push(`<h3>${esc(tr(L.scoreTrend, locale))}</h3><div class="chart">${lineChart(a.history.map((h) => ({ label: shortDate(h.date, locale), value: h.score })), { color, locale, min: 0, max: 100, height: 170 })}</div>`);
  }
  const sevMax = Math.max(1, ...Object.values(a.severity));
  out.push(`<h3>${esc(tr(L.issues, locale))}</h3><table><tbody>${(Object.keys(a.severity) as Severity[])
    .map((s) => `<tr><td>${sevBadge(s, locale)}</td><td>${bar(a.severity[s], sevMax, SEVERITY_COLORS[s])}</td><td class="n">${esc(num(a.severity[s], locale))}</td></tr>`)
    .join("")}</tbody></table>`);
  if (!full) return out.join("\n");

  const cats = a.run.breakdown?.byCategory ?? [];
  if (cats.length) {
    const max = Math.max(1, ...cats.map((c) => c.penalty));
    out.push(`<h3>${esc(tr(L.categories, locale))}</h3><table><thead><tr><th>${esc(tr(L.category, locale))}</th><th></th><th class="n">${esc(tr(L.penalty, locale))}</th><th class="n">${esc(tr(L.issues, locale))}</th></tr></thead><tbody>${[...cats]
      .sort((x, y) => y.penalty - x.penalty)
      .map((c) => `<tr><td>${esc(category(c.category, locale))}</td><td>${bar(c.penalty, max, color)}</td><td class="n">${esc(num(c.penalty, locale, 1))}</td><td class="n">${esc(num(c.issues, locale))}</td></tr>`)
      .join("")}</tbody></table>`);
  }
  out.push(`<h2>${esc(tr(L.topIssues, locale))}</h2>`);
  out.push(
    a.topIssues.length
      ? `<table><thead><tr><th>${esc(tr(L.issue, locale))}</th><th>${esc(tr(L.severity, locale))}</th><th>${esc(tr(L.category, locale))}</th><th class="n">${esc(tr(L.pagesAffected, locale))}</th></tr></thead><tbody>${a.topIssues
          .map((i) => `<tr><td>${esc(issueTitle(i, locale))}</td><td>${sevBadge(i.severity, locale)}</td><td>${esc(category(i.category, locale))}</td><td class="n">${esc(num(i.pages, locale))}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p class="empty">${esc(tr(L.noIssues, locale))}</p>`,
  );
  const worst = a.run.breakdown?.worstPages ?? [];
  if (worst.length) {
    out.push(`<h3>${esc(tr(L.worstPages, locale))}</h3><table><thead><tr><th>${esc(tr(L.page, locale))}</th><th class="n">${esc(tr(L.score, locale))}</th><th class="n">${esc(tr(L.issues, locale))}</th></tr></thead><tbody>${worst
      .slice(0, 15)
      .map((p) => `<tr><td class="url">${esc(p.url)}</td><td class="n">${esc(num(p.score, locale))}</td><td class="n">${esc(num(p.issues, locale))}</td></tr>`)
      .join("")}</tbody></table>`);
  }
  if (a.pages) {
    out.push(`<h2>${esc(tr(L.crawl, locale))}</h2><div class="kpis">
${kpi(tr(L.total, locale), esc(num(a.pages.total, locale)))}
${kpi(tr(L.ok200, locale), esc(num(a.pages.ok, locale)))}
${kpi(tr(L.redirects, locale), esc(num(a.pages.redirects, locale)))}
${kpi(tr(L.errors, locale), esc(num(a.pages.errors, locale)))}
${kpi(tr(L.indexable, locale), esc(num(a.pages.indexable, locale)))}
${kpi(tr(L.avgResponse, locale), `${esc(num(a.pages.avgResponseMs, locale))} <small>${esc(tr(L.ms, locale))}</small>`)}
</div>`);
  }
  out.push(`<h2>${esc(tr(L.fixes, locale))}</h2><div class="kpis">${kpi(tr(L.applied30, locale), esc(num(a.fixes.appliedLast30Days, locale)))}${kpi(tr(L.awaiting, locale), esc(num(a.fixes.awaitingApproval, locale)))}</div>`);
  return out.join("\n");
}

function gscSection(f: ReportFacts, locale: ReportLocale, color: string): string {
  const out = [`<h2>${esc(tr(L.search, locale))}</h2>`];
  const g = f.gsc;
  if (!g) return `${out[0]}<p class="empty">${esc(tr(L.gscMissing, locale))}</p>`;
  out.push(`<p class="note">${esc(tr(L.gscSource, locale))} — ${esc(date(g.current.from, locale))} – ${esc(date(g.current.to, locale))}</p>`);
  out.push(`<div class="kpis">
${kpi(tr(L.clicks, locale), esc(num(g.current.clicks, locale)), change(g.current.clicks, g.previous.clicks, locale))}
${kpi(tr(L.impressions, locale), esc(num(g.current.impressions, locale)), change(g.current.impressions, g.previous.impressions, locale))}
${kpi(tr(L.ctr, locale), esc(pct(g.current.ctr, locale)), g.previous.ctr !== null ? `${esc(tr(L.previous, locale))}: ${esc(pct(g.previous.ctr, locale))}` : "")}
${kpi(tr(L.avgPosition, locale), esc(num(g.current.position, locale, 1)), change(g.current.position, g.previous.position, locale, true, 1))}
</div>`);
  if (g.daily.length >= 2) {
    out.push(`<h3>${esc(tr(L.dailyClicks, locale))}</h3><div class="chart">${lineChart(g.daily.map((d) => ({ label: shortDate(d.date, locale), value: d.clicks })), { color, locale, min: 0 })}</div>`);
  }
  const table = (title: Pair, head: Pair, rows: Array<{ name: string; clicks: number; impressions: number; position: number }>, url: boolean) =>
    rows.length
      ? `<h3>${esc(tr(title, locale))}</h3><table><thead><tr><th>${esc(tr(head, locale))}</th><th class="n">${esc(tr(L.clicks, locale))}</th><th class="n">${esc(tr(L.impressions, locale))}</th><th class="n">${esc(tr(L.position, locale))}</th></tr></thead><tbody>${rows
          .map((r) => `<tr><td${url ? ' class="url"' : ' dir="auto"'}>${esc(r.name)}</td><td class="n">${esc(num(r.clicks, locale))}</td><td class="n">${esc(num(r.impressions, locale))}</td><td class="n">${esc(num(r.position, locale, 1))}</td></tr>`)
          .join("")}</tbody></table>`
      : "";
  out.push(table(L.topQueries, L.query, g.topQueries.map((q) => ({ name: q.query, ...q })), false));
  out.push(table(L.topPages, L.page, g.topPages.map((p) => ({ name: p.page, ...p })), true));
  return out.join("\n");
}

function cwvSection(f: ReportFacts, locale: ReportLocale): string {
  const out = [`<h2>${esc(tr(L.cwv, locale))}</h2>`];
  const p = f.pagespeed;
  if (!p) return `${out[0]}<p class="empty">${esc(tr(L.cwvMissing, locale))}</p>`;
  out.push(`<p class="note">${esc(tr(L.cwvSource, locale))} — ${esc(date(p.lastRunAt, locale))}</p>`);
  out.push(`<table><thead><tr><th></th><th class="n">${esc(tr(L.passed, locale))}</th><th class="n">${esc(tr(L.failed, locale))}</th><th class="n">${esc(tr(L.perfScore, locale))}</th></tr></thead><tbody>${(["mobile", "desktop"] as const)
    .map((s) => `<tr><td>${esc(tr(L[s], locale))}</td><td class="n">${esc(num(p.totals[s].passed, locale))}</td><td class="n">${esc(num(p.totals[s].failed, locale))}</td><td class="n">${esc(num(p.totals[s].averageScore, locale))}</td></tr>`)
    .join("")}</tbody></table>`);
  return out.join("\n");
}

function keywordSection(f: ReportFacts, locale: ReportLocale, color: string, full: boolean): string {
  const out = [`<h2>${esc(tr(L.keywordsSection, locale))}</h2>`];
  const k = f.keywords;
  if (!k) return `${out[0]}<p class="empty">${esc(tr(L.keywordsMissing, locale))}</p>`;
  out.push(`<p class="note">${esc(num(k.tracked, locale))} ${esc(tr(L.tracked, locale))} · ${esc(tr(L.gscSource, locale))}</p>`);
  if (k.visibility.length >= 2) {
    out.push(`<h3>${esc(tr(L.visibility, locale))}</h3><div class="chart">${lineChart(k.visibility.map((v) => ({ label: shortDate(v.date, locale), value: v.visibility })), { color, locale, min: 0, digits: 1 })}</div><p class="note">${esc(tr(L.visibilityNote, locale))}</p>`);
  }
  const moverTable = (title: Pair, list: typeof k.movers.gains) =>
    list.length
      ? `<h3>${esc(tr(title, locale))}</h3><table><thead><tr><th>${esc(tr(L.keyword, locale))}</th><th class="n">${esc(tr(L.position, locale))}</th><th class="n">${esc(tr(L.change, locale))}</th></tr></thead><tbody>${list
          .map((m) => `<tr><td dir="auto">${esc(m.phrase)}</td><td class="n">${esc(num(m.position, locale, 1))}</td><td class="n ${m.change !== null && m.change > 0 ? "up" : "down"}">${esc(m.change === null ? tr(L.noData, locale) : delta(m.change, locale))}</td></tr>`)
          .join("")}</tbody></table>`
      : "";
  out.push(moverTable(L.gains, k.movers.gains.slice(0, full ? 10 : 5)));
  out.push(moverTable(L.losses, k.movers.losses.slice(0, full ? 10 : 5)));
  if (full) {
    out.push(`<h3>${esc(tr(L.keywordsSection, locale))}</h3><p class="note">${esc(tr(L.last7, locale))}</p><table><thead><tr><th>${esc(tr(L.keyword, locale))}</th><th class="n">${esc(tr(L.position, locale))}</th><th class="n">${esc(tr(L.change, locale))}</th><th class="n">${esc(tr(L.clicks, locale))}</th><th class="n">${esc(tr(L.impressions, locale))}</th></tr></thead><tbody>${k.rows
      .map((r) => {
        const d = r.position !== null && r.previousPosition !== null ? r.previousPosition - r.position : null;
        return `<tr><td dir="auto">${esc(r.phrase)}</td><td class="n">${esc(r.position === null ? tr(L.noData, locale) : num(r.position, locale, 1))}</td><td class="n ${d === null || d === 0 ? "" : d > 0 ? "up" : "down"}">${esc(d === null ? "—" : delta(d, locale))}</td><td class="n">${esc(num(r.clicks, locale))}</td><td class="n">${esc(num(r.impressions, locale))}</td></tr>`;
      })
      .join("")}</tbody></table>`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- documents

export function renderReportHtml(f: ReportFacts, locale: ReportLocale): string {
  const color = brandColor(f.brand);
  const body: string[] = [cover(f, locale)];
  const kind: ReportKind = f.kind;
  if (kind === "audit") body.push(auditSection(f, locale, color, true));
  if (kind === "executive") {
    body.push(auditSection(f, locale, color, false));
    body.push(gscSection(f, locale, color));
    body.push(cwvSection(f, locale));
    body.push(keywordSection(f, locale, color, false));
    body.push(`<h2>${esc(tr(L.fixes, locale))}</h2><div class="kpis">${kpi(tr(L.applied30, locale), esc(num(f.audit.fixes.appliedLast30Days, locale)))}${kpi(tr(L.awaiting, locale), esc(num(f.audit.fixes.awaitingApproval, locale)))}</div>`);
  }
  if (kind === "keywords") {
    body.push(keywordSection(f, locale, color, true));
    body.push(gscSection(f, locale, color));
  }
  return `<!doctype html><html lang="${locale}" dir="${locale === "fa" ? "rtl" : "ltr"}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<title>${esc(`${tr(L[kind], locale)} — ${f.project.name}`)}</title><style>${css(color, locale)}
${footerFace(locale)}</style></head><body>${body.join("\n")}${PRELOAD}</body></html>`;
}

/**
 * The footer's font. Chromium draws header/footer templates in a context that
 * does not load web fonts by itself; a font the document has already loaded
 * from the same data URL is reused. So the document preloads this face (see
 * PRELOAD) and the footer declares it with the identical URL.
 */
function footerFace(locale: ReportLocale): string {
  const data = locale === "fa" ? reportFonts().digitsFa : reportFonts().regular;
  return `@font-face{font-family:VazirFD;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}
const PRELOAD = `<span aria-hidden="true" style="font-family:VazirFD;position:absolute;opacity:0">0</span>`;

/** Chromium's page header/footer: brand name and "page X of Y" (Persian digits in fa via the FD font). */
export function footerTemplate(f: ReportFacts, locale: ReportLocale): string {
  const face = footerFace(locale);
  const name = esc(f.brand.name || f.orgName);
  const pages =
    locale === "fa"
      ? `${esc(L.pageOf.fa)} <span class="pageNumber"></span> ${esc(L.of.fa)} <span class="totalPages"></span>`
      : `${esc(L.pageOf.en)} <span class="pageNumber"></span> ${esc(L.of.en)} <span class="totalPages"></span>`;
  // No "#" anywhere: Chromium loads the template as a URL, and a "#" would end it there.
  return `<style>${face}</style><div style="width:100%;font-family:VazirFD,sans-serif;font-size:8px;color:rgb(107,117,111);padding:0 14mm;display:flex;justify-content:space-between;direction:${locale === "fa" ? "rtl" : "ltr"}"><span>${name}</span><span>${pages}</span></div>`;
}
