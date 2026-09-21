import { NotFound } from "@seo/core";
import { AWAITING_OAUTH_APP, CONNECTOR_KINDS } from "@seo/connectors";
import { handler } from "../../../lib/route";
import { defaultProject, getProject, listConnectors } from "../../../lib/queries";

/**
 * Connector status for a project. Never returns credential material — only
 * whether a connector is connected, when it last synced, and what went wrong.
 */
export const GET = handler({ permission: "connector:read" }, async ({ req, session }) => {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId
    ? await getProject(session.orgId, projectId)
    : await defaultProject(session.orgId);
  if (!project) throw new NotFound("No project");

  const rows = await listConnectors(project.id);
  const byKind = new Map(rows.map((r) => [r.kind, r]));

  return {
    projectId: project.id,
    connectors: CONNECTOR_KINDS.map((kind) => {
      const row = byKind.get(kind);
      return {
        kind,
        status: row?.status ?? "NOT_CONNECTED",
        lastSyncAt: row?.lastSyncAt ?? null,
        lastError: row?.lastError ?? null,
        scopes: (row?.scopes as string[]) ?? [],
        awaitingOAuthApp: AWAITING_OAUTH_APP.includes(kind),
      };
    }),
  };
});
