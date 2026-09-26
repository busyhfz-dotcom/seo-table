import { recordAudit } from "@seo/core";
import { reportService } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

/** GET → {name?, color?, logo?, defaults: {name}}: the organisation's report brand. */
export const GET = handler({ permission: "report:read" }, async ({ session, params }) => {
  await projectFor(session, params.id);
  return { brand: await reportService.getBrand(session.orgId) };
});

/**
 * PUT {name?, color? ("#rrggbb"), logo? (PNG/JPEG/WebP/SVG data URL ≤ 300 KB)} → {brand}.
 * null or "" removes a field. Organisation-wide: every project's reports use it.
 */
export const PUT = handler({ permission: "project:write", schema: reportService.brandInput }, async ({ session, params, body, actor }) => {
  await projectFor(session, params.id);
  const brand = await reportService.setBrand(session.orgId, body);
  await recordAudit({ orgId: session.orgId, actor, action: "report.brand_update", targetType: "organization", targetId: session.orgId, metadata: { fields: Object.keys(body), logo: Boolean(brand.logo) } });
  return { brand };
});
