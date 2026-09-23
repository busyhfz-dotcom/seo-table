import { z } from "zod";
import { schemaMarkup } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({
  type: z.enum(schemaMarkup.SUPPORTED_TYPES as unknown as [string, ...string[]]),
  data: z.record(z.unknown()),
  url: z.string().trim().url().max(2000).nullable().optional(),
});

/**
 * POST {type, data, url?} → {jsonld, issues, conflicts, existing}: the markup
 * the form produces, Google's required/recommended checks (fa/en messages),
 * and collisions with what the page already declares.
 */
export const POST = handler({ permission: "project:read", schema }, async ({ session, params, body }) => {
  const project = await projectFor(session, params.id);
  return schemaMarkup.preview(project.id, { type: body.type as schemaMarkup.SchemaType, data: body.data, url: body.url ?? null });
});
