import { TopBar } from "../../../components/shell";
import { actionLabel, fixTitle, fixWhy, roleLabel } from "../../../lib/labels";
import { anyRuleTitle } from "../../../lib/social-labels";
import { Card, Diff, Empty, Note, RiskPill, UserText } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import { listApprovalQueue } from "../../../lib/queries";
import { usersByIds } from "../../../lib/views";
import { num, relative } from "../../../lib/format";
import { ALWAYS_APPROVAL, can } from "@seo/core";
import { DecideButtons } from "./decide";

export const dynamic = "force-dynamic";

type Change = { url: string; field: string; before: string | null; after: string };

export default async function ApprovalsPage() {
  const { t, locale, session, project } = await pageContext();

  if (!project) {
    return (
      <>
        <TopBar title={t("approvals")} />
        <div className="view">
          <Card title={t("approvals")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const queue = await listApprovalQueue(project.id);
  const canDecide = can(session.role, "fix:approve_sensitive");
  const requesters = await usersByIds(queue.map((q) => q.approval?.requestedBy));

  return (
    <>
      <TopBar title={t("approvals")} />
      <div className="view">
        <Note tone="lock" icon="lock">
          {t("appr_lock")}
        </Note>

        {!canDecide && (
          <Note icon="info">
            {t("err_forbidden")} — {t("your_role")}: {roleLabel(session.role, locale)}
          </Note>
        )}

        {queue.length === 0 ? (
          <Card title={t("approvals")}>
            <Empty icon="check">{t("no_approvals")}</Empty>
          </Card>
        ) : (
          <div className="grid g2">
            {queue.map(({ proposal, approval, issue }) => {
              const changes = (proposal.changes as Change[]) ?? [];
              const sample = changes[0];
              const never = ALWAYS_APPROVAL.includes(proposal.action);
              return (
                <section className="card" key={proposal.id}>
                  <header>
                    <span className={`pill ${never ? "crit" : "warn"}`}>
                      <Icon name="lock" />
                      {actionLabel(proposal.action, locale)}
                    </span>
                    <RiskPill risk={proposal.risk} t={t} />
                    <span className="spacer" />
                    <span className="pill mute">
                      <Icon name="clock" />
                      {t("waiting")} {relative(approval?.createdAt ?? proposal.createdAt, locale)}
                    </span>
                  </header>
                  <div className="body">
                    <h3 style={{ fontSize: 14.5, marginBottom: 6 }}>
                      {fixTitle(proposal.action, proposal.title, locale)}
                    </h3>
                    {(fixWhy(proposal.action, proposal.rationale, locale) || issue?.title) && (
                      <p style={{ color: "var(--ink-2)", fontSize: 12.5, marginBottom: 12 }}>
                        <span style={{ color: "var(--ink-3)" }}>{t("why")}: </span>
                        {fixWhy(proposal.action, proposal.rationale, locale) ??
                          (issue ? anyRuleTitle(issue.ruleId, issue.title, locale) : null)}
                      </p>
                    )}

                    {sample && <Diff before={sample.before} after={sample.after} />}
                    <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                      {t("target")}: {num(proposal.targetCount, locale)} {t("pages")}
                      {changes.length > 1 && ` · +${num(changes.length - 1, locale)}`}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 14,
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {t("requested_by")}:{" "}
                        {(() => {
                          const by = approval?.requestedBy;
                          const person = by ? requesters.get(by) : undefined;
                          if (person) return <UserText>{person.name ?? person.email}</UserText>;
                          return t("agent");
                        })()}
                      </span>
                      <span className="spacer" />
                      <DecideButtons
                        id={proposal.id}
                        disabled={!canDecide}
                        locale={locale}
                        labels={{ approve: t("approve"), reject: t("reject"), forbidden: t("err_forbidden") }}
                      />
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
