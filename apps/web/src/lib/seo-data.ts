/**
 * Shared pieces of the SEO data routes (keywords, rank, PageSpeed, competitors,
 * schedules, alerts, notifications, integrations).
 */
import type { NextRequest } from "next/server";
import { BadRequest, NotFound, UpstreamError, enforce, type Actor } from "@seo/core";
import { and, connectors, db, eq, type Project } from "@seo/db";
import { ProviderError, integrations, reasonText } from "@seo/seo-data";
import { getProject } from "./queries";
import type { Session } from "./auth";

/** The project named in the path, if it belongs to the caller's organization; 404 otherwise. */
export async function projectFor(session: Session, projectId: string | undefined): Promise<Project> {
  const project = projectId ? await getProject(session.orgId, projectId) : null;
  if (!project) throw new NotFound("Project not found");
  return project;
}

/** Who a queued job is on behalf of, as the worker logs it. */
export function requestedBy(actor: Actor): string {
  return actor.type === "API_KEY" ? `api-key:${actor.id}` : (actor.id ?? "unknown");
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD, defaulting to the last `defaultDays` days; at most 400 days. */
export function dateRange(req: NextRequest, defaultDays = 28): { from: string; to: string } {
  const p = req.nextUrl.searchParams;
  const today = new Date();
  const to = p.get("to") ?? today.toISOString().slice(0, 10);
  const from = p.get("from") ?? new Date(today.getTime() - defaultDays * 86_400_000).toISOString().slice(0, 10);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new BadRequest("from and to must be dates (YYYY-MM-DD)");
  }
  if (from > to) throw new BadRequest("from must not be after to");
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw new BadRequest("The range may span at most 400 days");
  return { from, to };
}

/**
 * A limit on an expensive or paid operation. Fails closed: with Redis down,
 * nothing that costs money or hits a third party runs unmetered.
 */
export function costLimit(key: string, limit: number, windowMs: number) {
  return enforce(`seo-data:${key}`, limit, windowMs, { failClosed: true });
}

/**
 * A provider refused (bad credentials, empty balance, quota): answer 502 with
 * the machine reason and text in both languages, instead of a generic 500.
 */
export async function providerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) throw new UpstreamError(err.message, { reason: err.reason, text: reasonText(err.reason) });
    throw err;
  }
}

/** Which data sources this project can draw on right now — the UI labels every metric by source. */
export async function dataSources(project: Project): Promise<{ gsc: boolean; dataforseo: boolean; pagespeedKey: "org" | "env" | "none" }> {
  const [gsc, dfs, psi] = await Promise.all([
    db
      .select({ status: connectors.status })
      .from(connectors)
      .where(and(eq(connectors.projectId, project.id), eq(connectors.kind, "SEARCH_CONSOLE")))
      .limit(1),
    integrations.getIntegration(project.orgId, "DATAFORSEO"),
    integrations.pageSpeedKeySource(project.orgId),
  ]);
  return { gsc: gsc[0]?.status === "CONNECTED", dataforseo: dfs.configured, pagespeedKey: psi };
}
