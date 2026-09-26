import { NotFound } from "@seo/core";
import { handler } from "../../../lib/route";
import { defaultProject, getProject, listOpportunities, listConnectors } from "../../../lib/queries";

/**
 * Content opportunities. These rows come from Search Console and nowhere else —
 * with no connector there are no rows, and the response says so plainly rather
 * than returning invented figures.
 */
export const GET = handler({ permission: "issue:read" }, async ({ req, session }) => {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId
    ? await getProject(session.orgId, projectId)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

  const connectors = await listConnectors(project.id);
  const gsc = connectors.find((c) => c.kind === "SEARCH_CONSOLE");

  return {
    projectId: project.id,
    searchConsoleConnected: gsc?.status === "CONNECTED",
    lastSyncAt: gsc?.lastSyncAt ?? null,
    opportunities: await listOpportunities(project.id),
  };
});
