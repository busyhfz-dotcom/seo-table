/**
 * PDF reports end to end: facts from Postgres and a Search Console double,
 * HTML templates in Persian and English, real Chromium printing (the worker's
 * BrowserManager), storage in reports.content, the in-app notification, and a
 * monthly schedule that runs through the report queue.
 *
 * The text of each PDF is read back with pdftotext (poppler) where installed,
 * so the assertions are about what a reader sees: the right language, Persian
 * digits and Jalali dates in fa, the white-label name, page numbers, and an
 * honest "not connected" instead of numbers when a source is missing.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import {
  closeDb,
  db,
  eq,
  keywordPositions,
  keywords,
  notifications,
  organizations,
  pageSpeed,
  projects,
  purgeOrganization,
  reports,
  schedules,
  seoIssues,
  and,
} from "@seo/db";
import { ALL_RULES, RULE_CATEGORIES, REPORT_QUEUE, closeQueues, closeRedis, dataQueue, enqueueReport, queuePrefix, redis } from "@seo/core";
import { BrowserManager } from "@seo/browser";
import { dispatchSchedule, reportService, runReportJob, scheduleService, type GscSource, type PdfPrinter } from "@seo/seo-data";
import type { SearchAnalyticsRequest, SearchAnalyticsRow } from "@seo/connectors";
import { seedCrawl } from "./site-seed.js";

const NOW = new Date("2026-09-20T12:00:00Z");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const stamp = Date.now();
let orgId: string;
let projectId: string;
let manager: BrowserManager;
let dir: string;
const printer: PdfPrinter = (html, opts) => manager.pdf(html, opts);

let hasPdftotext = true;
try {
  execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
} catch {
  hasPdftotext = false;
}

/** The PDF's text in reading order, or null where poppler is not installed. */
function pdfText(pdf: Buffer, name: string): string | null {
  const path = join(dir, `${name}.pdf`);
  writeFileSync(path, pdf);
  if (!hasPdftotext) return null;
  // pdftotext marks RTL runs with embedding controls; they are not part of the words.
  return execFileSync("pdftotext", ["-enc", "UTF-8", path, "-"]).toString("utf8").replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}

function pages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** Search Console double shaped like the API: by date, query or page over the requested window. */
const gsc: GscSource = {
  async query(_p, req: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    const dim = req.dimensions[0];
    if (dim === "date") {
      const out: SearchAnalyticsRow[] = [];
      for (let d = new Date(req.start); d <= req.end; d = new Date(d.getTime() + 86_400_000)) {
        const recent = d >= new Date("2026-08-23T00:00:00Z");
        out.push({ keys: [d.toISOString().slice(0, 10)], clicks: recent ? 30 : 20, impressions: recent ? 600 : 500, ctr: 0.05, position: recent ? 5 : 6 });
      }
      return out;
    }
    if (dim === "query") return [{ keys: ["کفش ورزشی"], clicks: 400, impressions: 8000, ctr: 0.05, position: 4.2 }];
    return [{ keys: ["https://shop.example/shoes"], clicks: 500, impressions: 9000, ctr: 0.055, position: 3.9 }];
  },
};
const deps = { gsc, now: () => NOW };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seo-reports-"));
  manager = new BrowserManager({ maxSessions: 0, executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  orgId = (await db.insert(organizations).values({ name: "آژانس نمونه", slug: `reports-${stamp}` }).returning())[0]!.id;
  projectId = (await db.insert(projects).values({ orgId, name: "فروشگاه کفش", baseUrl: "https://shop.example/", locale: "fa" }).returning())[0]!.id;
  await seedCrawl(projectId, [{ url: "https://shop.example/" }], { finishedAt: new Date("2026-08-20T10:00:00Z"), score: 64 });
  const runId = await seedCrawl(projectId, [{ url: "https://shop.example/" }, { url: "https://shop.example/shoes" }, { url: "https://shop.example/gone", status: 404 }], { finishedAt: new Date("2026-09-19T10:00:00Z"), score: 70 });
  await db.insert(seoIssues).values([
    { projectId, ruleId: "rule.title.missing", fingerprint: `f1-${stamp}`, severity: "CRITICAL", title: "Page has no title", category: "title", pageCount: 3, lastSeenRunId: runId },
    { projectId, ruleId: "rule.meta.length", fingerprint: `f2-${stamp}`, severity: "WARNING", title: "Meta description length is off", category: "meta", pageCount: 12, lastSeenRunId: runId },
  ]);
  const kw = (await db.insert(keywords).values({ projectId, phrase: "کفش ورزشی", locale: "fa", country: "IR" }).returning())[0]!;
  for (let i = 0; i < 20; i++) {
    const date = new Date(Date.UTC(2026, 8, 19 - i)).toISOString().slice(0, 10);
    await db.insert(keywordPositions).values({ keywordId: kw.id, date, source: "gsc", position: i < 7 ? 3 : 6, clicks: 10, impressions: 200 });
  }
  await db.insert(pageSpeed).values({ projectId, url: "https://shop.example/", strategy: "mobile", performanceScore: 71, lcpMs: 2100, cls: 0.05 });
});

afterAll(async () => {
  await manager?.close();
  rmSync(dir, { recursive: true, force: true });
  await dataQueue("report").obliterate({ force: true }).catch(() => {});
  await purgeOrganization(orgId).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDb();
});

describe("report templates", () => {
  it("have a Persian and an English title for every rule and category", () => {
    for (const rule of ALL_RULES) {
      expect(reportService.RULE_TITLES[rule.id], rule.id).toBeDefined();
    }
    for (const c of RULE_CATEGORIES) expect(reportService.CATEGORY_TITLES[c], c).toBeDefined();
  });
});

describe("generating PDFs", () => {
  it("prints a Persian audit report with Persian digits, Jalali dates, translated issues and page numbers", async () => {
    await reportService.setBrand(orgId, { name: "برند سفید", color: "#1d4ed8", logo: PNG });
    const row = await reportService.generateReport({ projectId, kind: "audit", createdById: "u1" }, printer, deps);
    expect(row).toMatchObject({ kind: "audit", contentType: "application/pdf", brand: { name: "برند سفید", color: "#1d4ed8", logo: PNG } });
    expect(row.fileKey).toBe("فروشگاه-کفش-audit-2026-09-20.pdf");
    const file = await reportService.reportFile(projectId, row.id);
    expect(file.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(file.content.length).toBe(row.bytes);
    expect(pages(file.content)).toBeGreaterThanOrEqual(1);
    const text = pdfText(file.content, "audit-fa");
    if (text === null) return;
    expect(text).toContain("گزارش ممیزی سئو");
    expect(text).toContain("برند سفید");
    expect(text).toContain("صفحه عنوان ندارد"); // the rule's Persian title, not "Page has no title"
    expect(text).not.toContain("Page has no title");
    expect(text).toContain("۷۰"); // the score, in Persian digits
    expect(text).toContain("شهریور ۱۴۰۵"); // generated 2026-09-20 → 29 Shahrivar 1405
    expect(text).toMatch(/صفحه\s*1\s*از\s*\d/); // footer (drawn with Persian-digit glyphs)
  });

  it("prints English with the rules' English titles", async () => {
    const row = await reportService.generateReport({ projectId, kind: "audit", locale: "en", createdById: null }, printer, deps);
    const text = pdfText((await reportService.reportFile(projectId, row.id)).content, "audit-en");
    if (text === null) return;
    expect(text).toContain("SEO audit report");
    expect(text).toContain("Page has no title");
    expect(text).toContain("20 September 2026");
    expect(text).toMatch(/Page 1 of \d/);
    expect(text).not.toMatch(/[\u0600-ۿ]{3,}/u.source.includes("x") ? /x/ : /گزارش/);
  });

  it("the executive report shows Search Console, speed and keywords — or says a source is missing", async () => {
    const row = await reportService.generateReport({ projectId, kind: "executive", locale: "en", createdById: null }, printer, deps);
    const text = pdfText((await reportService.reportFile(projectId, row.id)).content, "exec-en");
    if (text !== null) {
      expect(text).toContain("Google Search performance");
      expect(text).toContain("840"); // 28 days × 30 clicks
      expect(text).toContain("Speed and Core Web Vitals");
      expect(text).toContain("Tracked keywords");
    }
    const bare = await reportService.generateReport({ projectId, kind: "executive", locale: "fa", createdById: null }, printer, { gsc: { query: async () => null }, now: () => NOW });
    const faText = pdfText((await reportService.reportFile(projectId, bare.id)).content, "exec-fa");
    // (pdftotext reorders mixed Latin/Persian runs, so only the Persian part is matched.)
    if (faText !== null) expect(faText).toContain("عملکرد جست‌وجو در دست نیست");
  });

  it("the keywords report lists tracked keywords with their Search Console positions", async () => {
    const row = await reportService.generateReport({ projectId, kind: "keywords", createdById: null }, printer, deps);
    const text = pdfText((await reportService.reportFile(projectId, row.id)).content, "keywords-fa");
    if (text === null) return;
    expect(text).toContain("گزارش کلمات کلیدی");
    expect(text).toContain("کفش ورزشی");
  });

  it("refuses a brand logo that is not an image data URL", () => {
    expect(reportService.brandInput.safeParse({ logo: "https://evil.example/logo.png" }).success).toBe(false);
    expect(reportService.brandInput.safeParse({ logo: "data:text/html;base64,PHNjcmlwdD4=" }).success).toBe(false);
    expect(reportService.brandInput.safeParse({ color: "red" }).success).toBe(false);
    expect(reportService.brandInput.safeParse({ logo: PNG, color: "#00aa11", name: "X" }).success).toBe(true);
  });

  it("lists without file contents, and deletes", async () => {
    const list = await reportService.listReports(projectId);
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list[0]).not.toHaveProperty("content");
    expect(list[0]!.brandName).toBe("برند سفید");
    await reportService.deleteReport(projectId, list[0]!.id);
    await expect(reportService.reportFile(projectId, list[0]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the report-generate job", () => {
  it("stores the PDF and notifies once, however often it is retried", async () => {
    const data = { projectId, kind: "audit" as const, trigger: "MANUAL" as const, requestedBy: "u7", correlationId: "c1" };
    const { reportId } = await runReportJob(data, printer, deps);
    const [row] = await db.select({ createdById: reports.createdById }).from(reports).where(eq(reports.id, reportId));
    expect(row!.createdById).toBe("u7");
    const notes = await db.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.kind, "report_ready")));
    const mine = notes.filter((n) => (n.data as { reportId?: string }).reportId === reportId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toEqual({ fa: "گزارش ممیزی سئو آماده است", en: "The SEO audit report is ready" });
    expect(mine[0]!.link).toBe(`/reports?project=${projectId}`);
  });

  it("a due monthly schedule runs through the queue to a stored report and a notification", async () => {
    await db
      .update(schedules)
      .set({ enabled: true, nextRunAt: new Date(Date.now() - 60_000) })
      .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, "report")));
    // Other projects in a shared test database may be due too; only ours is waited for.
    await scheduleService.tick(dispatchSchedule);
    const pending = await reportService.pendingJobs(projectId);
    expect(pending.map((p) => p.kind)).toEqual(["executive"]);

    let settle: { resolve: (id: string) => void; reject: (e: Error) => void };
    const done = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
    // The same processor the worker process runs (apps/worker main.ts), on the test's queue prefix.
    const worker = new Worker(
      REPORT_QUEUE,
      async (job) => {
        if (job.data.projectId !== projectId) return null;
        const out = await runReportJob(job.data, printer, deps);
        settle.resolve(out.reportId);
        return out;
      },
      { connection: redis, prefix: queuePrefix(), concurrency: 1 },
    );
    worker.on("failed", (_job, err) => settle.reject(err));
    const timer = setTimeout(() => settle.reject(new Error("the scheduled report did not run")), 60_000);
    const reportId = await done.finally(async () => {
      clearTimeout(timer);
      await worker.close();
    });
    const [row] = await db.select().from(reports).where(eq(reports.id, reportId));
    expect(row).toMatchObject({ kind: "executive", createdById: null });
    const note = (await db.select().from(notifications).where(eq(notifications.dedupeKey, `report_ready:${reportId}`)))[0]!;
    expect(note.data).toMatchObject({ trigger: "SCHEDULE" });
    expect((note.body as { fa: string }).fa).toContain("زمان‌بندی‌شده");
    const [sched] = await db.select().from(schedules).where(and(eq(schedules.projectId, projectId), eq(schedules.kind, "report")));
    expect(sched!.lastError).toBeNull();
    expect(sched!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a job's status is visible only through its own project", async () => {
    const job = await enqueueReport({ projectId, kind: "keywords", trigger: "MANUAL", requestedBy: "u1", correlationId: "c2" });
    expect((await reportService.jobStatus(projectId, job.jobId)).state).toBe("waiting");
    const other = (await db.insert(projects).values({ orgId, name: "Other", baseUrl: "https://other.example/" }).returning())[0]!.id;
    await expect(reportService.jobStatus(other, job.jobId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Asking again while it waits returns the same job.
    const again = await enqueueReport({ projectId, kind: "keywords", trigger: "MANUAL", requestedBy: "u1", correlationId: "c3" });
    expect(again).toEqual({ jobId: job.jobId, deduplicated: true });
  });
});
