import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { Card, Empty, Note, Sev, Table } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import {
  defaultProject,
  getProject,
  listConnectors,
  listOpportunities,
} from "../../../lib/queries";
import { decimal, num, pct, relative } from "../../../lib/format";
import { SyncButton } from "./sync";

export const dynamic = "force-dynamic";

/**
 * Content opportunities come from Search Console. With no connector there is
 * nothing to show, and this screen says exactly that instead of displaying an
 * invented table — a fabricated keyword list would be worse than an empty one.
 */
export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const params = await searchParams;
  const { t, locale, pathname, session } = await pageContext();

  const project = params.project
    ? await getProject(session.orgId, params.project)
    : await defaultProject(session.orgId);

  if (!project) {
    return (
      <>
        <TopBar t={t} locale={locale} pathname={pathname} title={t("content")} />
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
      <TopBar t={t} locale={locale} pathname={pathname} title={t("content")} />
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
              <SyncButton label={t("refresh")} busyLabel={t("loading")} />
            ) : (
              <Link className="btn primary" href="/connectors">
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
                    <div style={{ fontWeight: 500 }}>{o.query}</div>
                    {o.url && (
                      <div className="path" dir="ltr">
                        {o.url.replace(/^https?:\/\/[^/]+/, "")}
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
                  <td style={{ color: "var(--ink-2)" }}>{o.suggestedAction}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
