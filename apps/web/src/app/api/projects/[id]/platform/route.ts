import { NotFound } from "@seo/core";
import { ConnectorError, refreshPlatform } from "@seo/connectors";
import { handler } from "../../../../../lib/route";
import { getProject } from "../../../../../lib/queries";
import { connectorMessage, requestLocale } from "../../../../../lib/connector-messages";

/** The stored platform detection (null until detected; scans refresh it weekly). */
export const GET = handler({ permission: "project:read" }, async ({ session, params }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  return { projectId: project.id, platform: project.platform ?? null };
});

/**
 * Detect the site's CMS, SEO plugin, CDN and server now, and store the result.
 * A site that cannot be reached answers 200 {ok:false, reason, message}; the
 * stored detection is left as it was.
 */
export const POST = handler({ permission: "scan:run" }, async ({ req, session, params }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  try {
    return { ok: true as const, projectId: project.id, platform: await refreshPlatform(project.id) };
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    return {
      ok: false as const,
      reason: err.code,
      message: connectorMessage(requestLocale(req), { ok: false, reason: err.code, message: err.message }),
    };
  }
});
