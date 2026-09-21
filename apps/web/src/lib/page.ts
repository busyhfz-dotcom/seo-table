/**
 * Per-request context every page starts from: the session, the chosen locale, a
 * translator, the active path, and the counts the sidebar badges show.
 */
import { cookies, headers } from "next/headers";
import { and, db, eq, fixProposals, inArray, projects, seoIssues, sql } from "@seo/db";
import { DEFAULT_LOCALE, dirOf, isLocale, translator, type Locale, type T } from "./i18n";
import { requireSession, type Session } from "./auth";
import type { NavCounts } from "../components/shell";

export type PageContext = {
  session: Session;
  locale: Locale;
  dir: "rtl" | "ltr";
  t: T;
  pathname: string;
  counts: NavCounts;
};

export async function locale(): Promise<Locale> {
  const cookie = (await cookies()).get("locale")?.value;
  return isLocale(cookie) ? cookie : DEFAULT_LOCALE;
}

export async function pathname(): Promise<string> {
  return (await headers()).get("x-pathname") ?? "/";
}

export async function pageContext(): Promise<PageContext> {
  const [session, loc, path] = await Promise.all([requireSession(), locale(), pathname()]);
  return {
    session,
    locale: loc,
    dir: dirOf(loc),
    t: translator(loc),
    pathname: path,
    counts: await navCounts(session.orgId),
  };
}

export async function navCounts(orgId: string): Promise<NavCounts> {
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.orgId, orgId));
  if (projectRows.length === 0) return { projects: 0 };
  const ids = projectRows.map((p) => p.id);

  const [issues, fixes, approvalsWaiting] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(seoIssues)
      .where(and(eq(seoIssues.status, "OPEN"), inArray(seoIssues.projectId, ids))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(fixProposals)
      .where(
        and(
          inArray(fixProposals.projectId, ids),
          inArray(fixProposals.status, ["DRAFT", "APPROVED"]),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(fixProposals)
      .where(
        and(
          inArray(fixProposals.projectId, ids),
          eq(fixProposals.status, "AWAITING_APPROVAL"),
        ),
      ),
  ]);

  return {
    projects: projectRows.length,
    issues: issues[0]?.n ?? 0,
    fixes: fixes[0]?.n ?? 0,
    approvals: approvalsWaiting[0]?.n ?? 0,
  };
}
