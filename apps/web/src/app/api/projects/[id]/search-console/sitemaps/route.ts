import { z } from "zod";
import { NotFound, recordAudit } from "@seo/core";
import { ConnectorError, submitSitemap } from "@seo/connectors";
import { handler } from "../../../../../../lib/route";
import { getProject } from "../../../../../../lib/queries";
import { connectorMessage, requestLocale } from "../../../../../../lib/connector-messages";

const schema = z.object({ sitemapUrl: z.string().trim().url().max(2000) });

/**
 * Submit (or resubmit) a sitemap to Google Search Console. Needs the full
 * webmasters scope and an Owner or Full user on the property; without them the
 * answer is 200 {ok:false, reason: "insufficient_scope" | "insufficient_permission"}.
 * 409 CONNECTOR_NOT_CONNECTED when Search Console is not connected.
 */
export const POST = handler({ permission: "connector:write", schema }, async ({ req, session, params, body, actor }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const audit = (metadata: Record<string, unknown>) =>
    recordAudit({
      orgId: session.orgId,
      actor,
      action: "search_console.submit_sitemap",
      targetType: "project",
      targetId: project.id,
      metadata: { sitemapUrl: body.sitemapUrl, ...metadata },
    });
  try {
    await submitSitemap(project.id, body.sitemapUrl);
    await audit({ ok: true });
    return { ok: true as const, sitemapUrl: body.sitemapUrl };
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    await audit({ ok: false, reason: err.code });
    return {
      ok: false as const,
      reason: err.code,
      message: connectorMessage(requestLocale(req), { ok: false, reason: err.code, message: err.message }),
    };
  }
});
