import { integrations } from "@seo/seo-data";
import { TopBar } from "../../../components/shell";
import { NoProject, screenContext } from "../../../lib/screen";
import { ALERTS } from "./strings";
import { AlertsScreen } from "./screen";

export const dynamic = "force-dynamic";

/**
 * Alerts: the project's notifications, the rules that raise them (in the panel,
 * a signed webhook, Telegram), and the schedules of the automatic jobs.
 */
export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const params = await searchParams;
  const { t, locale, project, c, allowed, links, session } = await screenContext();
  if (!project) return <NoProject title={t("alerts")} text={c.no_project} action={c.add_site} />;
  const telegram = await integrations.getIntegration(session.orgId, "TELEGRAM_ALERTS");
  const tab = params.tab === "rules" || params.tab === "schedules" ? params.tab : "notifications";
  return (
    <>
      <TopBar title={t("alerts")} />
      <div className="view">
        <AlertsScreen
          s={ALERTS[locale]}
          c={c}
          bell={{ markRead: t("bell_mark_read"), open: t("bell_open") }}
          ctx={{
            projectId: project.id,
            locale,
            canWrite: allowed("project:write"),
            telegram: telegram.configured,
            integrations: links.integrations,
            initialTab: tab,
            projectKind: project.kind,
          }}
        />
      </div>
    </>
  );
}
