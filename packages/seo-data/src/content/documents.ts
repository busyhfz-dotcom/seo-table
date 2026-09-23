/**
 * Content documents: create, edit, analyse, import an existing page, export.
 *
 * The body is stored sanitised (html.ts), so what the editor shows, what the
 * export contains and what would be published to WordPress are the same
 * markup. Every save re-runs the analysis and stores the score with it.
 */
import { z } from "zod";
import { and, contentDocuments, db, desc, eq, type ContentDocument } from "@seo/db";
import { BadRequest, NotFound } from "@seo/core";
import type { Deps } from "../deps.js";
import { fetchText, projectById, sameHost } from "../site.js";
import { analyzeContent, type Analysis } from "./analyze.js";
import { buildContext } from "./context.js";
import { extractMainContent, sanitizeHtml } from "./html.js";

/** A document body larger than this is not an article; it is a mistake or an attack. */
export const MAX_BODY_BYTES = 512 * 1024;
const MAX_IMPORT_BYTES = 3 * 1024 * 1024;

const locale = z.enum(["fa", "en"]);
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Only http(s) addresses");

export const createDocumentInput = z.object({
  title: z.string().trim().min(1).max(300),
  targetKeyword: z.string().trim().max(150).nullable().optional(),
  locale: locale.optional(),
  body: z.string().max(MAX_BODY_BYTES).optional(),
  url: httpUrl.nullable().optional(),
  metaTitle: z.string().trim().max(300).nullable().optional(),
  metaDescription: z.string().trim().max(1000).nullable().optional(),
});
export const updateDocumentInput = createDocumentInput.partial();
export const importInput = z.object({
  url: httpUrl,
  targetKeyword: z.string().trim().max(150).nullable().optional(),
});
export const analyzeDraftInput = createDocumentInput.extend({ title: z.string().trim().max(300) });

export type DocumentSummary = Pick<
  ContentDocument,
  "id" | "title" | "targetKeyword" | "locale" | "score" | "url" | "createdAt" | "updatedAt"
> & { publishStatus: string | null };

export type DocumentView = Omit<ContentDocument, "analysis"> & { analysis: Analysis | null };

function view(doc: ContentDocument): DocumentView {
  return { ...doc, analysis: (doc.analysis as Analysis | null) ?? null };
}

async function assertOnSite(projectId: string, url: string | null | undefined): Promise<void> {
  if (!url) return;
  const project = await projectById(projectId);
  if (!sameHost(url, project.baseUrl)) throw new BadRequest("The URL must be on this project's site", { field: "url" });
}

export async function analyzeFor(
  projectId: string,
  doc: Pick<ContentDocument, "title" | "metaTitle" | "metaDescription" | "body" | "targetKeyword" | "locale" | "url">,
  deps: Partial<Deps> = {},
): Promise<Analysis & { sources: { gsc: boolean; crawl: boolean; competitors: number } }> {
  const ctx = await buildContext(projectId, doc, deps);
  return { ...analyzeContent(doc, ctx), sources: ctx.sources };
}

export async function listDocuments(projectId: string): Promise<DocumentSummary[]> {
  const rows = await db
    .select({
      id: contentDocuments.id,
      title: contentDocuments.title,
      targetKeyword: contentDocuments.targetKeyword,
      locale: contentDocuments.locale,
      score: contentDocuments.score,
      url: contentDocuments.url,
      createdAt: contentDocuments.createdAt,
      updatedAt: contentDocuments.updatedAt,
      publish: contentDocuments.publish,
    })
    .from(contentDocuments)
    .where(eq(contentDocuments.projectId, projectId))
    .orderBy(desc(contentDocuments.updatedAt))
    .limit(500);
  return rows.map(({ publish, ...r }) => ({ ...r, publishStatus: publish?.status ?? null }));
}

export async function getDocument(projectId: string, id: string): Promise<ContentDocument> {
  const doc = (
    await db
      .select()
      .from(contentDocuments)
      .where(and(eq(contentDocuments.id, id), eq(contentDocuments.projectId, projectId)))
      .limit(1)
  )[0];
  if (!doc) throw new NotFound("Document not found");
  return doc;
}

export async function getDocumentView(projectId: string, id: string): Promise<DocumentView> {
  return view(await getDocument(projectId, id));
}

export async function createDocument(
  projectId: string,
  input: z.infer<typeof createDocumentInput>,
  createdById: string | null,
  deps: Partial<Deps> = {},
): Promise<DocumentView> {
  const project = await projectById(projectId);
  await assertOnSite(projectId, input.url);
  const values = {
    title: input.title,
    targetKeyword: input.targetKeyword ?? null,
    locale: input.locale ?? (project.locale === "en" ? "en" : "fa"),
    body: sanitizeHtml(input.body ?? ""),
    url: input.url ?? null,
    metaTitle: input.metaTitle ?? null,
    metaDescription: input.metaDescription ?? null,
  };
  const analysis = await analyzeFor(projectId, values, deps);
  const row = (
    await db
      .insert(contentDocuments)
      .values({ projectId, ...values, score: analysis.score, analysis, createdById })
      .returning()
  )[0]!;
  return view(row);
}

export async function updateDocument(
  projectId: string,
  id: string,
  input: z.infer<typeof updateDocumentInput>,
  deps: Partial<Deps> = {},
): Promise<DocumentView> {
  const current = await getDocument(projectId, id);
  await assertOnSite(projectId, input.url);
  const next = {
    title: input.title ?? current.title,
    targetKeyword: input.targetKeyword === undefined ? current.targetKeyword : input.targetKeyword,
    locale: input.locale ?? current.locale,
    body: input.body === undefined ? current.body : sanitizeHtml(input.body),
    url: input.url === undefined ? current.url : input.url,
    metaTitle: input.metaTitle === undefined ? current.metaTitle : input.metaTitle,
    metaDescription: input.metaDescription === undefined ? current.metaDescription : input.metaDescription,
  };
  const analysis = await analyzeFor(projectId, next, deps);
  const row = (
    await db
      .update(contentDocuments)
      .set({ ...next, score: analysis.score, analysis, updatedAt: new Date() })
      .where(and(eq(contentDocuments.id, id), eq(contentDocuments.projectId, projectId)))
      .returning()
  )[0];
  if (!row) throw new NotFound("Document not found");
  return view(row);
}

export async function deleteDocument(projectId: string, id: string): Promise<void> {
  const gone = await db
    .delete(contentDocuments)
    .where(and(eq(contentDocuments.id, id), eq(contentDocuments.projectId, projectId)))
    .returning({ id: contentDocuments.id });
  if (!gone[0]) throw new NotFound("Document not found");
}

/** Re-run the analysis (Search Console or the crawl may have new data) and store it. */
export async function reanalyze(projectId: string, id: string, deps: Partial<Deps> = {}): Promise<DocumentView> {
  const doc = await getDocument(projectId, id);
  const analysis = await analyzeFor(projectId, doc, deps);
  const row = (
    await db.update(contentDocuments).set({ score: analysis.score, analysis }).where(eq(contentDocuments.id, id)).returning()
  )[0]!;
  return view(row);
}

/**
 * A new document from a live page of the project's own site: the main content
 * (html.ts extractMainContent), its title, H1 and meta description.
 */
export async function importFromUrl(
  projectId: string,
  input: z.infer<typeof importInput>,
  createdById: string | null,
  deps: Partial<Deps> = {},
): Promise<DocumentView> {
  const project = await projectById(projectId);
  if (!sameHost(input.url, project.baseUrl)) throw new BadRequest("Only pages of this project's site can be imported", { field: "url" });
  const page = await fetchText(input.url, { accept: "text/html,application/xhtml+xml", maxBytes: MAX_IMPORT_BYTES, sameSiteAs: project.baseUrl });
  if (page.status !== 200) throw new BadRequest(`The page answered HTTP ${page.status}`, { status: page.status });
  if (page.contentType && !/html/i.test(page.contentType)) throw new BadRequest("That address is not an HTML page");
  if (page.truncated) throw new BadRequest("The page is too large to import");
  const x = extractMainContent(page.body, page.url);
  const lang = (x.lang ?? project.locale).toLowerCase().startsWith("en") ? "en" : "fa";
  return createDocument(
    projectId,
    {
      title: (x.h1 ?? x.metaTitle ?? page.url).slice(0, 300),
      targetKeyword: input.targetKeyword ?? null,
      locale: lang,
      body: x.body.slice(0, MAX_BODY_BYTES),
      url: page.url,
      metaTitle: x.metaTitle?.slice(0, 300) ?? null,
      metaDescription: x.metaDescription?.slice(0, 1000) ?? null,
    },
    createdById,
    deps,
  );
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A standalone HTML file of the document, for pasting into any CMS. */
export function exportHtml(doc: Pick<ContentDocument, "title" | "metaTitle" | "metaDescription" | "body" | "locale" | "url">): string {
  const dir = doc.locale === "fa" ? "rtl" : "ltr";
  return [
    "<!doctype html>",
    `<html lang="${esc(doc.locale)}" dir="${dir}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${esc(doc.metaTitle ?? doc.title)}</title>`,
    doc.metaDescription ? `<meta name="description" content="${esc(doc.metaDescription)}">` : "",
    doc.url ? `<link rel="canonical" href="${esc(doc.url)}">` : "",
    "</head>",
    "<body>",
    `<h1>${esc(doc.title)}</h1>`,
    doc.body,
    "</body>",
    "</html>",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
