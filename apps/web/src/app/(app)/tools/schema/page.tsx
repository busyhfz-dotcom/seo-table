import { ToolFrame } from "../frame";
import { SCHEMA_ENUMS, SCHEMA_FIELDS } from "../strings";
import { SchemaScreen } from "./screen";

export const dynamic = "force-dynamic";

/**
 * Structured data: a template per schema.org type, prefilled from the crawl,
 * validated against Google's documented properties, compared with the page's
 * own markup, previewed in the panel's browser, and applied as an approved fix.
 */
export default function SchemaToolPage() {
  return (
    <ToolFrame
      render={({ ctx, s, project }) => (
        <SchemaScreen
          s={s}
          c={ctx.c}
          ctx={{
            projectId: project.id,
            baseUrl: project.baseUrl,
            locale: ctx.locale,
            canPropose: ctx.allowed("fix:propose"),
            links: { fixes: ctx.href("/fixes"), approvals: ctx.href("/approvals"), connect: ctx.links.connect, audit: ctx.links.audit },
            fields: SCHEMA_FIELDS[ctx.locale],
            enums: SCHEMA_ENUMS[ctx.locale],
          }}
        />
      )}
    />
  );
}
