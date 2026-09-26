import { z } from "zod";
import { recordAudit } from "@seo/core";
import { ConnectorError } from "@seo/connectors";
import { sitemapService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";
import { connectorMessage, requestLocale } from "../../../../../../lib/connector-messages";

const schema = z.object({ sitemapUrl: z.string().trim().url().max(2000).optional() });

/**
 * POST {sitemapUrl?} (default: <site>/sitemap.xml) → {ok: true, sitemapUrl} or
 * {ok: false, reason, message} when Search Console refuses (scope/permission);
 * 409 CONNECTOR_NOT_CONNECTED without Search Console.
 */
export const POST = handler({ permission: "connector:write", schema }, async ({ req, session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  try {
    const { sitemapUrl } = await sitemapService.submitToSearchConsole(project.id, body.sitemapUrl);
    await recordAudit({ orgId: session.orgId, actor, action: "search_console.submit_sitemap", targetType: "project", targetId: project.id, metadata: { sitemapUrl, ok: true } });
    return { ok: true as const, sitemapUrl };
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    await recordAudit({ orgId: session.orgId, actor, action: "search_console.submit_sitemap", targetType: "project", targetId: project.id, metadata: { ok: false, reason: err.code } });
    return { ok: false as const, reason: err.code, message: connectorMessage(requestLocale(req), { ok: false, reason: err.code, message: err.message }) };
  }
});
