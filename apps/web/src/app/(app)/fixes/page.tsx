import { TopBar } from "../../../components/shell";
import { fixTitle, fixWhy } from "../../../lib/labels";
import { Card, Diff, Empty, Note, RiskPill, Status } from "../../../components/ui";
import { pageContext } from "../../../lib/page";
import { defaultProject, getProject, listFixes } from "../../../lib/queries";
import { num, relative } from "../../../lib/format";
import { policyLimits, requiresApproval } from "@seo/core";
import { FixActions } from "./actions";
import { sessionCan } from "../../../lib/auth";

export const dynamic = "force-dynamic";

type Change = { url: string; field: string; before: string | null; after: string; selector?: string };

export default async function FixesPage({
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
        <TopBar t={t} locale={locale} pathname={pathname} title={t("fixes")} />
        <div className="view">
          <Card title={t("fixes")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const [fixes, canApply] = await Promise.all([
    listFixes(project.id, ["DRAFT", "APPROVED", "APPLYING", "APPLIED", "FAILED", "ROLLED_BACK"]),
    sessionCan("fix:apply_low_risk"),
  ]);
  const limits = policyLimits();

  return (
    <>
      <TopBar t={t} locale={locale} pathname={pathname} title={t("fixes")} />
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
              const hasDryRun = Boolean(fix.dryRun);
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
                      {t("pages")} · <span className="path">{fix.ruleId}</span>
                    </div>

                    {fixWhy(fix.action, fix.rationale, locale) && (
                      <p style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 12 }}>
                        {fixWhy(fix.action, fix.rationale, locale)}
                      </p>
                    )}

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

                    <div style={{ marginTop: 14 }}>
                      <FixActions
                        id={fix.id}
                        status={fix.status}
                        needsApproval={needsApproval}
                        approved={fix.decision === "APPROVED"}
                        hasDryRun={hasDryRun}
                        canApply={canApply}
                        labels={{
                          dryRun: t("dry_run"),
                          apply: t("apply"),
                          rollback: t("rollback"),
                          waiting: t("st_awaiting_approval"),
                          forbidden: t("err_forbidden"),
                        }}
                      />
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
