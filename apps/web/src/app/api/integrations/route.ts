import { integrations } from "@seo/seo-data";
import { handler } from "../../../lib/route";

/** GET → {integrations: [{kind, configured, status, config, lastError, lastErrorText, lastCheckedAt, updatedAt}]} — never a secret. */
export const GET = handler({ permission: "integration:manage" }, async ({ session }) => ({
  integrations: await integrations.listIntegrations(session.orgId),
}));
