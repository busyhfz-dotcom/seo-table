import { TopBar } from "../../../../components/shell";
import { NoProject } from "../../../../lib/screen";
import { socialScreen } from "../load";
import { SocialPostsScreen } from "./screen";

export const dynamic = "force-dynamic";

/** Synced posts of an Instagram page or Telegram channel, with each figure's source. */
export default async function SocialPostsPage() {
  const { t, ctx, s, c } = await socialScreen();
  if (!ctx) return <NoProject title={t("social_posts")} text={c.no_project} action={c.add_site} />;
  return (
    <>
      <TopBar title={t("social_posts")} />
      <div className="view">
        <SocialPostsScreen ctx={ctx} s={s} c={c} />
      </div>
    </>
  );
}
