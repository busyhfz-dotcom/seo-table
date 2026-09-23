import { z } from "zod";
import { and, connectors, db, eq, projects } from "@seo/db";
import { Conflict, NotFound, recordAudit } from "@seo/core";
import { connectionOverview, WRITE_TARGETS } from "@seo/connectors";
import { handler } from "../../../../../lib/route";
import { getProject } from "../../../../../lib/queries";
import { connectorNotes, requestLocale } from "../../../../../lib/connector-messages";

/**
 * How this project's site can receive fixes: the detected platform, where
 * fixes are written (configured and effective), and each connection method
 * with its status, what it can do and whether it is the recommended one.
 * Read from stored state only — nothing is called; use POST ./check to
 * re-verify a connector.
 */
export const GET = handler({ permission: "connector:read" }, async ({ req, session, params }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const locale = requestLocale(req);
  const overview = await connectionOverview(project.id);
  return {
    projectId: project.id,
    platform: overview.platform,
    writeTarget: overview.writeTarget,
    notes: connectorNotes(locale, overview.notes),
    methods: overview.methods.map((m) => ({
      ...m,
      notes: connectorNotes(locale, m.notes),
      capabilities: m.capabilities ? { ...m.capabilities, notes: connectorNotes(locale, m.capabilities.notes) } : null,
    })),
  };
});

const patchSchema = z.object({ writeTarget: z.enum(WRITE_TARGETS as ["WORDPRESS", "CLOUDFLARE"]).nullable() });

/**
 * Choose where fixes are written: "WORDPRESS", "CLOUDFLARE", or null for
 * automatic (the edge when connected, otherwise WordPress). A target that is
 * not connected is refused rather than stored, so a later apply cannot fail
 * for a reason nobody saw coming.
 */
export const PATCH = handler({ permission: "connector:write", schema: patchSchema }, async ({ session, params, body, actor }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  if (body.writeTarget) {
    const row = (
      await db
        .select({ status: connectors.status })
        .from(connectors)
        .where(and(eq(connectors.projectId, project.id), eq(connectors.kind, body.writeTarget)))
        .limit(1)
    )[0];
    if (row?.status !== "CONNECTED") {
      throw new Conflict(`${body.writeTarget} is not connected, so it cannot be the write target`, { kind: body.writeTarget });
    }
  }
  await db.update(projects).set({ writeTarget: body.writeTarget }).where(eq(projects.id, project.id));
  await recordAudit({
    orgId: session.orgId,
    actor,
    action: "project.write_target",
    targetType: "project",
    targetId: project.id,
    metadata: { from: project.writeTarget ?? null, to: body.writeTarget },
  });
  const overview = await connectionOverview(project.id);
  return { projectId: project.id, writeTarget: overview.writeTarget };
});
