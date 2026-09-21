import { TopBar } from "../../../components/shell";
import { actionLabel, fixTitle, fixWhy } from "../../../lib/labels";
import { Card, Diff, Empty, Note, RiskPill } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import { defaultProject, getProject, listApprovalQueue } from "../../../lib/queries";
import { num, relative } from "../../../lib/format";
import { ALWAYS_APPROVAL } from "@seo/core";
import { DecideButtons } from "./decide";
import { sessionCan } from "../../../lib/auth";

export const dynamic = "force-dynamic";

type Change = { url: string; field: string; before: string | null; after: string };

export default async function ApprovalsPage({
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
        <TopBar t={t} locale={locale} pathname={pathname} title={t("approvals")} />
        <div className="view">
          <Card title={t("approvals")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const [queue, canDecide] = await Promise.all([
    listApprovalQueue(project.id),
    sessionCan("fix:approve_sensitive"),
  ]);

  return (
    <>
      <TopBar t={t} locale={locale} pathname={pathname} title={t("approvals")} />
      <div className="view">
        <Note tone="lock" icon="lock">
          {t("appr_lock")}
        </Note>

        {!canDecide && (
          <Note icon="info">
            {t("err_forbidden")} — {t("your_role")}: {session.role}
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
                        {fixWhy(proposal.action, proposal.rationale, locale) ?? issue?.title}
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
                        {approval?.requestedBy === "agent" || approval?.requestedBy === "AGENT"
                          ? t("agent")
                          : (approval?.requestedBy ?? t("agent"))}
                      </span>
                      <span className="spacer" />
                      <DecideButtons
                        id={proposal.id}
                        disabled={!canDecide}
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
