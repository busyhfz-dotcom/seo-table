import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { Card, Empty, Note, Sev, Table, UserText } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { withProject } from "../../../lib/page";
import { listConnectors, listOpportunities } from "../../../lib/queries";
import { decimal, num, pct, relative } from "../../../lib/format";
import { readableUrl, suggestedActionLabel } from "../../../lib/labels";
import { NoProject, screenContext } from "../../../lib/screen";
import type { Project } from "@seo/db";
import { SyncButton } from "./sync";
import { CONTENT } from "./strings";
import { DocumentsScreen } from "./documents";

export const dynamic = "force-dynamic";

/**
 * Content: the editor's documents, and the Search Console opportunities that
 * suggest what to write or rewrite. Opportunities come only from Search
 * Console; with no connector the tab says so instead of showing an invented
 * keyword list.
 */
export default async function ContentPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const params = await searchParams;
  const ctx = await screenContext();
  const { t, locale, project, c, allowed, href } = ctx;
  if (!project) return <NoProject title={t("content")} text={c.no_project} action={c.add_site} />;
  const s = CONTENT[locale];
  const tab = params.tab === "opps" ? "opps" : "docs";

  return (
    <>
      <TopBar title={t("content")} />
      <div className="view">
        <div className="tabs" role="tablist" aria-label={s.tabs_label}>
          <Link className="tab" role="tab" aria-selected={tab === "docs"} href={href("/content")}>
            <Icon name="pen" />
            <span>{s.tab_docs}</span>
          </Link>
          <Link className="tab" role="tab" aria-selected={tab === "opps"} href={href("/content?tab=opps")}>
            <Icon name="bulb" />
            <span>{s.tab_opps}</span>
          </Link>
        </div>
        {tab === "docs" ? (
          <DocumentsScreen
            s={s}
            c={c}
            ctx={{
              projectId: project.id,
              baseUrl: project.baseUrl,
              locale,
              canWrite: allowed("content:write"),
              editorHref: href("/content/__ID__"),
            }}
          />
        ) : (
          <Opportunities project={project} ctx={ctx} />
        )}
      </div>
    </>
  );
}

async function Opportunities({ project, ctx }: { project: Project; ctx: Awaited<ReturnType<typeof screenContext>> }) {
  const { t, locale, allowed, requestedProjectId } = ctx;
  const [connectors, rows] = await Promise.all([listConnectors(project.id), listOpportunities(project.id)]);
  const gsc = connectors.find((x) => x.kind === "SEARCH_CONSOLE");
  const connected = gsc?.status === "CONNECTED";
  return (
    <>
      {!connected && <Note icon="info">{t("content_needs_gsc")}</Note>}
      <Card
        title={CONTENT[locale].tab_opps}
        sub={connected && gsc?.lastSyncAt ? `${t("last_sync")} ${relative(gsc.lastSyncAt, locale)}` : undefined}
        right={
          connected ? (
            allowed("connector:write") ? (
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
          <Empty icon="bulb">{connected ? t("nothing_here") : t("content_needs_gsc")}</Empty>
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
    </>
  );
}
