import { and, connectors, db, eq } from "@seo/db";
import { NotFound, recordAudit } from "@seo/core";
import { ConnectorError, edgeForProject } from "@seo/connectors";
import { handler } from "../../../../../../lib/route";
import { getProject } from "../../../../../../lib/queries";
import { connectorMessage, connectorNotes, requestLocale } from "../../../../../../lib/connector-messages";

/**
 * The Cloudflare edge worker for this project: live status (GET), install or
 * update (POST), remove (DELETE). All three need a connected CLOUDFLARE
 * connector (409 CONNECTOR_NOT_CONNECTED otherwise). Cloudflare-side problems
 * come back as 200 {ok:false, reason, message, detail} so the screen can say
 * exactly what to change; nothing is half-installed on a refusal.
 */

function failure(err: unknown, locale: "fa" | "en") {
  if (!(err instanceof ConnectorError)) throw err;
  return {
    ok: false as const,
    reason: err.code,
    message: connectorMessage(locale, { ok: false, reason: err.code, message: err.message }),
    detail: err.detail ?? null,
  };
}

/** After an install or uninstall, the stored check must say what is now true. */
async function refreshStoredCheck(projectId: string, edge: Awaited<ReturnType<typeof edgeForProject>>): Promise<void> {
  const result = await edge.check();
  await db
    .update(connectors)
    .set({
      config: { capabilities: result.capabilities ?? null, detail: result.detail ?? null, checkedAt: new Date().toISOString() },
      scopes: result.capabilities?.notes ?? [],
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(connectors.projectId, projectId), eq(connectors.kind, "CLOUDFLARE")));
}

export const GET = handler({ permission: "connector:read" }, async ({ req, session, params }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const locale = requestLocale(req);
  const edge = await edgeForProject(project.id);
  try {
    const st = await edge.status();
    return {
      ok: true as const,
      zone: st.site.zone.name,
      hosts: st.site.hosts,
      scriptName: st.site.scriptName,
      installed: st.installed,
      outdated: st.outdated,
      routes: st.routes,
      conflicts: st.conflicts,
      shadowed: st.shadowed,
    };
  } catch (err) {
    return failure(err, locale);
  }
});

export const POST = handler({ permission: "connector:write" }, async ({ req, session, params, actor }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const locale = requestLocale(req);
  const edge = await edgeForProject(project.id);
  try {
    const result = await edge.install();
    await refreshStoredCheck(project.id, edge);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "connector.install_edge",
      targetType: "connector",
      targetId: `${project.id}:CLOUDFLARE`,
      metadata: { ok: true, script: result.scriptName, routes: result.routes },
    });
    return { ok: true as const, scriptName: result.scriptName, routes: result.routes, notes: connectorNotes(locale, result.notes) };
  } catch (err) {
    const body = failure(err, locale);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "connector.install_edge",
      targetType: "connector",
      targetId: `${project.id}:CLOUDFLARE`,
      metadata: { ok: false, reason: body.reason },
    });
    return body;
  }
});

export const DELETE = handler({ permission: "connector:write" }, async ({ req, session, params, actor }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const locale = requestLocale(req);
  const edge = await edgeForProject(project.id);
  try {
    const result = await edge.uninstall();
    await refreshStoredCheck(project.id, edge);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "connector.uninstall_edge",
      targetType: "connector",
      targetId: `${project.id}:CLOUDFLARE`,
      metadata: { ok: true, routes: result.removedRoutes, scriptDeleted: result.scriptDeleted },
    });
    return { ok: true as const, removedRoutes: result.removedRoutes, scriptDeleted: result.scriptDeleted };
  } catch (err) {
    const body = failure(err, locale);
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "connector.uninstall_edge",
      targetType: "connector",
      targetId: `${project.id}:CLOUDFLARE`,
      metadata: { ok: false, reason: body.reason },
    });
    return body;
  }
});
