"use client";

/**
 * Onboarding for an Instagram page or Telegram channel: connect it, wait for
 * the first sync (which also runs the audit), then point at the findings.
 * The steps come from real state — reload at any point and it resumes.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../../../components/icons";
import { Flash, Loading, ErrorNote, useLoad } from "../../../components/kit";
import type { CommonStrings } from "../../../lib/common-strings";
import type { SocialStrings } from "./strings";
import type { AuditResult } from "./api-types";
import { ConnectPanel } from "./connect";
import { ScoreCard } from "./overview";
import { ProfileHeader, reasonOf, useSync, type Account, type SocialCtx, type SocialStatus } from "./parts";

export function SocialOnboarding({ ctx, s, c, redirectUri }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings; redirectUri: string | null }) {
  const router = useRouter();
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social`;
  const status = useLoad<SocialStatus>(base, ctx.locale);
  const account = status.data?.account ?? null;
  const synced = Boolean(account?.lastSyncAt);
  const audit = useLoad<AuditResult>(synced ? `${base}/audit` : null, ctx.locale);
  const [error, setError] = useState<string | null>(null);

  const sync = useSync(ctx, s, (next, err) => {
    if (next) status.setData(next);
    setError(err);
    // The steps above are rendered on the server from the same state.
    router.refresh();
  });

  function connected(next: Account) {
    status.setData((p) => (p ? { ...p, account: next } : p));
    router.refresh();
    void sync.watch(next.lastSyncAt);
  }

  if (status.error && !status.data) return <ErrorNote message={status.error} onRetry={() => void status.reload()} c={c} />;
  if (!status.data || !account) return <Loading label={c.loading} rows={5} />;

  if (account.status === "NOT_CONNECTED") {
    return <ConnectPanel ctx={ctx} s={s} c={c} status={status.data} redirectUri={redirectUri} onConnected={connected} />;
  }

  if (!synced || sync.state !== "idle") {
    return (
      <section className="card">
        <header>
          <h3>{s.fs_title}</h3>
        </header>
        <div className="body stack-sm">
          <ProfileHeader account={account} s={s} locale={ctx.locale} />
          {sync.state === "queued" ? (
            <div className="jobline active" role="status" aria-live="polite">
              <span className="spin" aria-hidden="true" />
              <span>{s.fs_running}</span>
            </div>
          ) : sync.state === "slow" ? (
            <Flash tone="info">{s.sync_slow}</Flash>
          ) : (
            ctx.can.write && (
              <div>
                <button type="button" className="btn primary" onClick={() => void sync.start(account.lastSyncAt)}>
                  <Icon name="refresh" />
                  {s.sync_now}
                </button>
              </div>
            )
          )}
          {(error || sync.error) && <Flash tone="crit">{sync.error ?? `${s.fs_failed} ${error}`}</Flash>}
          {account.status === "ERROR" && <Flash tone="crit">{reasonOf(ctx, s, account.lastError)}</Flash>}
        </div>
      </section>
    );
  }

  return (
    <>
      <Flash tone="ok">{s.ob_done}</Flash>
      <div className="split">
        <section className="card">
          <div className="body stack-sm">
            <ProfileHeader account={account} s={s} locale={ctx.locale} />
            <div className="row">
              <Link className="btn primary" href={ctx.links.audit}>
                <Icon name="pulse" />
                {s.view_findings}
              </Link>
              <Link className="btn ghost" href={ctx.links.overview}>
                <Icon name="user" />
                {s.ob_open}
              </Link>
              <Link className="btn ghost" href={ctx.links.planner}>
                <Icon name="calendar" />
                {s.step_planner}
              </Link>
            </div>
          </div>
        </section>
        <ScoreCard ctx={ctx} s={s} c={c} audit={audit} compact />
      </div>
    </>
  );
}
