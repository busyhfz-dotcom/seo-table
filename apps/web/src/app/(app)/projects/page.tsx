import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { Card, Empty, Status, Table } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import { listProjects } from "../../../lib/queries";
import { num, relative } from "../../../lib/format";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const { t, locale, pathname, session } = await pageContext();
  const projects = await listProjects(session.orgId);

  return (
    <>
      <TopBar t={t} locale={locale} pathname={pathname} title={t("projects")} />
      <div className="view">
        <Card
          title={t("projects")}
          sub={`${num(projects.length, locale)}`}
          right={
            <Link className="btn primary" href="/onboarding">
              <Icon name="plus" />
              {t("new_project")}
            </Link>
          }
          bare
        >
          {projects.length === 0 ? (
            <Empty icon="folder">{t("nothing_here")}</Empty>
          ) : (
            <Table
              head={[
                { label: t("proj_site") },
                { label: t("proj_lang") },
                { label: t("score"), numeric: true },
                { label: t("proj_issues"), numeric: true },
                { label: t("status") },
                { label: t("last_scan") },
                { label: "" },
              ]}
            >
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{p.name}</div>
                    <div className="path">{p.baseUrl.replace(/^https?:\/\//, "")}</div>
                  </td>
                  <td>
                    <span className="pill mute">{p.locale === "fa" ? "فارسی · RTL" : "EN · LTR"}</span>
                  </td>
                  <td className="tnum">{p.score === null ? "—" : num(p.score, locale)}</td>
                  <td className="tnum">{num(p.openIssues, locale)}</td>
                  <td>{p.lastRun ? <Status value={p.lastRun.status} t={t} /> : <span style={{ color: "var(--ink-3)" }}>—</span>}</td>
                  <td style={{ color: "var(--ink-3)" }}>
                    {p.lastRun ? relative(p.lastRun.queuedAt, locale) : "—"}
                  </td>
                  <td style={{ textAlign: "end" }}>
                    <Link className="btn ghost sm" href={`/audit?project=${p.id}`}>
                      {t("details")}
                    </Link>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
