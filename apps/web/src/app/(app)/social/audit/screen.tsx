"use client";

/**
 * The profile audit: score, findings by severity with why each matters, and
 * what to do about it — a ready-to-paste text where the platform's API cannot
 * make the change (Instagram's profile, a Telegram username), or the fix
 * proposal waiting in Fixes / Approvals where it can (a Telegram channel's
 * title and description).
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "../../../../components/icons";
import { UserText } from "../../../../components/ui";
import { ScoreGauge } from "../../../../components/charts";
import { CopyButton, ErrorNote, Flash, Loading, useAction, useLoad } from "../../../../components/kit";
import { fmt } from "../../../../lib/dict";
import { dateTime, num, relative } from "../../../../lib/format";
import { localized } from "../../../../lib/seo-labels";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { SocialStrings } from "../strings";
import type { AuditResult, Finding } from "../api-types";
import { ServerText, SevPill, maybe, pk, type SocialCtx, type SocialStatus } from "../parts";

type Filter = "all" | "manual" | "approval";
const ORDER = ["CRITICAL", "SERIOUS", "WARNING", "INFO"];

export function SocialAuditScreen({ ctx, s, c }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings }) {
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social`;
  const status = useLoad<SocialStatus>(base, ctx.locale);
  const audit = useLoad<AuditResult>(`${base}/audit`, ctx.locale);
  const action = useAction(ctx.locale);
  const [filter, setFilter] = useState<Filter>("all");
  const [done, setDone] = useState<string | null>(null);
  const L = ctx.locale;
  const connected = status.data ? status.data.account.status !== "NOT_CONNECTED" : null;
  const canChangeInfo = Boolean(status.data?.account.profile.rights?.can_change_info);

  const open = useMemo(
    () => (audit.data?.findings ?? []).filter((f) => f.status === "OPEN").sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity)),
    [audit.data],
  );
  const shown = open.filter((f) => (filter === "manual" ? f.manual : filter === "approval" ? !f.manual && Boolean(f.proposal) : true));
  const failing = new Set(open.map((f) => f.ruleId));

  async function run() {
    setDone(null);
    const r = await action.run<AuditResult>(`${base}/audit`);
    if (!r) return;
    audit.setData(r);
    setDone(fmt(s.audit_done, { score: num(r.score, L), n: num(r.findings.filter((f) => f.status === "OPEN").length, L) }));
  }

  if ((audit.error && !audit.data) || (status.error && !status.data))
    return <ErrorNote message={(audit.error ?? status.error)!} onRetry={() => void Promise.all([audit.reload(), status.reload()])} c={c} />;
  if (!audit.data || !status.data) return <Loading label={c.loading} rows={6} />;
  const data = audit.data;

  return (
    <>
      <p className="desc" style={{ maxWidth: 780 }}>
        {pk(s, "au_intro", ctx.platform)}
      </p>
      {!connected && (
        <div className="nc">
          <span className="mico">
            <Icon name="plug" />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <b>{pk(s, "not_connected_title", ctx.platform)}</b>
            <p className="desc">{s.not_connected_body}</p>
            <Link className="btn primary sm" href={ctx.links.overview} style={{ marginTop: 10 }}>
              <Icon name="plug" />
              {s.go_connect}
            </Link>
          </div>
        </div>
      )}
      {done && <Flash tone="ok">{done}</Flash>}
      {action.error && <Flash tone="crit">{action.error}</Flash>}

      <section className="card">
        <div className="body">
          <div className="gauge-wrap">
            {data.score !== null ? <ScoreGauge score={data.score} label={s.score} locale={L} /> : null}
            <div className="stack-sm" style={{ flex: "1 1 260px", minWidth: 0 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div className="muted small">{s.au_last}</div>
                  <b>{data.run?.finishedAt ? <span title={dateTime(data.run.finishedAt, L)}>{relative(data.run.finishedAt, L)}</span> : s.never}</b>
                </div>
                {ctx.can.write && connected && (
                  <button type="button" className="btn primary sm" onClick={() => void run()} disabled={action.busy}>
                    {action.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="pulse" />}
                    {action.busy ? s.auditing : s.run_audit}
                  </button>
                )}
              </div>
              <div className="row" style={{ gap: 12 }}>
                {ORDER.map((sev) => (
                  <span key={sev} className="row" style={{ gap: 6 }}>
                    <SevPill severity={sev} s={s} />
                    <b className="num">{num(open.filter((f) => f.severity === sev).length, L)}</b>
                  </span>
                ))}
              </div>
              <p className="hint">{s.score_help}</p>
              {data.run && !data.hasData && <p className="hint">{s.au_no_data}</p>}
            </div>
          </div>
        </div>
      </section>

      {!data.run ? (
        <section className="card">
          <div className="body">
            <div className="empty">
              <Icon name="pulse" />
              <div>{s.au_no_run}</div>
            </div>
          </div>
        </section>
      ) : (
        <>
          <div className="seg" role="group" aria-label={s.au_filter}>
            {(["all", "manual", "approval"] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? s.au_all : f === "manual" ? s.au_manual : s.au_approval}{" "}
                <span className="tag">{num(open.filter((x) => (f === "manual" ? x.manual : f === "approval" ? !x.manual && x.proposal : true)).length, L)}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <section className="card">
              <div className="body">
                <div className="empty">
                  <Icon name="check" />
                  <div>{open.length === 0 ? s.au_none : s.au_none_filter}</div>
                </div>
              </div>
            </section>
          ) : (
            <div className="stack-sm">
              {shown.map((f) => (
                <FindingCard key={f.issueId} f={f} ctx={ctx} s={s} c={c} canChangeInfo={canChangeInfo} />
              ))}
            </div>
          )}
        </>
      )}

      <details className="card rules-ref">
        <summary>
          <h3>{s.rules_title}</h3>
          <span className="sub">{fmt(s.rules_n, { n: num(data.rules.length, L) })}</span>
        </summary>
        <div className="body">
          <p className="hint">{s.rules_help}</p>
          <ul className="rule-list">
            {data.rules.map((r) => (
              <li key={r.id}>
                <span className={`pill ${failing.has(r.id) ? "warn" : data.run ? "ok" : "mute"}`}>
                  <Icon name={failing.has(r.id) ? "alert" : "check"} />
                  {failing.has(r.id) ? s.rule_fail : s.rule_pass}
                </span>
                <div style={{ minWidth: 0 }}>
                  <b>{localized(r.title, L)}</b> <span className="muted small">· {maybe(s, `cat_${r.category}`) ?? r.category}</span>
                  <p className="hint">{localized(r.why, L)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </>
  );
}

function FindingCard({ f, ctx, s, c, canChangeInfo }: { f: Finding; ctx: SocialCtx; s: SocialStrings; c: CommonStrings; canChangeInfo: boolean }) {
  const L = ctx.locale;
  const field = f.suggestion?.field ?? null;
  const viaApproval = !f.manual && ctx.platform === "TELEGRAM" && (field === "title" || field === "description");
  const proposal = f.proposal;
  return (
    <article className="card finding">
      <header>
        <SevPill severity={f.severity} s={s} />
        <h3>{localized(f.title, L)}</h3>
        <span className="spacer" />
        {f.manual ? (
          <span className="pill mute">
            <Icon name="user" />
            {s.manual_badge}
          </span>
        ) : viaApproval ? (
          <span className="pill info">
            <Icon name="shield" />
            {s.approval_badge}
          </span>
        ) : null}
      </header>
      <div className="body stack-sm">
        {f.detail && (
          <p>
            <ServerText pair={f.detail} locale={L} s={s} />
          </p>
        )}
        {f.suggestion?.value && (
          <div className="suggest">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="muted small">
                {s.suggestion}
                {field ? ` · ${maybe(s, `sf_${field}`) ?? field}` : ""}
              </span>
              <CopyButton text={f.suggestion.value} c={c} />
            </div>
            <div className="suggest-text">
              {/* Publishing hours are the panel's own figures, not the owner's text: they take the reader's digits. */}
              {field === "posting" ? localized({ fa: f.suggestion.value, en: f.suggestion.value }, L) : <UserText>{f.suggestion.value}</UserText>}
            </div>
          </div>
        )}
        {f.manual && <p className="hint">{pk(s, "manual", ctx.platform)}</p>}
        {viaApproval &&
          (proposal ? (
            <div className="row">
              <span className="small">{maybe(s, `prop_${proposal.status}`) ?? proposal.status}</span>
              <Link className="btn ghost sm" href={proposal.status === "AWAITING_APPROVAL" ? ctx.links.approvals : ctx.links.fixes}>
                <Icon name={proposal.status === "AWAITING_APPROVAL" ? "shield" : "wand"} />
                {proposal.status === "AWAITING_APPROVAL" ? s.to_approvals : s.to_fixes}
              </Link>
            </div>
          ) : (
            !canChangeInfo && <p className="hint">{s.no_change_right}</p>
          ))}
        {f.why && (
          <details className="why">
            <summary>{s.why}</summary>
            <p className="hint">{localized(f.why, L)}</p>
          </details>
        )}
        <p className="muted small">{fmt(s.seen_since, { when: relative(f.firstSeenAt, L) })}</p>
      </div>
    </article>
  );
}
