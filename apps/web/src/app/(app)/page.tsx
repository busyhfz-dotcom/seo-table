import Link from "next/link";
import { actionLabel } from "../../lib/labels";
import { TopBar } from "../../components/shell";
import { Card, Empty, Note, Status, Table, Tile, Bar } from "../../components/ui";
import { ScoreGauge, ScoreTrend } from "../../components/charts";
import { Icon } from "../../components/icons";
import { pageContext } from "../../lib/page";
import { dashboard, health } from "../../lib/queries";
import { dateTime, duration, num, relative } from "../../lib/format";
import { ScanButton } from "./scan-button";

export const dynamic = "force-dynamic";

const SEVERITY_TONE = { CRITICAL: "crit", SERIOUS: "serious", WARNING: "warn", INFO: "info" } as const;

export default async function DashboardPage() {
  const { t, locale, pathname, session } = await pageContext();
  const [data, sys] = await Promise.all([dashboard(session.orgId), health()]);

  if (!data.project) {
    return (
      <>
        <TopBar t={t} locale={locale} pathname={pathname} title={t("dashboard")} />
        <div className="view">
          <Card title={t("dashboard")}>
            <Empty icon="rocket">
              <p style={{ marginBottom: 12 }}>{t("no_runs_yet")}</p>
              <Link className="btn primary" href="/onboarding">
                <Icon name="plus" />
                {t("new_project")}
              </Link>
            </Empty>
          </Card>
        </div>
      </>
    );
  }

  const latest = data.latestRun;
  const scored = data.recentRuns.find((r) => r.status === "SUCCEEDED" && r.score !== null);
  const score = scored?.score ?? null;
  const previousScore = data.previousRun?.score ?? null;
  const delta = score !== null && previousScore !== null ? score - previousScore : null;
  const maxSeverity = Math.max(1, ...data.severity.map((s) => s.count));

  return (
    <>
      <TopBar
        t={t}
        locale={locale}
        pathname={pathname}
        title={t("dashboard")}
        right={<ScanButton projectId={data.project.id} label={t("scan")} activeLabel={t("st_running")} />}
      />

      <div className="view">
        {latest && (latest.status === "RUNNING" || latest.status === "QUEUED") && (
          <Note tone="acc" icon="play">
            {t("st_running")} — {num(latest.pagesCrawled, locale)}
            {latest.pagesTotal ? ` / ${num(latest.pagesTotal, locale)}` : ""} {t("pages")} ·{" "}
            <Link href={`/audit?run=${latest.id}`} style={{ textDecoration: "underline" }}>
              {t("view")}
            </Link>
          </Note>
        )}
        {latest?.status === "FAILED" && latest.error && (
          <Note tone="crit" icon="alert">
            {t("st_failed")}: {latest.error}
          </Note>
        )}

        <div className="grid g4">
          <Tile
            label={t("t_score")}
            value={score === null ? "—" : num(score, locale)}
            suffix={
              score === null ? null : (
                <span style={{ fontSize: 15, color: "var(--ink-3)", fontWeight: 400 }}>
                  {" "}
                  /{num(100, locale)}
                </span>
              )
            }
            foot={
              delta === null ? (
                <span>{data.project.baseUrl.replace(/^https?:\/\//, "")}</span>
              ) : (
                <>
                  <span className={`delta ${delta >= 0 ? "up" : "down"}`}>
                    {delta >= 0 ? "▲" : "▼"} {num(Math.abs(delta), locale)}
                  </span>
                  <span>{t("vs_last")}</span>
                </>
              )
            }
          />
          <Tile
            label={t("t_pages")}
            value={num(data.indexablePages, locale)}
            foot={<span>{t("of_crawled", { n: num(data.crawledPages, locale) })}</span>}
          />
          <Tile
            label={t("t_open")}
            value={num(data.openIssues, locale)}
            foot={
              <Link href="/issues" style={{ color: "var(--ink-3)", textDecoration: "underline" }}>
                {t("view")}
              </Link>
            }
          />
          <Tile
            label={t("t_pending")}
            value={num(data.pendingApprovals, locale)}
            foot={<span>{t("need_human")}</span>}
          />
        </div>

        <div className="split">
          <Card
            title={t("score_trend")}
            sub={data.trend.length > 1 ? `${num(data.trend.length, locale)} ${t("recent_runs")}` : undefined}
          >
            <div className="gauge-wrap">
              <ScoreGauge score={score ?? 0} label={t("t_score")} />
              <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                {data.trend.length === 0 ? (
                  <Empty>{t("no_runs_yet")}</Empty>
                ) : (
                  <ScoreTrend
                    ariaLabel={t("score_trend")}
                    todayLabel={relative(data.trend[data.trend.length - 1]!.at, locale)}
                    points={data.trend.map((p) => ({
                      label: dateTime(p.at, locale),
                      value: p.score,
                    }))}
                  />
                )}
              </div>
            </div>
          </Card>

          <Card title={t("severity_dist")} sub={`${num(data.openIssues, locale)} ${t("st_open")}`}>
            {data.openIssues === 0 ? (
              <Empty icon="check">{t("no_issues")}</Empty>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {data.severity.map((s) => (
                  <div key={s.severity}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span className={`sev ${SEVERITY_TONE[s.severity]}`}>
                        <i />
                        <span>
                          {t(
                            (`sev_${s.severity.toLowerCase()}` as unknown) as never,
                          )}
                        </span>
                      </span>
                      <span className="spacer" />
                      <span className="num" style={{ fontFamily: "var(--f-en)", fontSize: 13 }}>
                        {num(s.count, locale)}
                      </span>
                    </div>
                    <Bar value={s.count} max={maxSeverity} tone={SEVERITY_TONE[s.severity]} />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="split">
          <Card
            title={t("recent_runs")}
            right={
              <Link className="btn ghost sm" href="/audit">
                {t("view")}
              </Link>
            }
            bare
          >
            {data.recentRuns.length === 0 ? (
              <Empty>{t("no_runs_yet")}</Empty>
            ) : (
              <Table
                head={[
                  { label: "ID" },
                  { label: t("status") },
                  { label: t("pages"), numeric: true },
                  { label: t("score"), numeric: true },
                  { label: t("duration"), numeric: true },
                  { label: t("started") },
                ]}
              >
                {data.recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link href={`/audit?run=${run.id}`} className="path">
                        {run.id.slice(-8)}
                      </Link>
                    </td>
                    <td>
                      <Status value={run.status} t={t} />
                    </td>
                    <td className="tnum">{num(run.pagesCrawled, locale)}</td>
                    <td className="tnum">{run.score === null ? "—" : num(run.score, locale)}</td>
                    <td className="tnum">{duration(run.startedAt, run.finishedAt, locale)}</td>
                    <td style={{ color: "var(--ink-3)" }}>{relative(run.queuedAt, locale)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title={t("agent_activity")}>
            {data.activity.length === 0 ? (
              <Empty>{t("nothing_here")}</Empty>
            ) : (
              <ul className="feed">
                {data.activity.map((entry, i) => (
                  <li key={i}>
                    <span className="ic">
                      <Icon name={iconForAction(entry.action)} />
                    </span>
                    <span>{describeAction(entry.action, entry.actorType, entry.metadata, locale)}</span>
                    <time>{relative(entry.createdAt, locale)}</time>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid g2">
          <Card title={t("health")}>
            <dl className="kv">
              <dt>{t("database")}</dt>
              <dd>
                <Status value={sys.database ? "CONNECTED" : "ERROR"} t={t} />
              </dd>
              <dt>{t("redis")}</dt>
              <dd>
                <Status value={sys.redis ? "CONNECTED" : "ERROR"} t={t} />
              </dd>
              <dt>{t("queue_depth")}</dt>
              <dd className="num">
                {sys.queue
                  ? `${num(sys.queue.waiting + sys.queue.active, locale)} (${num(sys.queue.failed, locale)} ${t("st_failed")})`
                  : "—"}
              </dd>
            </dl>
          </Card>

          <Card title={t("approvals")}>
            {data.pendingApprovals === 0 ? (
              <Empty icon="check">{t("no_approvals")}</Empty>
            ) : (
              <>
                <Note tone="lock" icon="lock">
                  {t("appr_lock")}
                </Note>
                <div style={{ marginTop: 12 }}>
                  <Link className="btn primary" href="/approvals">
                    <Icon name="shield" />
                    {t("approvals")} ({num(data.pendingApprovals, locale)})
                  </Link>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function iconForAction(action: string): string {
  if (action.startsWith("scan")) return action.includes("fail") ? "x" : "play";
  if (action.startsWith("fix.apply")) return "wand";
  if (action.startsWith("fix.rollback")) return "undo";
  if (action.startsWith("approval")) return "shield";
  if (action.startsWith("connector")) return "plug";
  if (action.startsWith("auth")) return "user";
  if (action.startsWith("apikey")) return "key";
  return "info";
}

/**
 * The audit log stores machine actions; this turns one into a sentence. Anything
 * unrecognised is shown as its raw action rather than hidden.
 */
function describeAction(
  action: string,
  actorType: string,
  metadata: unknown,
  locale: "fa" | "en",
): string {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const act = actionLabel(String(m.action ?? ""), locale);
  const n = (v: unknown) => num(Number(v ?? 0), locale);
  const fa = locale === "fa";

  switch (action) {
    case "scan.enqueue":
      return fa ? "اسکن در صف قرار گرفت" : "Scan queued";
    case "scan.refused_overlap":
      return fa ? "اسکن رد شد: اسکن دیگری در حال اجراست" : "Scan refused: another is already running";
    case "scan.cancel":
      return fa ? "اسکن لغو شد" : "Scan cancelled";
    case "fix.propose":
      return fa
        ? `پیشنهاد اصلاح: ${act} روی ${n(m.targetCount)} هدف`
        : `Fix proposed: ${act} on ${n(m.targetCount)} targets`;
    case "fix.dry_run":
      return fa ? `اجرای آزمایشی: ${n(m.applied)} تغییر` : `Dry run: ${n(m.applied)} changes`;
    case "fix.apply":
      return fa
        ? `${n(m.applied)} تغییر اعمال شد${actorType === "AGENT" ? " (خودکار، کم‌ریسک)" : ""}`
        : `${n(m.applied)} changes applied${actorType === "AGENT" ? " (automatic, low risk)" : ""}`;
    case "fix.apply_blocked":
      return fa ? "اعمال اصلاح مسدود شد (نیازمند تأیید)" : "Fix blocked (approval required)";
    case "fix.rollback":
      return fa ? `${n(m.restored)} تغییر بازگردانده شد` : `${n(m.restored)} changes rolled back`;
    case "approval.request":
      return fa
        ? `ارسال برای تأیید: ${act}`
        : `Sent for approval: ${act}`;
    case "approval.approve":
      return fa ? `تأیید شد: ${act}` : `Approved: ${act}`;
    case "approval.reject":
      return fa ? `رد شد: ${act}` : `Rejected: ${act}`;
    case "connector.connect":
      return m.ok
        ? fa
          ? `${String(m.kind)} متصل شد`
          : `${String(m.kind)} connected`
        : fa
          ? `اتصال ${String(m.kind)} ناموفق بود`
          : `${String(m.kind)} connection failed`;
    case "connector.sync":
      return fa ? `${n(m.rows)} ردیف از ${"Search Console"} همگام شد` : `${n(m.rows)} rows synced from Search Console`;
    case "project.create":
      return fa ? "پروژه ساخته شد" : "Project created";
    case "auth.login":
      return fa ? "ورود به حساب" : "Signed in";
    case "auth.login_failed":
      return fa ? "تلاش ناموفق برای ورود" : "Failed sign-in attempt";
    case "apikey.create":
      return fa ? "کلید API ساخته شد" : "API key created";
    default:
      return action;
  }
}
