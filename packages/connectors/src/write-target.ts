/**
 * Which connector applies a project's fixes.
 *
 * An explicit choice (projects.write_target) wins. Otherwise the Cloudflare
 * edge is used when it is connected, because it can write every field it
 * supports on any CMS without touching the site; WordPress is the fallback.
 * The choice is only a routing decision: the chosen connector's capabilities
 * still decide which proposals it can execute, and the safety policy is the
 * same for every target.
 */
import { and, connectors, db, eq, projects, type WriteTarget } from "@seo/db";
import { NotFound } from "@seo/core";

export const WRITE_TARGETS: readonly WriteTarget[] = ["WORDPRESS", "CLOUDFLARE"];

export type ResolvedWriteTarget = {
  kind: WriteTarget;
  /** The project's explicit setting, or null for automatic. */
  configured: WriteTarget | null;
  source: "configured" | "cloudflare_connected" | "default";
};

export async function resolveWriteTarget(projectId: string): Promise<ResolvedWriteTarget> {
  const project = (
    await db.select({ writeTarget: projects.writeTarget }).from(projects).where(eq(projects.id, projectId)).limit(1)
  )[0];
  if (!project) throw new NotFound("Project not found");
  const configured = project.writeTarget ?? null;
  if (configured) return { kind: configured, configured, source: "configured" };

  const edge = (
    await db
      .select({ status: connectors.status })
      .from(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.kind, "CLOUDFLARE")))
      .limit(1)
  )[0];
  if (edge?.status === "CONNECTED") return { kind: "CLOUDFLARE", configured: null, source: "cloudflare_connected" };
  return { kind: "WORDPRESS", configured: null, source: "default" };
}
