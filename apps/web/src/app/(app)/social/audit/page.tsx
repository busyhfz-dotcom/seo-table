import { TopBar } from "../../../../components/shell";
import { NoProject } from "../../../../lib/screen";
import { socialScreen } from "../load";
import { SocialAuditScreen } from "./screen";

export const dynamic = "force-dynamic";

/** The Instagram / Telegram profile audit: findings, suggested texts, and the Telegram changes waiting for approval. */
export default async function SocialAuditPage() {
  const { t, ctx, s, c } = await socialScreen();
  if (!ctx) return <NoProject title={t("social_audit")} text={c.no_project} action={c.add_site} />;
  return (
    <>
      <TopBar title={t("social_audit")} />
      <div className="view">
        <SocialAuditScreen ctx={ctx} s={s} c={c} />
      </div>
    </>
  );
}
