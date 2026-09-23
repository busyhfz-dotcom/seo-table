import { z } from "zod";
import { and, connectors, db, eq } from "@seo/db";
import { NotFound } from "@seo/core";
import { forProjectToCheck } from "@seo/connectors";
import { handler } from "../../../../../../lib/route";
import { getProject } from "../../../../../../lib/queries";
import { connectorMessage, connectorNotes, requestLocale, storedConnectorError } from "../../../../../../lib/connector-messages";

const schema = z.object({ kind: z.enum(["WORDPRESS", "CLOUDFLARE", "SEARCH_CONSOLE", "GA4"]) });

/**
 * Re-verify a connected connector with its stored credentials — after
 * installing the bridge plugin, fixing a Cloudflare permission, or turning on
 * the proxy — and store what it reports. A failing check marks the connector
 * ERROR, which also takes it out of automatic write-target selection.
 */
export const POST = handler({ permission: "connector:write", schema }, async ({ req, session, params, body }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const locale = requestLocale(req);
  const client = await forProjectToCheck(project.id, body.kind);
  const result = await client.check();
  await db
    .update(connectors)
    .set({
      status: result.ok ? "CONNECTED" : "ERROR",
      config: { capabilities: result.capabilities ?? null, detail: result.detail ?? null, checkedAt: new Date().toISOString() },
      scopes: result.capabilities?.notes ?? [],
      lastError: result.ok ? null : storedConnectorError(result),
      ...(result.ok ? { lastSyncAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(connectors.projectId, project.id), eq(connectors.kind, body.kind)));
  return {
    kind: body.kind,
    status: result.ok ? "CONNECTED" : "ERROR",
    reason: result.reason ?? null,
    message: connectorMessage(locale, result),
    capabilities: result.capabilities ? { ...result.capabilities, notes: connectorNotes(locale, result.capabilities.notes) } : null,
    detail: result.detail ?? null,
  };
});
