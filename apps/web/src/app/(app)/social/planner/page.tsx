import { TopBar } from "../../../../components/shell";
import { NoProject } from "../../../../lib/screen";
import { socialScreen } from "../load";
import { SocialPlannerScreen } from "./screen";

export const dynamic = "force-dynamic";

/** Planned posts for an Instagram page or Telegram channel: compose, approve, schedule, publish. */
export default async function SocialPlannerPage() {
  const { t, ctx, s, c } = await socialScreen();
  if (!ctx) return <NoProject title={t("social_planner")} text={c.no_project} action={c.add_site} />;
  return (
    <>
      <TopBar title={t("social_planner")} />
      <div className="view">
        <SocialPlannerScreen ctx={ctx} s={s} c={c} />
      </div>
    </>
  );
}
