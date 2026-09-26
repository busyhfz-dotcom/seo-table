import { ToolFrame } from "../frame";
import { LinksScreen } from "./screen";

export const dynamic = "force-dynamic";

/** Internal links: equity over the site's link graph, orphans, weakly linked pages and suggestions. */
export default function LinksToolPage() {
  return (
    <ToolFrame
      render={({ ctx, s, project }) => (
        <LinksScreen s={s} c={ctx.c} ctx={{ projectId: project.id, baseUrl: project.baseUrl, locale: ctx.locale, audit: ctx.links.audit }} />
      )}
    />
  );
}
