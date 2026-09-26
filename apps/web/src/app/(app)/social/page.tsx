import { TopBar } from "../../../components/shell";
import { NoProject } from "../../../lib/screen";
import { instagramRedirectUri, socialScreen } from "./load";
import { SocialOverview } from "./overview";

export const dynamic = "force-dynamic";

/**
 * An Instagram page's or Telegram channel's overview, and where it is
 * connected. Instagram's consent screen returns here with
 * ?instagram=connected|error&reason=…, which becomes a message in the reader's
 * language.
 */
export default async function SocialPage({ searchParams }: { searchParams: Promise<{ instagram?: string; reason?: string }> }) {
  const params = await searchParams;
  const { t, ctx, s, c } = await socialScreen();
  if (!ctx) return <NoProject title={t("social")} text={c.no_project} action={c.add_site} />;
  const flash =
    params.instagram === "connected"
      ? { tone: "ok" as const, text: s.ig_connected }
      : params.instagram === "error"
        ? { tone: "crit" as const, text: `${s.ig_failed} ${ctx.reasons[params.reason ?? ""] ?? s.unknown_reason}` }
        : null;
  return (
    <>
      <TopBar title={t("social")} />
      <div className="view">
        <SocialOverview ctx={ctx} s={s} c={c} flash={flash} redirectUri={instagramRedirectUri()} />
      </div>
    </>
  );
}
