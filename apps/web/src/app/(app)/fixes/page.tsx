import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { fixTitle, fixWhy, readableUrl, resultCodeLabel, ruleName } from "../../../lib/labels";
import { Card, Diff, Empty, Note, RiskPill, Status } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import { listFixes } from "../../../lib/queries";
import { latestLiveExecutions } from "../../../lib/views";
import { num, pathOf, relative } from "../../../lib/format";
import { can, policyLimits, requiresApproval } from "@seo/core";
import type { Locale, T } from "../../../lib/i18n";
import { FixActions } from "./actions";
import { FixPreview } from "./preview";
import { previewable } from "./preview-fields";
import { connectionOverview } from "@seo/connectors";
import { withProject } from "../../../lib/page";
import { connectStrings } from "../connect/keys";

export const dynamic = "force-dynamic";

type Change = { url: string; field: string; before: string | null; after: string; selector?: string };
type WriteResult = { url: string; field: string; ok: boolean; code?: string; previous?: string | null };
type DryRun = { at?: string; applied?: number; failed?: number; skipped?: number; results?: WriteResult[] };

export default async function FixesPage() {
  const { t, locale, session, project, requestedProjectId } = await pageContext();

  if (!project) {
    return (
      <>
        <TopBar title={t("fixes")} />
        <div className="view">
          <Card title={t("fixes")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const [fixes, overview] = await Promise.all([
    listFixes(project.id, ["DRAFT", "APPROVED", "APPLYING", "APPLIED", "FAILED", "ROLLED_BACK"]),
    connectionOverview(project.id),
  ]);
  // Where Apply would write, and whether that connection can do each kind of fix.
  const target = overview.writeTarget.effective;
  const targetMethod = overview.methods.find((m) => m.kind === target);
  const writable = targetMethod?.status === "connected";
  const supported = new Set<string>(writable ? (targetMethod?.capabilities?.supportedActions ?? []) : []);
  const strings = connectStrings(t);
  const connectHref = withProject("/connect", requestedProjectId);
  const executions = await latestLiveExecutions(fixes.map((f) => f.id));
  const limits = policyLimits();
  const perms = {
    propose: can(session.role, "fix:propose"),
    apply: can(session.role, "fix:apply_low_risk"),
    rollback: can(session.role, "fix:rollback"),
  };

  return (
    <>
      <TopBar title={t("fixes")} />
      <div className="view">
        <Note tone="lock" icon="shield">
          {t("fix_policy", { n: num(limits.maxChangesPerExecution, locale) })}
        </Note>

        {fixes.length === 0 ? (
          <Card title={t("fixes")}>
            <Empty icon="wand">{t("no_fixes")}</Empty>
          </Card>
        ) : (
          <div className="grid g2">
            {fixes.map((fix) => {
              const changes = (fix.changes as Change[]) ?? [];
              const sample = changes[0];
              const needsApproval = requiresApproval(fix.action, fix.risk);
              const dryRun = (fix.dryRun ?? null) as DryRun | null;
              const execution = executions.get(fix.id);
              const canRollback =
                (fix.status === "APPLIED" || fix.status === "FAILED") &&
                execution !== undefined &&
                execution.rolledBackAt === null &&
                (execution.status === "APPLIED" || execution.status === "FAILED") &&
                execution.appliedCount > 0;
              const why = fixWhy(fix.action, fix.rationale, locale);
              return (
                <section className="card" key={fix.id}>
                  <header>
                    <h3>{fixTitle(fix.action, fix.title, locale)}</h3>
                    <RiskPill risk={fix.risk} t={t} />
                    <span className="spacer" />
                    <Status value={fix.status} t={t} />
                  </header>
                  <div className="body">
                    <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 8 }}>
                      {t("target")}:{" "}
                      <span className="num" style={{ color: "var(--ink)" }}>
                        {num(fix.targetCount, locale)}
                      </span>{" "}
                      {t("pages")} · {ruleName(fix.ruleId, locale)}
                    </div>

                    {why && <p style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 12 }}>{why}</p>}

                    {sample && <Diff before={sample.before} after={sample.after} />}
                    {changes.length > 1 && (
                      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                        +{num(changes.length - 1, locale)} {t("pages")}
                      </div>
                    )}

                    {needsApproval && (
                      <div style={{ marginTop: 12 }}>
                        <Note tone="lock" icon="lock">
                          {t("appr_lock")}
                        </Note>
                      </div>
                    )}

                    {dryRun?.at && fix.status !== "APPLIED" && fix.status !== "ROLLED_BACK" && (
                      <Outcome
                        title={t("dry_run_result")}
                        at={dryRun.at}
                        summary={t("dry_run_summary", {
                          ok: num(dryRun.applied ?? 0, locale),
                          failed: num(dryRun.failed ?? 0, locale),
                        })}
                        results={dryRun.results ?? []}
                        skipped={dryRun.skipped ?? 0}
                        locale={locale}
                        t={t}
                      />
                    )}

                    {execution && (fix.status === "FAILED" || execution.error) && execution.rolledBackAt === null && (
                      <Outcome
                        title={t("last_apply_result")}
                        at={execution.finishedAt?.toISOString() ?? null}
                        summary={t("apply_summary", {
                          ok: num(execution.appliedCount, locale),
                          failed: num(execution.failedCount, locale),
                        })}
                        results={((execution.results as WriteResult[] | null) ?? []).filter((r) => !r.ok)}
                        skipped={0}
                        locale={locale}
                        t={t}
                        tone="crit"
                      />
                    )}

                    <div className="via" style={{ marginTop: 12 }}>
                      <Icon name={writable ? (target === "CLOUDFLARE" ? "cloud" : "globe") : "box"} />
                      {writable ? (
                        <>
                          <span>
                            {t("fx_via")}: <b style={{ color: "var(--ink-2)", fontWeight: 500 }}>{t(`tg_${target}`)}</b>
                          </span>
                          {supported.has(fix.action) ? (
                            <span className="pill ok">
                              <Icon name="check" />
                              {t("fx_supported")}
                            </span>
                          ) : (
                            <>
                              <span className="pill warn">
                                <Icon name="alert" />
                                {t("fx_unsupported")}
                              </span>
                              <Link href={connectHref} className="lnk">
                                {t("connect_site")}
                              </Link>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <span>{t("fx_no_target")}</span>
                          <Link href={connectHref} className="lnk">
                            {t("connect_site")}
                          </Link>
                          <span>·</span>
                          <Link href={`${connectHref}#method-FIX_PACK`} className="lnk">
                            {t("fx_manual")}
                          </Link>
                        </>
                      )}
                    </div>

                    <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                      {previewable(changes) && (
                        <FixPreview changes={changes} projectId={project.id} locale={locale} s={strings} />
                      )}
                      <div style={{ flex: "1 1 auto" }}>
                      <FixActions
                        id={fix.id}
                        status={fix.status}
                        needsApproval={needsApproval}
                        approved={fix.decision === "APPROVED"}
                        dryRunAt={dryRun?.at ?? null}
                        canRollback={canRollback}
                        perms={perms}
                        locale={locale}
                        labels={{
                          dryRun: t("dry_run"),
                          apply: t("apply"),
                          retry: t("retry"),
                          rollback: t("rollback"),
                          waiting: t("st_awaiting_approval"),
                          forbidden: t("err_forbidden"),
                          dryRunFirst: t("dry_run_first"),
                          queued: t("fix_queued"),
                          slow: t("fix_slow"),
                          rolledBack: t("rolled_back_n"),
                          rollbackPartial: t("rollback_partial"),
                        }}
                      />
                      </div>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
                      {relative(fix.updatedAt, locale)}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** What a dry run or an apply did, change by change, with drift called out. */
function Outcome({
  title,
  at,
  summary,
  results,
  skipped,
  locale,
  t,
  tone,
}: {
  title: string;
  at: string | null;
  summary: string;
  results: WriteResult[];
  skipped: number;
  locale: Locale;
  t: T;
  tone?: "crit";
}) {
  const shown = results.slice(0, 6);
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: "var(--r)",
        background: "var(--surface-2)",
        boxShadow: `inset 0 0 0 1px ${tone === "crit" ? "rgba(240, 101, 94, 0.3)" : "var(--border)"}`,
        fontSize: 12.5,
      }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: shown.length ? 6 : 0 }}>
        <b style={{ fontWeight: 500 }}>{title}</b>
        {at && <span style={{ color: "var(--ink-3)" }}>{relative(at, locale)}</span>}
        <span className="spacer" />
        <span style={{ color: "var(--ink-2)" }}>{summary}</span>
      </div>
      {shown.length > 0 && (
        <ul className="plain" style={{ paddingInlineStart: 0, listStyle: "none" }}>
          {shown.map((r, i) => (
            <li key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span className={`pill ${r.ok ? "ok" : r.code === "changed_since_scan" ? "warn" : "crit"}`}>
                <Icon name={r.ok ? "check" : "alert"} />
                {resultCodeLabel(r.code, r.ok, locale)}
              </span>
              <span className="path" dir="ltr">
                {readableUrl(pathOf(r.url))}
              </span>
              {r.code === "changed_since_scan" && r.previous !== undefined && (
                <span style={{ color: "var(--ink-3)", width: "100%" }}>
                  {t("current_value")}: <span dir="auto">{readableUrl(r.previous ?? null) ?? "∅"}</span>
                </span>
              )}
            </li>
          ))}
          {results.length > shown.length && (
            <li style={{ color: "var(--ink-3)" }}>+{num(results.length - shown.length, locale)}</li>
          )}
        </ul>
      )}
      {skipped > 0 && (
        <div style={{ color: "var(--ink-3)", marginTop: 4 }}>{t("skipped_by_cap", { n: num(skipped, locale) })}</div>
      )}
    </div>
  );
}
