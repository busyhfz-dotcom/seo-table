import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { Card, Empty, Note, RiskPill, Table, UserText } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import { getOrg, listAuditLog, orgMembers } from "../../../lib/queries";
import { dateTime, num, relative } from "../../../lib/format";
import { actionLabel, roleLabel, targetTypeLabel } from "../../../lib/labels";
import { describeAction } from "../../../lib/activity";
import { usersByIds } from "../../../lib/views";
import { describePolicy, permissionMatrix, can, type Permission } from "@seo/core";
import { ApiKeys } from "./api-keys";
import { Integrations } from "./integrations";
import { INTEGRATIONS } from "./integrations-strings";
import { COMMON } from "../../../lib/common-strings";

export const dynamic = "force-dynamic";

type Tab = "general" | "team" | "safety" | "keys" | "integrations" | "log";

const SHOWN_PERMISSIONS: Permission[] = [
  "project:read",
  "scan:run",
  "fix:apply_low_risk",
  "fix:approve_sensitive",
  "connector:write",
  "member:manage",
  "billing:manage",
];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const { t, locale, session, project } = await pageContext();
  const tab: Tab = (["general", "team", "safety", "keys", "integrations", "log"] as const).includes(params.tab as Tab)
    ? (params.tab as Tab)
    : "general";

  const org = await getOrg(session.orgId);
  const policy = describePolicy();

  return (
    <>
      <TopBar title={t("settings")} />
      <div className="view">
        <div className="seg scroll" role="group" style={{ alignSelf: "flex-start" }}>
          {(
            [
              ["general", t("s_general")],
              ["team", t("s_team")],
              ["safety", t("s_safety")],
              ["keys", t("s_keys")],
              ["integrations", t("s_integrations")],
              ["log", t("s_log")],
            ] as const
          ).map(([key, label]) => (
            <Link key={key} href={`/settings?tab=${key}`} aria-current={tab === key}>
              {label}
            </Link>
          ))}
        </div>

        {tab === "integrations" &&
          (can(session.role, "integration:manage") ? (
            <Integrations s={INTEGRATIONS[locale]} c={COMMON[locale]} locale={locale} />
          ) : (
            <Note tone="lock" icon="lock">
              {INTEGRATIONS[locale].owner_only}
            </Note>
          ))}

        {tab === "general" && (
          <Card title={t("s_general")}>
            <dl className="kv">
              <dt>{locale === "fa" ? "سازمان" : "Organization"}</dt>
              <dd>{org?.name ? <UserText>{org.name}</UserText> : "—"}</dd>
              <dt>{locale === "fa" ? "کاربر" : "Signed in as"}</dt>
              <dd className="path" dir="ltr">
                {session.email}
              </dd>
              <dt>{t("your_role")}</dt>
              <dd>
                <span className="pill acc">{roleLabel(session.role, locale)}</span>
              </dd>
              <dt>{locale === "fa" ? "پروژه" : "Project"}</dt>
              <dd>
                {project ? (
                  <>
                    <UserText>{project.name}</UserText> ·{" "}
                    <span className="path" dir="ltr">
                      {project.baseUrl}
                    </span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
              <dt>{locale === "fa" ? "زبان رابط" : "Interface language"}</dt>
              <dd>{locale === "fa" ? "فارسی (راست‌به‌چپ)" : "English (left to right)"}</dd>
              {project && (
                <>
                  <dt>{t("page_cap")}</dt>
                  <dd className="num">{num(project.pageCap, locale)}</dd>
                  <dt>{t("crawl_rate")}</dt>
                  <dd className="num">{num(project.crawlRate, locale)}</dd>
                </>
              )}
            </dl>
          </Card>
        )}

        {tab === "team" && (
          <>
            <Card title={t("s_team")} sub={locale === "fa" ? "در سطح سرور اعمال می‌شود" : "Enforced server-side"} bare>
              <Table
                head={[
                  { label: t("role") },
                  ...SHOWN_PERMISSIONS.map((p) => ({ label: permissionLabel(p, locale), numeric: true })),
                ]}
              >
                {permissionMatrix().map((row) => (
                  <tr key={row.role}>
                    <td>
                      <span className={`pill ${row.role === "OWNER" ? "acc" : "mute"}`}>
                        {roleLabel(row.role, locale)}
                      </span>
                    </td>
                    {SHOWN_PERMISSIONS.map((p) => (
                      <td key={p} style={{ textAlign: "end" }}>
                        {can(row.role, p) ? (
                          <span className="pill ok">
                            <Icon name="check" />
                          </span>
                        ) : (
                          <span className="pill mute">
                            <Icon name="x" />
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </Table>
            </Card>

            <Card title={locale === "fa" ? "اعضا" : "Members"} bare>
              <Table
                head={[
                  { label: t("email") },
                  { label: locale === "fa" ? "نام" : "Name" },
                  { label: t("role") },
                ]}
              >
                {(await orgMembers(session.orgId)).map((m) => (
                  <tr key={m.id}>
                    <td className="path" dir="ltr">
                      {m.email}
                    </td>
                    <td>{m.name ? <UserText>{m.name}</UserText> : "—"}</td>
                    <td>
                      <span className={`pill ${m.role === "OWNER" ? "acc" : "mute"}`}>{roleLabel(m.role, locale)}</span>
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}

        {tab === "safety" && (
          <>
            <Note tone="lock" icon="lock">
              {t("appr_lock")}
            </Note>

            <Card title={t("s_safety")}>
              <dl className="kv">
                <dt>{locale === "fa" ? "حداکثر تغییر در هر اجرا" : "Max changes per execution"}</dt>
                <dd className="num">{num(policy.limits.maxChangesPerExecution, locale)}</dd>
                <dt>{locale === "fa" ? "اجرای آزمایشی اجباری" : "Dry run required first"}</dt>
                <dd>{policy.limits.requireDryRunFirst ? yes(locale) : no(locale)}</dd>
                <dt>{locale === "fa" ? "نسخه‌ی پشتیبان پیش از نوشتن" : "Snapshot before writing"}</dt>
                <dd>{policy.limits.requireSnapshot ? yes(locale) : no(locale)}</dd>
                <dt>{locale === "fa" ? "بازگردانی" : "Rollback"}</dt>
                <dd>{policy.limits.allowRollback ? yes(locale) : no(locale)}</dd>
              </dl>
            </Card>

            <Card title={locale === "fa" ? "سطوح ریسک" : "Risk tiers"} bare>
              <Table
                head={[
                  { label: t("risk") },
                  { label: locale === "fa" ? "اقدام‌ها" : "Actions" },
                  { label: locale === "fa" ? "اجرای خودکار" : "Automatic" },
                ]}
              >
                {policy.tiers.map((tier) => (
                  <tr key={tier.risk}>
                    <td>
                      <RiskPill risk={tier.risk} t={t} />
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {tier.actions.map((a) => (
                          <span key={a} className="pill mute">
                            {actionLabel(a, locale)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {tier.autoApply ? (
                        <span className="pill ok">
                          <Icon name="check" />
                          {locale === "fa" ? "عامل می‌تواند" : "Agent may"}
                        </span>
                      ) : (
                        <span className="pill crit">
                          <Icon name="lock" />
                          {locale === "fa" ? "فقط با تأیید انسان" : "Human approval only"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>

            <Card title={locale === "fa" ? "هرگز بدون تأیید" : "Never without approval"}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {policy.neverWithoutApproval.map((a) => (
                  <span key={a} className="pill crit">
                    <Icon name="lock" />
                    {actionLabel(a, locale)}
                  </span>
                ))}
              </div>
              <p style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 12, lineHeight: 1.8 }}>
                {locale === "fa"
                  ? "این سه اقدام در سه لایه‌ی مستقل مسدود شده‌اند: سیاست در کد، بررسی در مسیر API، و یک تریگر در پایگاه داده که انتقال به وضعیت اعمال‌شده را بدون رکورد تأیید رد می‌کند."
                  : "These three are blocked in three independent layers: the policy in code, the check in the API route, and a database trigger that refuses the transition to an applied state without an approval row."}
              </p>
            </Card>
          </>
        )}

        {tab === "keys" &&
          (can(session.role, "apikey:manage") ? (
            <ApiKeys
              locale={locale}
              labels={{
                title: t("s_keys"),
                create: t("key_new"),
                name: t("key_name"),
                key: t("key_value"),
                created: t("key_created"),
                lastUsed: t("key_last_used"),
                never: t("key_never"),
                once: t("key_once"),
                revoke: t("key_revoke"),
                revoked: t("key_revoked"),
                confirm: t("key_confirm"),
                cancel: t("cancel"),
                empty: t("nothing_here"),
                note: t("key_note", { role: roleLabel("EDITOR", locale) }),
              }}
            />
          ) : (
            <Note icon="lock">
              {t("err_forbidden")} — {t("your_role")}: {roleLabel(session.role, locale)}
            </Note>
          ))}

        {tab === "log" &&
          (can(session.role, "auditlog:read") ? (
            <Card
              title={t("s_log")}
              sub={locale === "fa" ? "تغییرناپذیر — فقط افزودنی" : "Immutable — append only"}
              bare
            >
              {await (async () => {
                const entries = await listAuditLog(session.orgId, 100);
                if (entries.length === 0) return <Empty>{t("nothing_here")}</Empty>;
                const people = await usersByIds(entries.map((e) => e.actorId));
                return (
                  <Table
                    head={[{ label: t("time") }, { label: t("actor") }, { label: t("event") }, { label: t("target") }]}
                  >
                    {entries.map((e) => {
                      const person = e.actorId ? people.get(e.actorId) : undefined;
                      return (
                        <tr key={e.id}>
                          <td style={{ whiteSpace: "nowrap" }} title={dateTime(e.createdAt, locale)}>
                            {relative(e.createdAt, locale)}
                          </td>
                          <td>
                            {e.actorType === "AGENT" ? (
                              <span className="pill acc">
                                <Icon name="wand" />
                                {t("agent")}
                              </span>
                            ) : person ? (
                              <span className="path" dir="ltr">
                                {person.name ?? person.email}
                              </span>
                            ) : (
                              <span>
                                {t(
                                  e.actorType === "API_KEY"
                                    ? "api_key"
                                    : e.actorType === "USER"
                                      ? "actor_user"
                                      : "actor_system",
                                )}
                                {e.actorId && (
                                  <span className="path" dir="ltr" style={{ marginInlineStart: 6 }}>
                                    {e.actorId.slice(-6)}
                                  </span>
                                )}
                              </span>
                            )}
                            {e.actorType === "API_KEY" && person && (
                              <span className="pill mute" style={{ marginInlineStart: 6 }}>
                                <Icon name="key" />
                                {t("api_key")}
                              </span>
                            )}
                          </td>
                          <td>{describeAction(e.action, e.actorType, e.metadata, locale)}</td>
                          <td style={{ color: "var(--ink-3)", fontSize: 12 }}>{targetTypeLabel(e.targetType, locale)}</td>
                        </tr>
                      );
                    })}
                  </Table>
                );
              })()}
            </Card>
          ) : (
            <Note icon="lock">
              {t("err_forbidden")} — {t("your_role")}: {roleLabel(session.role, locale)}
            </Note>
          ))}
      </div>
    </>
  );
}

function yes(locale: "fa" | "en") {
  return <span className="pill ok">{locale === "fa" ? "بله" : "Yes"}</span>;
}
function no(locale: "fa" | "en") {
  return <span className="pill mute">{locale === "fa" ? "خیر" : "No"}</span>;
}

function permissionLabel(p: Permission, locale: "fa" | "en"): string {
  const map: Record<string, { fa: string; en: string }> = {
    "project:read": { fa: "مشاهده", en: "View" },
    "scan:run": { fa: "اجرای اسکن", en: "Run scans" },
    "fix:apply_low_risk": { fa: "اصلاح کم‌ریسک", en: "Low-risk fixes" },
    "fix:approve_sensitive": { fa: "تأیید حساس", en: "Approve sensitive" },
    "connector:write": { fa: "اتصال‌ها", en: "Connectors" },
    "member:manage": { fa: "مدیریت اعضا", en: "Members" },
    "billing:manage": { fa: "مالی", en: "Billing" },
  };
  return locale === "fa" ? (map[p]?.fa ?? p) : (map[p]?.en ?? p);
}
