import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { Bar, Card, Empty, Note, Status, Table } from "../../../components/ui";
import { pageContext } from "../../../lib/page";
import {
  defaultProject,
  getProject,
  getRun,
  issueCountsByUrl,
  latestRunFor,
  runPages,
} from "../../../lib/queries";
import { dateTime, duration, num, pathOf, relative } from "../../../lib/format";
import { ALL_RULES } from "@seo/core";
import { ScanButton } from "../scan-button";
import { CancelScanButton } from "./cancel-button";

export const dynamic = "force-dynamic";

type Tab = "overview" | "pages" | "rules";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; project?: string; tab?: string; page?: string }>;
}) {
  const params = await searchParams;
  const { t, locale, pathname, session } = await pageContext();
  const tab: Tab = params.tab === "pages" ? "pages" : params.tab === "rules" ? "rules" : "overview";

  const project = params.project
    ? await getProject(session.orgId, params.project)
    : await defaultProject(session.orgId);

  if (!project) {
    return (
      <>
        <TopBar t={t} locale={locale} pathname={pathname} title={t("audit")} />
        <div className="view">
          <Card title={t("audit")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const run = params.run
    ? await getRun(session.orgId, params.run)
    : await (async () => {
        const latest = await latestRunFor(project.id);
        return latest ? await getRun(session.orgId, latest.id) : null;
      })();

  if (!run) {
    return (
      <>
        <TopBar
          t={t}
          locale={locale}
          pathname={pathname}
          title={t("audit")}
          right={<ScanButton projectId={project.id} label={t("scan")} activeLabel={t("st_running")} />}
        />
        <div className="view">
          <Card title={t("audit")} sub={project.name}>
            <Empty icon="pulse">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const active = run.status === "RUNNING" || run.status === "QUEUED";
  const pageNo = Math.max(1, Number(params.page ?? 1) || 1);
  const perPage = 50;

  const pages =
    tab === "pages" || tab === "overview"
      ? await runPages(run.id, { limit: perPage, offset: (pageNo - 1) * perPage })
      : { rows: [], total: 0 };
  const issueCounts = pages.rows.length ? await issueCountsByUrl(run.id) : new Map<string, number>();

  const breakdown = (run.scoreBreakdown ?? null) as
    | {
        byCategory?: Array<{ category: string; penalty: number; issues: number }>;
        perRule?: Array<{ ruleId: string; category: string; count: number; pages: number }>;
        skipped?: Record<string, number>;
        worstPages?: Array<{ url: string; score: number; issues: number }>;
      }
    | null;

  const tabHref = (next: Tab) =>
    `/audit?run=${run.id}${next === "overview" ? "" : `&tab=${next}`}`;

  return (
    <>
      <TopBar
        t={t}
        locale={locale}
        pathname={pathname}
        title={t("audit")}
        right={
          active ? (
            <CancelScanButton runId={run.id} label={t("stop_scan")} />
          ) : (
            <ScanButton projectId={project.id} label={t("scan")} activeLabel={t("st_running")} />
          )
        }
      />

      <div className="view">
        <section className="card">
          <div className="body" style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div
                style={{
                  fontSize: 11.5,
                  letterSpacing: ".05em",
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                }}
              >
                {t("run_header")}
              </div>
              <div className="path" style={{ fontSize: 15, marginTop: 4 }}>
                {run.id}
              </div>
            </div>
            <div style={{ width: 1, height: 38, background: "var(--border)" }} />
            <dl className="kv" style={{ gridTemplateColumns: "auto auto auto auto auto auto", alignItems: "center" }}>
              <dt>{t("status")}</dt>
              <dd>
                <Status value={run.status} t={t} />
              </dd>
              <dt>{t("crawled")}</dt>
              <dd className="num">
                {num(run.pagesCrawled, locale)}
                {run.pagesTotal ? ` / ${num(run.pagesTotal, locale)}` : ""}
              </dd>
              <dt>{t("duration")}</dt>
              <dd className="num">{duration(run.startedAt, run.finishedAt, locale)}</dd>
            </dl>
            <span className="spacer" />
            <div style={{ textAlign: "end", fontSize: 12, color: "var(--ink-3)" }}>
              <div>{project.name}</div>
              <div>{dateTime(run.queuedAt, locale)}</div>
            </div>
          </div>
          {active && run.pagesTotal ? (
            <div className="body" style={{ paddingTop: 0 }}>
              <Bar value={run.pagesCrawled} max={run.pagesTotal} />
            </div>
          ) : null}
        </section>

        {run.error && (
          <Note tone="crit" icon="alert">
            {run.errorCode ? `${run.errorCode}: ` : ""}
            {run.error}
          </Note>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div className="seg" role="group">
            <Link href={tabHref("overview")} aria-current={tab === "overview"}>
              {t("tab_over")}
            </Link>
            <Link href={tabHref("pages")} aria-current={tab === "pages"}>
              {t("tab_pages")}
            </Link>
            <Link href={tabHref("rules")} aria-current={tab === "rules"}>
              {t("tab_rules")}
            </Link>
          </div>
        </div>

        {tab === "overview" && (
          <div className="split">
            <Card title={t("score")} sub={run.score === null ? undefined : `${num(run.score, locale)} / ${num(100, locale)}`}>
              {breakdown?.byCategory?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {breakdown.byCategory.slice(0, 8).map((c) => (
                    <div key={c.category}>
                      <div style={{ display: "flex", gap: 8, fontSize: 12.5, marginBottom: 5 }}>
                        <span>{c.category}</span>
                        <span className="spacer" />
                        <span className="num" style={{ color: "var(--ink-3)" }}>
                          −{num(c.penalty, locale)}
                        </span>
                      </div>
                      <Bar
                        value={c.penalty}
                        max={Math.max(...breakdown.byCategory!.map((x) => x.penalty))}
                        tone="crit"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <Empty>{t("nothing_here")}</Empty>
              )}
            </Card>

            <Card title={t("affected")} sub={t("pages")}>
              {breakdown?.worstPages?.length ? (
                <Table head={[{ label: t("page_url") }, { label: t("score"), numeric: true }]}>
                  {breakdown.worstPages.slice(0, 8).map((p) => (
                    <tr key={p.url}>
                      <td className="path" dir="ltr">
                        {pathOf(p.url)}
                      </td>
                      <td className="tnum">{num(p.score, locale)}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>{t("nothing_here")}</Empty>
              )}
            </Card>
          </div>
        )}

        {(tab === "pages" || tab === "overview") && (
          <Card
            title={t("tab_pages")}
            sub={`${num(pages.total, locale)} ${t("pages")}`}
            bare
          >
            {pages.rows.length === 0 ? (
              <Empty>{t("nothing_here")}</Empty>
            ) : (
              <>
                <Table
                  head={[
                    { label: t("page_url") },
                    { label: t("title_len"), numeric: true },
                    { label: t("meta") },
                    { label: t("h1"), numeric: true },
                    { label: t("canon") },
                    { label: t("indexable") },
                    { label: t("issues_n"), numeric: true },
                  ]}
                >
                  {pages.rows.map((p) => (
                    <tr key={p.id}>
                      <td className="path" dir="ltr">
                        {pathOf(p.normalizedUrl)}
                        {p.statusCode !== 200 && (
                          <span className="pill crit" style={{ marginInlineStart: 8 }}>
                            {p.statusCode === 0 ? "ERR" : p.statusCode}
                          </span>
                        )}
                      </td>
                      <td className="tnum">{num(p.titleLength, locale)}</td>
                      <td>
                        {p.metaDescription ? (
                          <span className="pill ok">✓</span>
                        ) : (
                          <span className="pill crit">✕</span>
                        )}
                      </td>
                      <td className="tnum">{num((p.h1s as string[]).length, locale)}</td>
                      <td>
                        {p.canonical ? <span className="pill ok">✓</span> : <span className="pill warn">✕</span>}
                      </td>
                      <td>
                        {p.indexable ? (
                          <span className="pill ok">{t("indexable")}</span>
                        ) : (
                          <span className="pill mute">{p.noindexReason ?? "—"}</span>
                        )}
                      </td>
                      <td className="tnum">{num(issueCounts.get(p.normalizedUrl) ?? 0, locale)}</td>
                    </tr>
                  ))}
                </Table>
                {pages.total > perPage && (
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
                      <Link className="btn ghost sm" href={`/audit?run=${run.id}&tab=pages&page=${pageNo - 1}`}>
                        ‹
                      </Link>
                    )}
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }} className="num">
                      {num(pageNo, locale)} / {num(Math.ceil(pages.total / perPage), locale)}
                    </span>
                    {pageNo * perPage < pages.total && (
                      <Link className="btn ghost sm" href={`/audit?run=${run.id}&tab=pages&page=${pageNo + 1}`}>
                        ›
                      </Link>
                    )}
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        {tab === "rules" && (
          <Card title={t("tab_rules")} sub={`${num(ALL_RULES.length, locale)}`} bare>
            <Table
              head={[
                { label: t("rule") },
                { label: t("category") },
                { label: t("pages"), numeric: true },
                { label: t("occurrences"), numeric: true },
              ]}
            >
              {ALL_RULES.map((rule) => {
                const stat = breakdown?.perRule?.find((r) => r.ruleId === rule.id);
                return (
                  <tr key={rule.id}>
                    <td>
                      <div className="path">{rule.id}</div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{rule.description}</div>
                    </td>
                    <td style={{ color: "var(--ink-2)" }}>{rule.category}</td>
                    <td className="tnum">{num(stat?.pages ?? 0, locale)}</td>
                    <td className="tnum">{num(stat?.count ?? 0, locale)}</td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        )}

        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {t("last_seen")}: {relative(run.finishedAt ?? run.queuedAt, locale)}
        </div>
      </div>
    </>
  );
}
