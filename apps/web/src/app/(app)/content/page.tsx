import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { Card, Empty, Note, Sev, Table, UserText } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext, withProject } from "../../../lib/page";
import { listConnectors, listOpportunities } from "../../../lib/queries";
import { decimal, num, pct, relative } from "../../../lib/format";
import { readableUrl, suggestedActionLabel } from "../../../lib/labels";
import { can } from "@seo/core";
import { SyncButton } from "./sync";

export const dynamic = "force-dynamic";

/**
 * Content opportunities come from Search Console. With no connector there is
 * nothing to show, and this screen says exactly that instead of displaying an
 * invented table — a fabricated keyword list would be worse than an empty one.
 */
export default async function ContentPage() {
  const { t, locale, session, project, requestedProjectId } = await pageContext();

  if (!project) {
    return (
      <>
        <TopBar title={t("content")} />
        <div className="view">
          <Card title={t("content")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const [connectors, rows] = await Promise.all([
    listConnectors(project.id),
    listOpportunities(project.id),
  ]);
  const gsc = connectors.find((c) => c.kind === "SEARCH_CONSOLE");
  const connected = gsc?.status === "CONNECTED";

  return (
    <>
      <TopBar title={t("content")} />
      <div className="view">
        {!connected && <Note icon="info">{t("content_needs_gsc")}</Note>}

        <Card
          title={t("content")}
          sub={
            connected && gsc?.lastSyncAt
              ? `${t("last_sync")} ${relative(gsc.lastSyncAt, locale)}`
              : undefined
          }
          right={
            connected ? (
              can(session.role, "connector:write") ? (
                <SyncButton projectId={project.id} locale={locale} label={t("refresh")} busyLabel={t("loading")} />
              ) : null
            ) : (
              <Link className="btn primary" href={`${withProject("/connect", requestedProjectId)}#search-console`}>
                <Icon name="plug" />
                {t("connect")} Search Console
              </Link>
            )
          }
          bare
        >
          {rows.length === 0 ? (
            <Empty icon="bulb">
              {connected ? t("nothing_here") : t("content_needs_gsc")}
            </Empty>
          ) : (
            <Table
              head={[
                { label: t("query") },
                { label: t("impressions"), numeric: true },
                { label: t("clicks"), numeric: true },
                { label: t("ctr"), numeric: true },
                { label: t("position"), numeric: true },
                { label: t("gap") },
                { label: t("action_sugg") },
              ]}
            >
              {rows.map((o) => (
                <tr key={o.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>
                      <UserText>{o.query}</UserText>
                    </div>
                    {o.url && (
                      <div className="path" dir="ltr">
                        {readableUrl(o.url.replace(/^https?:\/\/[^/]+/, ""))}
                      </div>
                    )}
                  </td>
                  <td className="tnum">{num(o.impressions, locale)}</td>
                  <td className="tnum">{num(o.clicks, locale)}</td>
                  <td className="tnum">{pct(o.ctr, locale)}</td>
                  <td className="tnum">{decimal(o.position, locale)}</td>
                  <td>
                    <Sev severity={o.gap} t={t} />
                  </td>
                  <td style={{ color: "var(--ink-2)" }}>{suggestedActionLabel(o.suggestedAction, locale)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
