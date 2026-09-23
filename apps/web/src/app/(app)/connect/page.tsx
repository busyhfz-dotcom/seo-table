import Link from "next/link";
import { can } from "@seo/core";
import { TopBar } from "../../../components/shell";
import { Card, Empty } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext, withProject } from "../../../lib/page";
import { ConnectScreen } from "./connect-screen";
import { connectStrings } from "./keys";
import { loadConnection } from "./load";

export const dynamic = "force-dynamic";

/**
 * Connect site: after the audit, the owner gives permission and connects the
 * site through either approach — without installing anything (Cloudflare edge,
 * WordPress through its own API, or the fix pack) or with the SEO Table bridge
 * plugin — and chooses which connection writes the fixes.
 */
export default async function ConnectPage() {
  const { t, locale, session, project, requestedProjectId } = await pageContext();

  if (!project) {
    return (
      <>
        <TopBar title={t("connect_site")} />
        <div className="view">
          <Card title={t("connect_site")}>
            <Empty icon="rocket">
              <p style={{ marginBottom: 12 }}>{t("cn_no_project")}</p>
              <Link className="btn primary" href="/onboarding?new=1">
                <Icon name="plus" />
                {t("cn_add_site")}
              </Link>
            </Empty>
          </Card>
        </div>
      </>
    );
  }

  const view = await loadConnection(project, locale);
  return (
    <>
      <TopBar title={t("connect_site")} />
      <div className="view">
        <ConnectScreen
          view={view}
          s={connectStrings(t)}
          locale={locale}
          canWrite={can(session.role, "connector:write")}
          canRun={can(session.role, "scan:run")}
          auditHref={withProject("/audit", requestedProjectId)}
        />
      </div>
    </>
  );
}
