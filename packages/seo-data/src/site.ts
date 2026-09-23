/**
 * The site as the latest scan saw it, and where changes to it can be written.
 * Shared by internal linking, schema markup, the sitemap and robots tools and
 * the content editor, so they all judge the same crawl.
 */
import {
  and,
  auditRuns,
  db,
  desc,
  eq,
  pageDetails,
  pageSnapshots,
  projects,
  type FixAction,
  type FixProposal,
  type PageDetails,
  type PageSnapshot,
  type Project,
} from "@seo/db";
import { BadRequest, Conflict, NotFound, decodeSitemapBody, env, guardedFetch, normalizeUrl, proposalService, type Actor } from "@seo/core";
import { forProject, resolveWriteTarget } from "@seo/connectors";
import type { Deps } from "./deps.js";
import { daysAgo } from "./text.js";

export async function projectById(projectId: string): Promise<Project> {
  const p = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!p) throw new NotFound("Project not found");
  return p;
}

export type SitePage = Pick<
  PageSnapshot,
  | "id"
  | "url"
  | "normalizedUrl"
  | "depth"
  | "statusCode"
  | "title"
  | "metaDescription"
  | "h1s"
  | "canonical"
  | "robotsMeta"
  | "indexable"
  | "noindexReason"
  | "lang"
  | "wordCount"
  | "internalLinksIn"
  | "internalLinksOut"
  | "inSitemap"
  | "redirectTarget"
  | "imagesTotal"
> & { details: Pick<PageDetails, "links" | "headings" | "jsonLd" | "images" | "lastModified"> | null };

export type SiteCrawl = {
  runId: string;
  finishedAt: Date | null;
  pages: SitePage[];
  byUrl: Map<string, SitePage>;
  /** False when the run predates migration 0008 (no link graph, headings or JSON-LD stored). */
  hasDetails: boolean;
};

/** The newest successful scan with its pages and their details; null when the project was never scanned. */
export async function latestCrawl(projectId: string): Promise<SiteCrawl | null> {
  const run = (
    await db
      .select({ id: auditRuns.id, finishedAt: auditRuns.finishedAt })
      .from(auditRuns)
      .where(and(eq(auditRuns.projectId, projectId), eq(auditRuns.status, "SUCCEEDED")))
      .orderBy(desc(auditRuns.finishedAt))
      .limit(1)
  )[0];
  if (!run) return null;
  const rows = await db
    .select({
      id: pageSnapshots.id,
      url: pageSnapshots.url,
      normalizedUrl: pageSnapshots.normalizedUrl,
      depth: pageSnapshots.depth,
      statusCode: pageSnapshots.statusCode,
      title: pageSnapshots.title,
      metaDescription: pageSnapshots.metaDescription,
      h1s: pageSnapshots.h1s,
      canonical: pageSnapshots.canonical,
      robotsMeta: pageSnapshots.robotsMeta,
      indexable: pageSnapshots.indexable,
      noindexReason: pageSnapshots.noindexReason,
      lang: pageSnapshots.lang,
      wordCount: pageSnapshots.wordCount,
      internalLinksIn: pageSnapshots.internalLinksIn,
      internalLinksOut: pageSnapshots.internalLinksOut,
      inSitemap: pageSnapshots.inSitemap,
      redirectTarget: pageSnapshots.redirectTarget,
      imagesTotal: pageSnapshots.imagesTotal,
      links: pageDetails.links,
      headings: pageDetails.headings,
      jsonLd: pageDetails.jsonLd,
      images: pageDetails.images,
      lastModified: pageDetails.lastModified,
      hasDetails: pageDetails.snapshotId,
    })
    .from(pageSnapshots)
    .leftJoin(pageDetails, eq(pageDetails.snapshotId, pageSnapshots.id))
    .where(eq(pageSnapshots.auditRunId, run.id));
  const pages: SitePage[] = rows.map(({ links, headings, jsonLd, images, lastModified, hasDetails, ...p }) => ({
    ...p,
    details: hasDetails ? { links: links ?? [], headings: headings ?? [], jsonLd: jsonLd ?? [], images: images ?? [], lastModified } : null,
  }));
  return {
    runId: run.id,
    finishedAt: run.finishedAt,
    pages,
    byUrl: new Map(pages.map((p) => [p.normalizedUrl, p])),
    hasDetails: pages.some((p) => p.details !== null),
  };
}

export function h1Of(page: Pick<SitePage, "h1s">): string | null {
  return Array.isArray(page.h1s) && typeof page.h1s[0] === "string" ? page.h1s[0] : null;
}

/** "Running shoes | Shop" → "Running shoes": the part of a title that names the page, not the site. */
export function titleWithoutBrand(title: string | null): string | null {
  if (!title) return null;
  const parts = title.split(/\s+[|\-–—:»«]\s+/);
  const main = parts.length > 1 ? parts.reduce((a, b) => (a.length >= b.length ? a : b)) : title;
  return main.trim() || null;
}

export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "").toLowerCase() === new URL(b).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
}

export function key(url: string): string {
  return normalizeUrl(url) ?? url;
}

// ---------------------------------------------------------------- fetching

export type FetchedText = { status: number; url: string; body: string; contentType: string | null; truncated: boolean; hops: string[] };

/**
 * GET through the SSRF guard, following up to five redirects hop by hop (each
 * hop is checked again by the guard). `sameSiteAs` refuses a redirect that
 * leaves the site, so an import or a sitemap check never wanders elsewhere.
 */
export async function fetchText(
  url: string,
  opts: { accept: string; maxBytes: number; sameSiteAs?: string; timeoutMs?: number },
): Promise<FetchedText> {
  let current = url;
  const hops: string[] = [];
  for (let hop = 0; hop <= 5; hop++) {
    const res = await guardedFetch(current, {
      headers: { "user-agent": env().CRAWLER_USER_AGENT, accept: opts.accept },
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxBytes: opts.maxBytes,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { status: res.status, url: current, body: "", contentType: null, truncated: false, hops };
      const next = new URL(location, current).toString();
      if (opts.sameSiteAs && !sameHost(next, opts.sameSiteAs)) {
        throw new BadRequest("The address redirects to another site", { location: next });
      }
      hops.push(current);
      current = next;
      continue;
    }
    return {
      status: res.status,
      url: current,
      body: decodeSitemapBody(res.body, opts.maxBytes * 4),
      contentType: res.headers.get("content-type"),
      truncated: res.truncated,
      hops,
    };
  }
  throw new BadRequest("Too many redirects");
}

// ---------------------------------------------------------------- Search Console

export type PageQueries = Map<string, Array<{ query: string; clicks: number; impressions: number; position: number }>>;

/**
 * Clicks per page and each page's queries over the last 28 days (to yesterday),
 * keyed by normalised URL. null when Search Console is not connected.
 */
export async function gscPages(
  projectId: string,
  deps: Deps,
): Promise<{ clicks: Map<string, { clicks: number; impressions: number }>; queries: PageQueries; from: string; to: string } | null> {
  const start = daysAgo(28, deps.now());
  const end = daysAgo(1, deps.now());
  const rows = await deps.gsc.query(projectId, { start, end, dimensions: ["page", "query"], limit: 25_000 }).catch(() => null);
  if (rows === null) return null;
  const clicks = new Map<string, { clicks: number; impressions: number }>();
  const queries: PageQueries = new Map();
  for (const r of rows) {
    const [page, query] = r.keys;
    if (!page || !query) continue;
    const k = key(page);
    const c = clicks.get(k) ?? { clicks: 0, impressions: 0 };
    c.clicks += r.clicks;
    c.impressions += r.impressions;
    clicks.set(k, c);
    queries.set(k, [...(queries.get(k) ?? []), { query, clicks: r.clicks, impressions: r.impressions, position: r.position }]);
  }
  for (const list of queries.values()) list.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return { clicks, queries, from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------- applying changes

export type ApplyTarget = {
  target: "WORDPRESS" | "CLOUDFLARE";
  connected: boolean;
  supported: boolean;
  notes: string[];
};

/** Can the project's write target perform this action right now? Never throws for a missing connector. */
export async function applyTarget(projectId: string, action: FixAction): Promise<ApplyTarget> {
  const target = await resolveWriteTarget(projectId);
  try {
    const connector = await forProject(projectId, target.kind);
    const caps = await connector.capabilities();
    return { target: target.kind, connected: true, supported: caps.supportedActions.includes(action), notes: caps.notes };
  } catch (err) {
    return { target: target.kind, connected: false, supported: false, notes: [(err as Error).message] };
  }
}

export type SiteChange = { url: string; field: string; before: string | null; after: string };
export type SiteProposal = { proposal: FixProposal & { needsApproval: boolean }; target: ApplyTarget };

/**
 * A proposal through the ordinary fix pipeline: dry run, the approval the
 * policy demands for the action (all three site-document actions are
 * SENSITIVE), then apply and rollback like any other fix. Refused up front
 * when the write target cannot perform it, so no proposal is created that
 * could only fail.
 */
export async function proposeSiteChange(input: {
  projectId: string;
  orgId: string;
  actor: Actor;
  action: Extract<FixAction, "SCHEMA_MARKUP" | "ROBOTS_TXT" | "SITEMAP_XML">;
  ruleId: string;
  title: string;
  rationale: string;
  changes: SiteChange[];
  /** Raise the risk above the action's floor (e.g. a robots.txt that blocks important pages). */
  risk?: "SENSITIVE" | "RESTRICTED";
}): Promise<SiteProposal> {
  const target = await applyTarget(input.projectId, input.action);
  if (!target.supported) {
    throw new Conflict(
      target.connected
        ? `${target.target} cannot apply this change on this site. ${target.notes.join(" ")}`
        : `No connected write target (${target.target}) can apply this change.`,
      { reason: target.connected ? "unsupported_action" : "not_connected", target: target.target, manual: true },
    );
  }
  const created = await proposalService.createProposals({
    orgId: input.orgId,
    actor: input.actor,
    drafts: [
      {
        projectId: input.projectId,
        issueId: null,
        ruleId: input.ruleId,
        action: input.action,
        risk: input.risk ?? "SENSITIVE",
        title: input.title,
        rationale: input.rationale,
        changes: input.changes,
      },
    ],
  });
  return { proposal: created[0]!, target };
}

/** The value the write target holds for a field now (edge override or the site's own), for a proposal's `before`. */
export async function currentValue(projectId: string, url: string, field: string): Promise<string | null> {
  const target = await resolveWriteTarget(projectId);
  const connector = await forProject(projectId, target.kind).catch(() => null);
  if (!connector?.read) return null;
  return connector.read({ url, field });
}
