import { z } from "zod";
import { schemaMarkup } from "@seo/seo-data";
import { handler } from "../../../../../../lib/route";
import { projectFor } from "../../../../../../lib/seo-data";

const schema = z.object({ jsonld: z.unknown() });

/** POST {jsonld} → {results: [{type, issues}]}: validate hand-written markup (an object, an array or a @graph). */
export const POST = handler({ permission: "project:read", schema }, async ({ session, params, body }) => {
  await projectFor(session, params.id);
  return { results: schemaMarkup.validatePasted(body.jsonld) };
});
