import { z } from "zod";
import { recordAudit } from "@seo/core";
import { discovery, isSupportedCountry } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { costLimit, projectFor, providerCall } from "../../../../../../lib/seo-data";

const schema = z.object({
  seeds: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  locale: z.string().regex(/^[a-z]{2}$/).default("fa"),
  country: z.string().transform((c) => c.toUpperCase()).refine(isSupportedCountry, "unsupported country").default("IR"),
  limit: z.number().int().min(10).max(1000).default(200),
});

/**
 * POST → DataForSEO keyword ideas with volume, difficulty and CPC (paid; cached
 * 30 days, a cached answer costs 0), or {configured:false}. `cost` is what
 * DataForSEO charged for this request, in USD.
 */
export const POST = handler({ permission: "tracking:write", schema }, async ({ session, params, body, actor }) => {
  const project = await projectFor(session, params.id);
  await costLimit(`ideas:${session.orgId}`, 30, 3_600_000);
  const result = await providerCall(() => discovery.researchIdeas(session.orgId, project.id, schema.parse(body)));
  if (result.configured && !result.cached) {
    await recordAudit({
      orgId: session.orgId,
      actor,
      action: "keyword.research",
      targetType: "project",
      targetId: project.id,
      metadata: { seeds: body.seeds.length, ideas: result.items.length, cost: result.cost },
    });
  }
  return result;
});
