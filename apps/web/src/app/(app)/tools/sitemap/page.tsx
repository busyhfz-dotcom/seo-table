import { dataSources } from "../../../../lib/seo-data";
import { ToolFrame } from "../frame";
import { SitemapScreen } from "./screen";

export const dynamic = "force-dynamic";

/** Sitemap: generated from the latest scan, validated, applied as a fix and submitted to Search Console. */
export default function SitemapToolPage() {
  return (
    <ToolFrame
      render={async ({ ctx, s, project }) => {
        const sources = await dataSources(project);
        return (
          <SitemapScreen
            s={s}
            c={ctx.c}
            ctx={{
              projectId: project.id,
              baseUrl: project.baseUrl,
              locale: ctx.locale,
              canPropose: ctx.allowed("fix:propose"),
              canSubmit: ctx.allowed("connector:write"),
              gsc: sources.gsc,
              links: {
                fixes: ctx.href("/fixes"),
                approvals: ctx.href("/approvals"),
                connect: ctx.links.connect,
                audit: ctx.links.audit,
                connectGsc: ctx.links.connectGsc,
              },
            }}
          />
        );
      }}
    />
  );
}
