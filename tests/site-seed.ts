/**
 * Seeds a finished scan the way the pipeline writes one — a SUCCEEDED run,
 * its page snapshots and their page_details (links, headings, JSON-LD,
 * images) — so the tools that read the latest crawl can be tested on a known
 * site without crawling it.
 */
import { auditRuns, db, pageDetails, pageSnapshots, type PageHeading, type PageImage, type PageLink } from "@seo/db";
import { normalizeUrl } from "@seo/core";

export type SeedPage = {
  url: string;
  status?: number;
  title?: string | null;
  h1?: string[];
  metaDescription?: string | null;
  canonical?: string | null;
  indexable?: boolean;
  noindexReason?: string | null;
  depth?: number | null;
  wordCount?: number;
  redirectTarget?: string | null;
  /** Internal links as [url, anchor] or [url, anchor, nofollow]. */
  links?: Array<[string, string] | [string, string, boolean]>;
  headings?: PageHeading[];
  jsonLd?: unknown[];
  images?: PageImage[];
  lastModified?: Date | null;
};

let seq = 0;

export async function seedCrawl(projectId: string, pages: SeedPage[], opts: { details?: boolean; finishedAt?: Date; score?: number } = {}): Promise<string> {
  const finishedAt = opts.finishedAt ?? new Date();
  const run = (
    await db
      .insert(auditRuns)
      .values({ projectId, status: "SUCCEEDED", idempotencyKey: `seed-${Date.now()}-${seq++}`, finishedAt, startedAt: finishedAt, score: opts.score ?? 70, pagesCrawled: pages.length })
      .returning()
  )[0]!;
  for (const p of pages) {
    const key = normalizeUrl(p.url)!;
    const snap = (
      await db
        .insert(pageSnapshots)
        .values({
          auditRunId: run.id,
          projectId,
          url: p.url,
          normalizedUrl: key,
          depth: p.depth === undefined ? 1 : p.depth,
          statusCode: p.status ?? 200,
          contentHash: `h-${key}`,
          title: p.title ?? null,
          titleLength: p.title ? [...p.title].length : 0,
          metaDescription: p.metaDescription ?? null,
          h1s: p.h1 ?? [],
          canonical: p.canonical === undefined ? key : p.canonical,
          indexable: p.indexable ?? (p.status ?? 200) === 200,
          noindexReason: p.noindexReason ?? null,
          wordCount: p.wordCount ?? 300,
          redirectTarget: p.redirectTarget ?? null,
          internalLinksOut: p.links?.length ?? 0,
        })
        .returning({ id: pageSnapshots.id })
    )[0]!;
    if (opts.details === false) continue;
    const links: PageLink[] = (p.links ?? []).map(([u, a, nf]) => ({ u: normalizeUrl(u)!, a, ...(nf ? { nf: 1 as const } : {}) }));
    await db.insert(pageDetails).values({
      snapshotId: snap.id,
      auditRunId: run.id,
      projectId,
      links,
      headings: p.headings ?? (p.h1 ?? []).map((t) => ({ l: 1, t })),
      jsonLd: p.jsonLd ?? [],
      images: p.images ?? [],
      lastModified: p.lastModified ?? null,
    });
  }
  return run.id;
}
