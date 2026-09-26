/**
 * Per-request context every page starts from: the session, the chosen locale, a
 * translator, the current URL (path and query), the project the screen is about,
 * and the counts the sidebar badges show.
 *
 * `pageContext` is memoised per request with React's `cache`, so the layout, the
 * top bar and the page share one session lookup instead of repeating it.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, db, eq, fixProposals, inArray, projects, seoIssues, sql, type Project } from "@seo/db";
import { DEFAULT_LOCALE, dirOf, isLocale, translator, type Locale, type T } from "./i18n";
import { requireSession, type Session } from "./auth";
import { defaultProject, getProject } from "./queries";
import type { NavCounts } from "../components/nav";

export type PageContext = {
  session: Session;
  locale: Locale;
  dir: "rtl" | "ltr";
  t: T;
  pathname: string;
  /** The query string as requested, including the leading "?" (or ""). */
  search: string;
  /** The project named by `?project=`, if it belongs to this organization. */
  requestedProjectId: string | null;
  /** That project, or the organization's default when none was named. */
  project: Project | null;
  counts: NavCounts;
};

export async function locale(): Promise<Locale> {
  const cookie = (await cookies()).get("locale")?.value;
  return isLocale(cookie) ? cookie : DEFAULT_LOCALE;
}

export const pageContext = cache(async (): Promise<PageContext> => {
  const [session, loc, h] = await Promise.all([requireSession(), locale(), headers()]);
  const path = h.get("x-pathname") ?? "/";
  const search = h.get("x-search") ?? "";
  const requested = new URLSearchParams(search).get("project");
  const named = requested ? await getProject(session.orgId, requested) : null;
  const project = named ?? (await defaultProject(session.orgId));
  return {
    session,
    locale: loc,
    dir: dirOf(loc),
    t: translator(loc),
    pathname: path,
    search,
    requestedProjectId: named?.id ?? null,
    project,
    counts: await navCounts(session.orgId, project?.id ?? null),
  };
});

/**
 * Badges describe the project on screen: open issues, fixes waiting to run and
 * approvals waiting for a person. The projects badge counts the organization's
 * projects.
 */
export async function navCounts(orgId: string, projectId: string | null): Promise<NavCounts> {
  const [{ n: projectCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(projects)
    .where(eq(projects.orgId, orgId));
  if (!projectId) return { projects: projectCount };

  const [issues, fixes, approvalsWaiting] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(seoIssues)
      .where(and(eq(seoIssues.status, "OPEN"), eq(seoIssues.projectId, projectId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(fixProposals)
      .where(and(eq(fixProposals.projectId, projectId), inArray(fixProposals.status, ["DRAFT", "APPROVED", "FAILED"]))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(fixProposals)
      .where(and(eq(fixProposals.projectId, projectId), eq(fixProposals.status, "AWAITING_APPROVAL"))),
  ]);

  return {
    projects: projectCount,
    issues: issues[0]?.n ?? 0,
    fixes: fixes[0]?.n ?? 0,
    approvals: approvalsWaiting[0]?.n ?? 0,
  };
}

/**
 * A link that keeps the project the reader chose. Without an explicit choice the
 * default project applies everywhere, so the URL stays clean.
 */
export function withProject(href: string, projectId: string | null | undefined): string {
  if (!projectId) return href;
  const [path, query = ""] = href.split("?");
  const sp = new URLSearchParams(query);
  sp.set("project", projectId);
  return `${path}?${sp.toString()}`;
}

/**
 * Website screens (crawl audit, keywords, connect site, …) mean nothing for an
 * Instagram page or a Telegram channel; a link or bookmark to one lands on the
 * profile's own overview instead.
 */
export async function websiteOnly(): Promise<void> {
  const { project, requestedProjectId } = await pageContext();
  if (project && project.kind !== "WEBSITE") redirect(withProject("/social", requestedProjectId));
}
