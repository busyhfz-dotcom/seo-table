import { ToolFrame } from "../frame";
import { RobotsScreen } from "./screen";

export const dynamic = "force-dynamic";

/** robots.txt: the live file, a tester, and an editor that reviews a change before proposing it. */
export default function RobotsToolPage() {
  return (
    <ToolFrame
      render={({ ctx, s, project }) => (
        <RobotsScreen
          s={s}
          c={ctx.c}
          ctx={{
            projectId: project.id,
            baseUrl: project.baseUrl,
            locale: ctx.locale,
            canPropose: ctx.allowed("fix:propose"),
            links: { fixes: ctx.href("/fixes"), approvals: ctx.href("/approvals"), connect: ctx.links.connect },
          }}
        />
      )}
    />
  );
}
