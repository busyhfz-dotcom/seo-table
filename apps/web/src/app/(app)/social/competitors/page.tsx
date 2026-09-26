import { TopBar } from "../../../../components/shell";
import { NoProject } from "../../../../lib/screen";
import { socialScreen } from "../load";
import { SocialCompetitorsScreen } from "./screen";

export const dynamic = "force-dynamic";

/** Competing Instagram pages or Telegram channels, compared with the profile's own figures. */
export default async function SocialCompetitorsPage() {
  const { t, ctx, s, c } = await socialScreen();
  if (!ctx) return <NoProject title={t("competitors")} text={c.no_project} action={c.add_site} />;
  return (
    <>
      <TopBar title={t("competitors")} />
      <div className="view">
        <SocialCompetitorsScreen ctx={ctx} s={s} c={c} />
      </div>
    </>
  );
}
