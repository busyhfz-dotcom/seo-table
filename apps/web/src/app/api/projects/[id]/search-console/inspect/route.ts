import { z } from "zod";
import { NotFound } from "@seo/core";
import { ConnectorError, inspectUrl } from "@seo/connectors";
import { handler } from "../../../../../../lib/route";
import { getProject } from "../../../../../../lib/queries";
import { connectorMessage, requestLocale } from "../../../../../../lib/connector-messages";

const schema = z.object({ url: z.string().trim().url().max(2000) });

/**
 * Google's index status for one URL (URL Inspection API; read-only scope,
 * 2,000 inspections a day per property). Google's verdict and state fields are
 * returned as its own enums; `coverageState` is Google's English sentence.
 * 409 CONNECTOR_NOT_CONNECTED when Search Console is not connected.
 */
export const POST = handler({ permission: "scan:run", schema }, async ({ req, session, params, body }) => {
  const project = await getProject(session.orgId, params.id!);
  if (!project) throw new NotFound("Project not found");
  const locale = requestLocale(req);
  try {
    return { ok: true as const, inspection: await inspectUrl(project.id, body.url, locale === "fa" ? "fa-IR" : "en-US") };
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    return {
      ok: false as const,
      reason: err.code,
      message: connectorMessage(locale, { ok: false, reason: err.code, message: err.message }),
    };
  }
});
