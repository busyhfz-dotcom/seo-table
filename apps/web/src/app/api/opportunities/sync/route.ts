import { and, contentOpportunities, db, eq, connectors } from "@seo/db";
import { NotFound, recordAudit } from "@seo/core";
import { forProject, type Opportunity } from "@seo/connectors";
import { handler } from "../../../../lib/route";
import { defaultProject, getProject } from "../../../../lib/queries";

/**
 * Pull the last 28 days from Search Console and store the opportunities.
 * If the connector is not connected this returns 409 — it does not fabricate a
 * dataset so the screen looks populated.
 */
export const POST = handler({ permission: "connector:write" }, async ({ req, session, ip }) => {
  const requested = req.nextUrl.searchParams.get("projectId");
  const project = requested
    ? await getProject(session.orgId, requested)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

  const client = (await forProject(project.id, "SEARCH_CONSOLE")) as ReturnType<
    typeof import("@seo/connectors").searchConsole
  >;

  const end = new Date(Date.now() - 2 * 86_400_000); // Search Console lags ~2 days
  const start = new Date(end.getTime() - 28 * 86_400_000);
  const found: Opportunity[] = await client.opportunities({ start, end });

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
        set: {
          impressions: contentOpportunities.impressions,
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
    actor: { type: "USER", id: session.userId, ip },
    action: "connector.sync",
    targetType: "connector",
    targetId: `${project.id}:SEARCH_CONSOLE`,
    metadata: { rows: found.length, periodStart: start.toISOString(), periodEnd: end.toISOString() },
  });

  return { synced: found.length, periodStart: start, periodEnd: end };
});
