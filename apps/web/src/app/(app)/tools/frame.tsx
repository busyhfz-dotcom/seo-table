import type { ReactNode } from "react";
import { TopBar } from "../../../components/shell";
import { NoProject, screenContext } from "../../../lib/screen";
import { TOOLS, type ToolStrings } from "./strings";
import { ToolsNav } from "./subnav";

type ScreenCtx = Awaited<ReturnType<typeof screenContext>>;

/**
 * Every technical tool page: the top bar, the tools' tabs, and the tool itself
 * for the project on screen (or the "add a site" state when there is none).
 */
export async function ToolFrame({
  render,
}: {
  render: (args: { ctx: ScreenCtx; s: ToolStrings; project: NonNullable<ScreenCtx["project"]> }) => ReactNode | Promise<ReactNode>;
}) {
  const ctx = await screenContext();
  const { t, locale, project, c, requestedProjectId } = ctx;
  if (!project) return <NoProject title={t("tools")} text={c.no_project} action={c.add_site} />;
  const s = TOOLS[locale];
  return (
    <>
      <TopBar title={t("tools")} />
      <div className="view">
        <ToolsNav
          label={s.nav_label}
          projectId={requestedProjectId}
          labels={{ t_schema: s.t_schema, t_links: s.t_links, t_robots: s.t_robots, t_sitemap: s.t_sitemap }}
        />
        {await render({ ctx, s, project })}
      </div>
    </>
  );
}
