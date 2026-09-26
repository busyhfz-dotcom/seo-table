import { z } from "zod";
import { recordAudit } from "@seo/core";
import { competitorService, isSupportedCountry } from "@seo/seo-data";
import { handler } from "../../../../../../../lib/route";
import { costLimit, projectFor, providerCall } from "../../../../../../../lib/seo-data";

const schema = z.object({
  locale: z.string().regex(/^[a-z]{2}$/).default("fa"),
  country: z.string().transform((c) => c.toUpperCase()).refine(isSupportedCountry, "unsupported country").default("IR"),
});

/**
 * POST {locale, country} → keywords the competitor ranks for (top 20) that we
 * do not (missing) or rank lower for (behind). DataForSEO only (paid, not
 * cached), otherwise {configured:false}. 10 per hour per organization.
 */
export const POST = handler({ permission: "tracking:write", schema }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`gap:${session.orgId}`, 10, 3_600_000);
  const market = schema.parse(body);
  const result = await providerCall(() => competitorService.keywordGap(session.orgId, project.id, params.competitorId!, market));
  if (result.configured) {
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "competitor.keyword_gap",
      targetType: "competitor",
      targetId: params.competitorId!,
      metadata: { cost: result.cost, missing: result.missing.length, behind: result.behind.length },
    });
  }
  return result;
});
