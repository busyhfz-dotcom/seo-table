import { socialAccounts } from "@seo/social";
import { TopBar } from "../../../../components/shell";
import { NoProject } from "../../../../lib/screen";
import { socialScreen } from "../load";
import { SocialAnalyticsScreen } from "./screen";

export const dynamic = "force-dynamic";

/** Growth, engagement, best times and hashtags of an Instagram page or Telegram channel. */
export default async function SocialAnalyticsPage() {
  const { t, ctx, s, c } = await socialScreen();
  if (!ctx) return <NoProject title={t("social_analytics")} text={c.no_project} action={c.add_site} />;
  const account = await socialAccounts.getAccount(ctx.projectId);
  return (
    <>
      <TopBar title={t("social_analytics")} />
      <div className="view">
        <SocialAnalyticsScreen ctx={ctx} s={s} c={c} connected={Boolean(account && account.status !== "NOT_CONNECTED")} />
      </div>
    </>
  );
}
