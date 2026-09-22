import { and, contentOpportunities, db, eq, connectors, sql } from "@seo/db";
import { isAppError, NotFound, recordAudit, UpstreamError } from "@seo/core";
import { ConnectorError, forProject, type Opportunity } from "@seo/connectors";
import { handler } from "../../../../lib/route";
import { defaultProject, getProject, opportunityPeriod } from "../../../../lib/queries";
import { storedConnectorError } from "../../../../lib/connector-messages";

/**
 * Pull the last 28 days from Search Console and store the opportunities.
 * If the connector is not connected this returns 409 — it does not fabricate a
 * dataset so the screen looks populated.
 */
export const POST = handler({ permission: "connector:write" }, async ({ req, session, actor }) => {
  const requested = req.nextUrl.searchParams.get("projectId");
  const project = requested
    ? await getProject(session.orgId, requested)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

  const client = (await forProject(project.id, "SEARCH_CONSOLE")) as ReturnType<
    typeof import("@seo/connectors").searchConsole
  >;

  const { start, end } = opportunityPeriod(new Date());
  let found: Opportunity[];
  try {
    found = await client.opportunities({ start, end });
  } catch (err) {
    if (isAppError(err)) throw err;
    const reason = err instanceof ConnectorError ? err.code : "network_error";
    const lastError = storedConnectorError({ reason, message: (err as Error).message });
    await db
      .update(connectors)
      .set({ lastError, updatedAt: new Date() })
      .where(and(eq(connectors.projectId, project.id), eq(connectors.kind, "SEARCH_CONSOLE")));
    throw new UpstreamError("Search Console could not be read", { reason });
  }

  if (found.length > 0) {
    await db
      .insert(contentOpportunities)
      .values(
        found.slice(0, 500).map((o) => ({
          projectId: project.id,
          query: o.query,
          url: o.page,
          impressions: o.impressions,
          clicks: o.clicks,
          ctr: o.ctr,
          position: o.position,
          gap: o.gap,
          suggestedAction: o.suggestedAction,
          periodStart: start,
          periodEnd: end,
        })),
      )
      .onConflictDoUpdate({
        target: [contentOpportunities.projectId, contentOpportunities.query, contentOpportunities.periodStart],
        // Re-syncing the same period refreshes every figure with what Search
        // Console says now (`excluded` is the row that was just offered).
        set: {
          url: sql`excluded.url`,
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          gap: sql`excluded.gap`,
          suggestedAction: sql`excluded.suggested_action`,
          periodEnd: sql`excluded.period_end`,
          updatedAt: new Date(),
        },
      });
  }

  await db
    .update(connectors)
    .set({ lastSyncAt: new Date(), lastError: null })
    .where(and(eq(connectors.projectId, project.id), eq(connectors.kind, "SEARCH_CONSOLE")));

  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "connector.sync",
    targetType: "connector",
    targetId: `${project.id}:SEARCH_CONSOLE`,
    metadata: { rows: found.length, periodStart: start.toISOString(), periodEnd: end.toISOString() },
  });

  return { synced: found.length, periodStart: start, periodEnd: end };
});

