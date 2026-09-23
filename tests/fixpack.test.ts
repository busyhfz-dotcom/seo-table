/**
 * The fix pack, from real rows in a real database.
 *
 * What must hold: only what the audit proposes (and what is still open) is in
 * the pack; redirects are valid for nginx, Apache and Cloudflare's CSV import;
 * spreadsheets cannot be turned into formula injection; the README describes
 * exactly the files present, in Persian and English; the zip opens.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  auditRuns,
  closeDb,
  db,
  fixProposals,
  organizations,
  pageSnapshots,
  projects,
  purgeOrganization,
  seoIssues,
  type FixAction,
} from "@seo/db";
import { closeQueues, closeRedis } from "@seo/core";
import { buildFixPack, zipFixPack } from "@seo/connectors";

const BASE = "https://shop.example/";
let orgId: string;
let projectId: string;
let emptyProjectId: string;
let runId: string;

async function issue(ruleId: string, lastSeenRunId: string) {
  return (
    await db
      .insert(seoIssues)
      .values({ projectId, ruleId, fingerprint: `${ruleId}:${Math.random()}`, severity: "WARNING", title: ruleId, category: "x", lastSeenRunId })
      .returning()
  )[0]!;
}

async function proposal(action: FixAction, issueId: string | null, changes: unknown[], status: "DRAFT" | "APPLIED" | "AWAITING_APPROVAL" = "DRAFT") {
  await db.insert(fixProposals).values({ projectId, issueId, ruleId: "r", action, risk: "LOW", status, title: action, targetCount: changes.length, changes });
}

beforeAll(async () => {
  orgId = (await db.insert(organizations).values({ name: "Pack org", slug: `pack-${Date.now()}` }).returning())[0]!.id;
  projectId = (await db.insert(projects).values({ orgId, name: "فروشگاه", baseUrl: BASE }).returning())[0]!.id;
  emptyProjectId = (await db.insert(projects).values({ orgId, name: "Empty", baseUrl: "https://empty.example/" }).returning())[0]!.id;
  runId = (await db.insert(auditRuns).values({ projectId, status: "SUCCEEDED", idempotencyKey: "k1", finishedAt: new Date() }).returning())[0]!.id;
  const oldRun = (await db.insert(auditRuns).values({ projectId, status: "SUCCEEDED", idempotencyKey: "k0", finishedAt: new Date(Date.now() - 86_400_000) }).returning())[0]!.id;

  const snap = (path: string, extra: Record<string, unknown> = {}) => ({
    auditRunId: runId,
    projectId,
    url: `${BASE}${path}`,
    normalizedUrl: `${BASE}${path}`,
    statusCode: 200,
    contentHash: path,
    indexable: true,
    ...extra,
  });
  await db.insert(pageSnapshots).values([
    snap("product/shoe", { title: "=HYPERLINK(\"http://evil\")", metaDescription: "Old, \"quoted\" description" }),
    snap("about"),
    snap("private", { indexable: false }),
    snap("old", { statusCode: 301 }),
  ]);

  const redirectIssue = await issue("rule.index.redirect_chain", runId);
  const metaIssue = await issue("rule.meta.length", runId);
  const staleIssue = await issue("rule.title.length", oldRun);
  await issue("rule.robots.missing", runId);
  await issue("rule.sitemap.missing", runId);

  await proposal("REDIRECT", redirectIssue.id, [
    { url: `${BASE}old`, field: "redirect", before: "a → b → c", after: `${BASE}new page` },
    { url: `${BASE}list?page=2&sort=a`, field: "redirect", before: "x", after: `${BASE}list` },
  ], "AWAITING_APPROVAL");
  await proposal("META_REWRITE", metaIssue.id, [{ url: `${BASE}product/shoe`, field: "meta_description", before: "Old", after: "+new cheaper shoes" }]);
  await proposal("TITLE_REWRITE", metaIssue.id, [{ url: `${BASE}product/shoe`, field: "title", before: "x", after: "کفش دویدن | فروشگاه" }]);
  await proposal("ALT_TEXT", metaIssue.id, [{ url: `${BASE}about`, field: "img.alt", before: null, after: "Our team", selector: "/img/team.jpg" }]);
  await proposal("TITLE_REWRITE", staleIssue.id, [{ url: `${BASE}about`, field: "title", before: "x", after: "Stale proposal" }]);
  // Already applied: not in the pack.
  await proposal("META_REWRITE", metaIssue.id, [{ url: `${BASE}about`, field: "meta_description", before: null, after: "applied already" }], "APPLIED");
});

afterAll(async () => {
  await purgeOrganization(orgId);
  await closeQueues();
  await closeRedis();
  await closeDb();
});

const file = (pack: Awaited<ReturnType<typeof buildFixPack>>, path: string) => pack.files.find((f) => f.path === path)?.body;

describe("buildFixPack", () => {
  it("ships only what the audit proposes and is still open", async () => {
    const pack = await buildFixPack(projectId);
    expect(pack.runId).toBe(runId);
    expect(pack.files.map((f) => f.path).sort()).toEqual([
      "README.md",
      "meta/image-alt.csv",
      "meta/pages.csv",
      "redirects/apache.htaccess",
      "redirects/cloudflare-bulk-redirects.csv",
      "redirects/nginx.conf",
      "robots.txt",
      "sitemap.xml",
    ]);
    expect(JSON.stringify(pack.files)).not.toContain("applied already");
    expect(pack.counts).toMatchObject({ redirects: 2, meta: 2, images: 1, sitemap: 2, robots: 1 });
  });

  it("writes redirects each server understands", async () => {
    const pack = await buildFixPack(projectId);
    const nginx = file(pack, "redirects/nginx.conf")!;
    expect(nginx).toContain('"/old" "https://shop.example/new page";');
    expect(nginx).toContain('"/list?page=2&sort=a" "https://shop.example/list";');
    const apache = file(pack, "redirects/apache.htaccess")!;
    expect(apache).toContain("RewriteRule ^old$ https://shop.example/new%20page [R=301,L]");
    expect(apache).toContain("RewriteCond %{QUERY_STRING} ^page=2&sort=a$");
    // Cloudflare Bulk Redirects cannot match a query: that one is left out, and the README says so.
    expect(file(pack, "redirects/cloudflare-bulk-redirects.csv")).toBe("shop.example/old,https://shop.example/new page,301,TRUE,FALSE,FALSE,FALSE\r\n");
    expect(file(pack, "README.md")).toMatch(/1 redirect\(s\) have a query string/);
  });

  it("the meta table carries current and proposed values, safe to open in a spreadsheet", async () => {
    const csv = file(await buildFixPack(projectId), "meta/pages.csv")!;
    expect(csv.startsWith("﻿url,current_title,proposed_title")).toBe(true);
    const shoe = csv.split("\r\n").find((l) => l.includes("product/shoe"))!;
    expect(shoe).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(shoe).toContain("'+new cheaper shoes");
    expect(shoe).toContain('"Old, ""quoted"" description"');
    expect(shoe).toContain("کفش دویدن | فروشگاه");
  });

  it("sitemap lists indexable 200 pages; robots.txt names it", async () => {
    const pack = await buildFixPack(projectId);
    const sitemap = file(pack, "sitemap.xml")!;
    expect(sitemap).toContain("<loc>https://shop.example/about</loc>");
    expect(sitemap).not.toContain("private");
    expect(sitemap).not.toContain("/old<");
    expect(file(pack, "robots.txt")).toBe("User-agent: *\nDisallow:\n\nSitemap: https://shop.example/sitemap.xml\n");
  });

  it("the README is Persian then English, and describes only present files", async () => {
    const readme = file(await buildFixPack(projectId), "README.md")!;
    const [fa, en] = readme.split("\n---\n");
    expect(fa).toMatch(/بستهٔ اصلاحات سئو — فروشگاه/);
    expect(fa).toContain("ریدایرکت‌ها");
    expect(fa).not.toMatch(/[A-Za-z]{12,}/); // no English sentences leaking into the Persian half
    expect(en).toContain("## Redirects");
    expect(en).not.toContain("Structured data");
  });

  it("limited to one run, older proposals are left out", async () => {
    const pack = await buildFixPack(projectId, runId);
    expect(JSON.stringify(pack.files)).not.toContain("Stale proposal");
    expect(JSON.stringify(await buildFixPack(projectId))).toContain("Stale proposal");
    await expect(buildFixPack(projectId, "not-a-run")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a project with nothing proposed gets only a README that says so", async () => {
    const pack = await buildFixPack(emptyProjectId);
    expect(pack.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(pack.files[0]!.body).toContain("proposed no fixes");
  });

  it("zips into an archive that opens", async () => {
    const pack = await buildFixPack(projectId);
    const entries = unzipSync(zipFixPack(pack));
    expect(Object.keys(entries).sort()).toEqual(pack.files.map((f) => f.path).sort());
    expect(strFromU8(entries["meta/pages.csv"]!)).toContain("کفش دویدن");
  });
});
