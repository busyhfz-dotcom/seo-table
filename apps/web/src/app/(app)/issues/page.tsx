import Link from "next/link";
import { categoryLabel, fixTitle, readableUrl, ruleTitle } from "../../../lib/labels";
import { TopBar } from "../../../components/shell";
import { Card, Empty, Sev, Status, Table } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext, withProject, websiteOnly } from "../../../lib/page";
import { getIssue, issueCategories, listIssues } from "../../../lib/queries";
import { dateTime, num, pathOf, relative } from "../../../lib/format";
import type { Severity } from "@seo/db";

export const dynamic = "force-dynamic";

const SEVERITIES: Severity[] = ["CRITICAL", "SERIOUS", "WARNING", "INFO"];

export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<{
    project?: string;
    severity?: string;
    status?: string;
    category?: string;
    q?: string;
    issue?: string;
    page?: string;
  }>;
}) {
  await websiteOnly();
  const params = await searchParams;
  const { t, locale, project, requestedProjectId } = await pageContext();

  if (!project) {
    return (
      <>
        <TopBar title={t("issues")} />
        <div className="view">
          <Card title={t("issues")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const severity = SEVERITIES.includes(params.severity as Severity)
    ? (params.severity as Severity)
    : undefined;
  const status =
    params.status === "FIXED" || params.status === "IGNORED" ? params.status : ("OPEN" as const);
  const pageNo = Math.max(1, Number(params.page ?? 1) || 1);
  const perPage = 40;

  const [{ rows, total }, categories] = await Promise.all([
    listIssues(project.id, {
      ...(severity ? { severity } : {}),
      status,
      ...(params.category ? { category: params.category } : {}),
      ...(params.q ? { q: params.q } : {}),
      limit: perPage,
      offset: (pageNo - 1) * perPage,
    }),
    issueCategories(project.id),
  ]);
  // Without an explicit pick, the detail pane shows the first issue of the list
  // as filtered, never one the filters exclude.
  const detailId = params.issue ?? rows[0]?.id;
  const detail = detailId ? await getIssue(project.id, detailId) : null;

  // Filters combine: every link keeps the others (and the project).
  const qs = (patch: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const merged = { ...params, project: requestedProjectId ?? undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, String(v));
    return `/issues?${sp.toString()}`;
  };

  return (
    <>
      <TopBar title={t("issues")} />
      <div className="view">
        <div className="split">
          <Card
            title={t("issues")}
            sub={`${num(total, locale)} ${t(status === "OPEN" ? "st_open" : status === "FIXED" ? "st_fixed" : "st_ignored")}`}
            right={
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <form action="/issues" method="get" className="search" role="search">
                  <Icon name="search" />
                  <input
                    name="q"
                    type="search"
                    defaultValue={params.q ?? ""}
                    placeholder={t("search")}
                    aria-label={t("search_issues")}
                    id="issue-q"
                  />
                  {requestedProjectId && <input type="hidden" name="project" value={requestedProjectId} />}
                  {status !== "OPEN" && <input type="hidden" name="status" value={status} />}
                  {params.category && <input type="hidden" name="category" value={params.category} />}
                  {severity && <input type="hidden" name="severity" value={severity} />}
                </form>
                <div className="seg" role="group" aria-label={t("status")}>
                  {(["OPEN", "FIXED", "IGNORED"] as const).map((s) => (
                    <Link
                      key={s}
                      href={qs({ status: s === "OPEN" ? undefined : s, page: undefined, issue: undefined })}
                      aria-current={status === s}
                    >
                      {t(s === "OPEN" ? "st_open" : s === "FIXED" ? "st_fixed" : "st_ignored")}
                    </Link>
                  ))}
                </div>
                <div className="seg" role="group" aria-label={t("severity")}>
                  <Link href={qs({ severity: undefined, page: undefined, issue: undefined })} aria-current={!severity}>
                    {t("all")}
                  </Link>
                  {SEVERITIES.map((s) => (
                    <Link
                      key={s}
                      href={qs({ severity: s, page: undefined, issue: undefined })}
                      aria-current={severity === s}
                    >
                      {t(`sev_${s.toLowerCase()}` as never)}
                    </Link>
                  ))}
                </div>
              </div>
            }
            bare
          >
            {rows.length === 0 ? (
              <Empty icon="check">{t("no_issues")}</Empty>
            ) : (
              <>
                <Table
                  head={[
                    { label: t("severity") },
                    { label: t("rule") },
                    { label: t("category") },
                    { label: t("pages"), numeric: true },
                    { label: t("occurrences"), numeric: true },
                    { label: t("first_seen") },
                  ]}
                >
                  {rows.map((issue) => (
                    <tr key={issue.id}>
                      <td>
                        <Sev severity={issue.severity} t={t} />
                      </td>
                      <td>
                        <Link href={qs({ issue: issue.id })} style={{ fontWeight: 500 }}>
                          {ruleTitle(issue.ruleId, issue.title, locale)}
                        </Link>
                        <div className="path" dir="ltr">
                          {issue.ruleId}
                        </div>
                      </td>
                      <td style={{ color: "var(--ink-2)" }}>{categoryLabel(issue.category, locale)}</td>
                      <td className="tnum">{num(issue.pageCount, locale)}</td>
                      <td className="tnum">{num(issue.occurrenceCount, locale)}</td>
                      <td style={{ color: "var(--ink-3)" }}>{relative(issue.firstSeenAt, locale)}</td>
                    </tr>
                  ))}
                </Table>
                {total > perPage && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      padding: "12px 18px",
                      borderTop: "1px solid var(--border)",
                      alignItems: "center",
                    }}
                  >
                    {pageNo > 1 && (
                      <Link className="btn ghost sm" href={qs({ page: String(pageNo - 1) })}>
                        ‹
                      </Link>
                    )}
                    <span className="num" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      {num(pageNo, locale)} / {num(Math.ceil(total / perPage), locale)}
                    </span>
                    {pageNo * perPage < total && (
                      <Link className="btn ghost sm" href={qs({ page: String(pageNo + 1) })}>
                        ›
                      </Link>
                    )}
                  </div>
                )}
              </>
            )}
          </Card>

          <Card title={t("issue_detail")} sub={detail ? categoryLabel(detail.issue.category, locale) : undefined}>
            {!detail ? (
              <Empty>{t("nothing_here")}</Empty>
            ) : (
              <>
                <h3 style={{ fontSize: 14.5, marginBottom: 8 }}>
                  {ruleTitle(detail.issue.ruleId, detail.issue.title, locale)}
                </h3>
                <dl className="kv" style={{ marginBottom: 14 }}>
                  <dt>{t("severity")}</dt>
                  <dd>
                    <Sev severity={detail.issue.severity} t={t} />
                  </dd>
                  <dt>{t("status")}</dt>
                  <dd>
                    <Status value={detail.issue.status} t={t} />
                  </dd>
                  <dt>{t("affected")}</dt>
                  <dd className="num">{num(detail.issue.pageCount, locale)}</dd>
                  <dt>{t("occurrences")}</dt>
                  <dd className="num">{num(detail.issue.occurrenceCount, locale)}</dd>
                  <dt>{t("first_seen")}</dt>
                  <dd>{dateTime(detail.issue.firstSeenAt, locale)}</dd>
                </dl>

                {detail.affected.length > 0 && (
                  <>
                    <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 6 }}>
                      {t("affected")}
                    </div>
                    <ul className="plain" dir="ltr" style={{ marginBottom: 14 }}>
                      {detail.affected.slice(0, 8).map((url) => (
                        <li key={url} className="path">
                          {readableUrl(pathOf(url))}
                        </li>
                      ))}
                      {detail.affected.length > 8 && (
                        <li style={{ color: "var(--ink-3)" }}>
                          +{num(detail.affected.length - 8, locale)}
                        </li>
                      )}
                    </ul>
                  </>
                )}

                {detail.proposals.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 6 }}>
                      {t("suggested")}
                    </div>
                    {detail.proposals.map((p) => (
                      <Link
                        key={p.id}
                        href={withProject(p.status === "AWAITING_APPROVAL" ? "/approvals" : "/fixes", requestedProjectId)}
                        className="btn ghost sm"
                        style={{ marginInlineEnd: 6, marginBottom: 6 }}
                      >
                        <Icon name="wand" />
                        {fixTitle(p.action, p.title, locale)}
                      </Link>
                    ))}
                  </div>
                )}

                <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 6 }}>
                  {t("history")}
                </div>
                <ul className="feed">
                  {detail.timeline.slice(0, 10).map((occ) => (
                    <li key={occ.id}>
                      <span className="ic">
                        <Icon
                          name={
                            occ.kind === "RESOLVED"
                              ? "check"
                              : occ.kind === "REGRESSED"
                                ? "alert"
                                : "clock"
                          }
                        />
                      </span>
                      <span>
                        {kindLabel(occ.kind, locale)}
                        {occ.url.startsWith("project:") ? "" : " · "}
                        {!occ.url.startsWith("project:") && (
                          <span className="path" dir="ltr">
                            {readableUrl(pathOf(occ.url))}
                          </span>
                        )}
                      </span>
                      <time>{relative(occ.observedAt, locale)}</time>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </div>

        {categories.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("category")}:</span>
            <Link
              className={`pill ${params.category ? "mute" : "acc"}`}
              href={qs({ category: undefined, page: undefined, issue: undefined })}
            >
              {t("all")}
            </Link>
            {categories.map((c) => (
              <Link
                key={c}
                className={`pill ${params.category === c ? "acc" : "mute"}`}
                href={qs({ category: c, page: undefined, issue: undefined })}
              >
                {categoryLabel(c, locale)}
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function kindLabel(kind: string, locale: "fa" | "en"): string {
  const fa = locale === "fa";
  switch (kind) {
    case "DETECTED":
      return fa ? "اولین مشاهده" : "First detected";
    case "PERSISTED":
      return fa ? "همچنان وجود دارد" : "Still present";
    case "REGRESSED":
      return fa ? "بازگشت پس از اصلاح" : "Regressed after a fix";
    case "RESOLVED":
      return fa ? "برطرف شد" : "Resolved";
    default:
      return kind;
  }
}
