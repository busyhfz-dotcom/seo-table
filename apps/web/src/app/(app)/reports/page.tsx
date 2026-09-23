import { TopBar } from "../../../components/shell";
import { categoryLabel, ruleTitle } from "../../../lib/labels";
import { Card, Empty, Note, Sev, Status, Table, UserText } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import { dashboard, listIssues } from "../../../lib/queries";
import { dateTime, duration, num } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Reports are generated from the same scan data, live. There is no separate
 * reports table to drift out of date: what you see is the current state of the
 * latest run, and the CSV endpoint exports exactly these rows.
 */
export default async function ReportsPage() {
  const { t, locale, session, project } = await pageContext();

  if (!project) {
    return (
      <>
        <TopBar title={t("reports")} />
        <div className="view">
          <Card title={t("reports")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const [data, critical] = await Promise.all([
    dashboard(session.orgId, project.id),
    listIssues(project.id, { severity: "CRITICAL", limit: 20 }),
  ]);

  const run = data.recentRuns.find((r) => r.status === "SUCCEEDED") ?? null;

  return (
    <>
      <TopBar
        title={t("reports")}
        right={
          <a className="btn ghost" href={`/api/reports/issues.csv?projectId=${project.id}`}>
            <Icon name="dl" />
            {t("export")} CSV
          </a>
        }
      />

      <div className="view">
        <Note icon="info">{t("reports_note")}</Note>

        <Card title={locale === "fa" ? "خلاصه وضعیت" : "Status summary"} sub={<UserText>{project.name}</UserText>}>
          {!run ? (
            <Empty>{t("no_runs_yet")}</Empty>
          ) : (
            <dl className="kv">
              <dt>{t("score")}</dt>
              <dd className="num">
                {run.score === null ? "—" : `${num(run.score, locale)} / ${num(100, locale)}`}
              </dd>
              <dt>{t("crawled")}</dt>
              <dd className="num">{num(data.crawledPages, locale)}</dd>
              <dt>{t("t_pages")}</dt>
              <dd className="num">{num(data.indexablePages, locale)}</dd>
              <dt>{t("t_open")}</dt>
              <dd className="num">{num(data.openIssues, locale)}</dd>
              <dt>{t("t_pending")}</dt>
              <dd className="num">{num(data.pendingApprovals, locale)}</dd>
              <dt>{t("duration")}</dt>
              <dd className="num">{duration(run.startedAt, run.finishedAt, locale)}</dd>
              <dt>{t("last_scan")}</dt>
              <dd>{dateTime(run.finishedAt ?? run.queuedAt, locale)}</dd>
              <dt>{t("status")}</dt>
              <dd>
                <Status value={run.status} t={t} />
              </dd>
            </dl>
          )}
        </Card>

        <Card
          title={locale === "fa" ? "ایشوهای بحرانی" : "Critical issues"}
          sub={`${num(critical.total, locale)}`}
          bare
        >
          {critical.rows.length === 0 ? (
            <Empty icon="check">{t("no_issues")}</Empty>
          ) : (
            <Table
              head={[
                { label: t("severity") },
                { label: t("rule") },
                { label: t("pages"), numeric: true },
                { label: t("occurrences"), numeric: true },
              ]}
            >
              {critical.rows.map((issue) => (
                <tr key={issue.id}>
                  <td>
                    <Sev severity={issue.severity} t={t} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{ruleTitle(issue.ruleId, issue.title, locale)}</div>
                    <div className="path" dir="ltr">
                      {issue.ruleId}
                    </div>
                  </td>
                  <td className="tnum">{num(issue.pageCount, locale)}</td>
                  <td className="tnum">{num(issue.occurrenceCount, locale)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title={locale === "fa" ? "تفکیک امتیاز" : "Score breakdown"}>
          {(() => {
            const breakdown = (run?.scoreBreakdown ?? null) as
              | { byCategory?: Array<{ category: string; penalty: number; issues: number }> }
              | null;
            if (!breakdown?.byCategory?.length) return <Empty>{t("nothing_here")}</Empty>;
            return (
              <Table
                head={[
                  { label: t("category") },
                  { label: locale === "fa" ? "کسر امتیاز" : "Penalty", numeric: true },
                  { label: t("issues_n"), numeric: true },
                ]}
              >
                {breakdown.byCategory.map((c) => (
                  <tr key={c.category}>
                    <td>{categoryLabel(c.category, locale)}</td>
                    <td className="tnum">−{num(c.penalty, locale)}</td>
                    <td className="tnum">{num(c.issues, locale)}</td>
                  </tr>
                ))}
              </Table>
            );
          })()}
        </Card>
      </div>
    </>
  );
}
