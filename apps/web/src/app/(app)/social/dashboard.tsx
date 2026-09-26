"use client";

/**
 * The dashboard of an Instagram page or Telegram channel: identity and
 * connection, score, the 28-day metrics, the top findings, and what is about
 * to be published or waits for approval.
 */
import Link from "next/link";
import { Icon } from "../../../components/icons";
import { ErrorNote, Loading, useLoad } from "../../../components/kit";
import { fmt } from "../../../lib/dict";
import { num } from "../../../lib/format";
import { localized } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { SocialStrings } from "./strings";
import type { Analytics, AuditResult, PlannedPost } from "./api-types";
import { KeyMetrics, ScoreCard } from "./overview";
import { DEFAULT_TZ, ProfileHeader, SevPill, pk, type SocialCtx, type SocialStatus } from "./parts";
import { StatusPill, summary } from "./planner/screen";
import { whenIn } from "./planner/time";

const ORDER = ["CRITICAL", "SERIOUS", "WARNING", "INFO"];

export function SocialDashboard({ ctx, s, c }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings }) {
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social`;
  const status = useLoad<SocialStatus>(base, ctx.locale);
  const connected = status.data ? status.data.account.status !== "NOT_CONNECTED" : false;
  const audit = useLoad<AuditResult>(connected ? `${base}/audit` : null, ctx.locale);
  const analytics = useLoad<Analytics>(connected ? `${base}/analytics` : null, ctx.locale);
  const planned = useLoad<{ posts: PlannedPost[] }>(`${base}/planner?status=awaiting_approval,scheduled,publishing,failed`, ctx.locale);
  const L = ctx.locale;

  if (status.error && !status.data) return <ErrorNote message={status.error} onRetry={() => void status.reload()} c={c} />;
  if (!status.data) return <Loading label={c.loading} rows={6} />;
  const account = status.data.account;
  const tz = account.settings.timezone ?? DEFAULT_TZ;

  if (!connected) {
    return (
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
    );
  }

  const top = (audit.data?.findings ?? [])
    .filter((f) => f.status === "OPEN")
    .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
    .slice(0, 4);
  const posts = planned.data?.posts ?? [];
  const awaiting = posts.filter((p) => p.status === "awaiting_approval").length;
  const upcoming = posts
    .filter((p) => p.status !== "awaiting_approval")
    .sort((a, b) => (a.publishAt ?? "").localeCompare(b.publishAt ?? ""))
    .slice(0, 5);

  return (
    <>
      <section className="card">
        <div className="body">
          <ProfileHeader account={account} s={s} locale={L}>
            <Link className="btn ghost sm" href={ctx.links.overview}>
              <Icon name="user" />
              {s.ob_open}
            </Link>
          </ProfileHeader>
        </div>
      </section>
      <KeyMetrics ctx={ctx} s={s} c={c} analytics={analytics} />
      <div className="split">
        <ScoreCard ctx={ctx} s={s} c={c} audit={audit} compact />
        <section className="card">
          <header>
            <h3>{s.db_top_findings}</h3>
            <span className="spacer" />
            <Link className="btn ghost sm" href={ctx.links.audit}>
              {s.db_open_audit}
            </Link>
          </header>
          <div className="body">
            {!audit.data ? (
              <Loading label={c.loading} rows={3} />
            ) : top.length === 0 ? (
              <p className="muted">{audit.data.run ? s.au_none : s.no_audit}</p>
            ) : (
              <ul className="plain stack-sm">
                {top.map((f) => (
                  <li key={f.issueId} className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
                    <SevPill severity={f.severity} s={s} />
                    <span>{localized(f.title, L)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
      <section className="card">
        <header>
          <h3>{s.db_upcoming}</h3>
          <span className="spacer" />
          <Link className="btn ghost sm" href={ctx.links.planner}>
            <Icon name="calendar" />
            {s.db_open_planner}
          </Link>
        </header>
        <div className="body stack-sm">
          {awaiting > 0 && (
            <div className="note lock">
              <Icon name="lock" />
              <div>{fmt(s.db_awaiting, { n: num(awaiting, L) })}</div>
            </div>
          )}
          {!planned.data ? (
            <Loading label={c.loading} rows={2} />
          ) : upcoming.length === 0 ? (
            <p className="muted">{s.db_upcoming_none}</p>
          ) : (
            <ul className="plain stack-sm">
              {upcoming.map((p) => (
                <li key={p.id} className="row" style={{ gap: 8 }}>
                  <StatusPill status={p.status} s={s} />
                  <span className="muted small">{p.publishAt ? whenIn(p.publishAt, tz, L) : s.publish_asap}</span>
                  <span className="clamp1" dir="auto" translate="no">
                    {summary(p, s, L)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
