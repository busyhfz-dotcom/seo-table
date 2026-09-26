"use client";

/**
 * The profile's overview: connect it when it is not connected; otherwise its
 * identity and connection (sync, check, disconnect), the audit score, the key
 * metrics of the last 28 days with their sources, what the connection can and
 * cannot do, and the targeting the audit judges against.
 */
import Link from "next/link";
import { useCallback, useState } from "react";
import { Icon } from "../../../components/icons";
import { Rich, UserText } from "../../../components/ui";
import { ScoreGauge } from "../../../components/charts";
import { ConfirmButton, ErrorNote, Flash, Loading, useAction, useLoad, type Loaded } from "../../../components/kit";
import { fmt } from "../../../lib/dict";
import { dateTime, decimal, num, relative } from "../../../lib/format";
import type { CommonStrings } from "../../../lib/common-strings";
import type { SocialStrings } from "./strings";
import type { Analytics, AuditResult } from "./api-types";
import { ConnectPanel } from "./connect";
import {
  ProfileHeader,
  SevPill,
  SourcePill,
  TIMEZONES,
  maybe,
  percent,
  pk,
  reasonOf,
  signed,
  tzLabel,
  useSync,
  type Account,
  type SocialCtx,
  type SocialStatus,
} from "./parts";

export function SocialOverview({
  ctx,
  s,
  c,
  flash,
  redirectUri,
}: {
  ctx: SocialCtx;
  s: SocialStrings;
  c: CommonStrings;
  flash: { tone: "ok" | "crit"; text: string } | null;
  redirectUri: string | null;
}) {
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social`;
  const status = useLoad<SocialStatus>(base, ctx.locale);
  const account = status.data?.account ?? null;
  const connected = account ? account.status !== "NOT_CONNECTED" : false;
  const audit = useLoad<AuditResult>(connected ? `${base}/audit` : null, ctx.locale);
  const analytics = useLoad<Analytics>(connected ? `${base}/analytics` : null, ctx.locale);
  const [note, setNote] = useState<{ tone: "ok" | "crit" | "info"; text: string } | null>(flash);
  const [firstSync, setFirstSync] = useState<"running" | "done" | "failed" | null>(null);

  const refreshAll = useCallback(async () => {
    await Promise.all([status.reload(), audit.reload(), analytics.reload()]);
  }, [status, audit, analytics]);

  const sync = useSync(ctx, s, (next, error) => {
    if (next) status.setData(next);
    void audit.reload();
    void analytics.reload();
    if (firstSync) setFirstSync(error ? "failed" : "done");
    setNote(error ? { tone: "crit", text: `${s.sync_failed} ${error}` } : firstSync ? null : { tone: "ok", text: s.sync_done });
  });

  function connectedNow(next: Account) {
    status.setData((prev) => (prev ? { ...prev, account: next } : prev));
    setNote({ tone: "ok", text: s.tg_connected });
    setFirstSync("running");
    void sync.watch(next.lastSyncAt);
  }

  if (status.error && !status.data) return <ErrorNote message={status.error} onRetry={() => void status.reload()} c={c} />;
  if (!status.data || !account) return <Loading label={c.loading} rows={6} />;

  return (
    <>
      <p className="desc" style={{ maxWidth: 780 }}>
        {pk(s, "ov_intro", ctx.platform)}
      </p>
      {note && <Flash tone={note.tone}>{note.text}</Flash>}
      {sync.error && <Flash tone="crit">{sync.error}</Flash>}
      {sync.state === "slow" && <Flash tone="info">{s.sync_slow}</Flash>}

      {firstSync && <FirstSync state={firstSync} ctx={ctx} s={s} lastError={account.lastError} />}

      {!connected ? (
        <>
          <div className="nc">
            <span className="mico">
              <Icon name="plug" />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <b>{pk(s, "not_connected_title", ctx.platform)}</b>
              <p className="desc">{s.not_connected_body}</p>
            </div>
          </div>
          <ConnectPanel ctx={ctx} s={s} c={c} status={status.data} redirectUri={redirectUri} onConnected={connectedNow} />
        </>
      ) : (
        <>
          {account.status === "ERROR" && (
            <Flash tone="crit">
              {s.check_failed} {reasonOf(ctx, s, account.lastError)}
            </Flash>
          )}
          <div className="split">
            <ProfileCard
              ctx={ctx}
              s={s}
              status={status}
              syncing={sync.state === "queued"}
              onSync={() => void sync.start(account.lastSyncAt)}
              onNote={setNote}
              onChanged={refreshAll}
            />
            <ScoreCard ctx={ctx} s={s} c={c} audit={audit} onRan={() => void status.reload()} />
          </div>
          <KeyMetrics ctx={ctx} s={s} c={c} analytics={analytics} />
          <div className="split">
            <SettingsCard ctx={ctx} s={s} c={c} account={account} onSaved={(a) => status.setData((p) => (p ? { ...p, account: a } : p))} />
            <CapabilitiesCard ctx={ctx} s={s} status={status.data} />
          </div>
          {account.status === "ERROR" && <ConnectPanel ctx={ctx} s={s} c={c} status={status.data} redirectUri={redirectUri} onConnected={connectedNow} />}
          <NextSteps ctx={ctx} s={s} />
        </>
      )}
    </>
  );
}

function FirstSync({ state, ctx, s, lastError }: { state: "running" | "done" | "failed"; ctx: SocialCtx; s: SocialStrings; lastError: string | null }) {
  return (
    <section className="card">
      <header>
        <h3>{s.fs_title}</h3>
      </header>
      <div className="body stack-sm">
        {state === "running" ? (
          <div className="jobline active" role="status" aria-live="polite">
            <span className="spin" aria-hidden="true" />
            <span>{s.fs_running}</span>
          </div>
        ) : state === "failed" ? (
          <Flash tone="crit">
            {s.fs_failed} {reasonOf(ctx, s, lastError)}
          </Flash>
        ) : (
          <>
            <Flash tone="ok">{s.fs_done}</Flash>
            <div className="row">
              <Link className="btn primary" href={ctx.links.audit}>
                <Icon name="pulse" />
                {s.view_findings}
              </Link>
              <Link className="btn ghost" href={ctx.links.analytics}>
                <Icon name="trend" />
                {s.step_analytics}
              </Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ProfileCard({
  ctx,
  s,
  status,
  syncing,
  onSync,
  onNote,
  onChanged,
}: {
  ctx: SocialCtx;
  s: SocialStrings;
  status: Loaded<SocialStatus>;
  syncing: boolean;
  onSync: () => void;
  onNote: (n: { tone: "ok" | "crit" | "info"; text: string } | null) => void;
  onChanged: () => Promise<void>;
}) {
  const account = status.data!.account;
  const action = useAction(ctx.locale);
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social`;
  const rights = account.profile.rights ?? {};
  const tg = ctx.platform === "TELEGRAM";

  async function check() {
    const r = await action.run<{ ok: boolean; reason?: string; account: Account }>(`${base}/check`);
    if (!r) return;
    status.setData((p) => (p ? { ...p, account: r.account } : p));
    onNote(r.ok ? { tone: "ok", text: s.check_ok } : { tone: "crit", text: `${s.check_failed} ${reasonOf(ctx, s, r.reason)}` });
  }

  async function disconnect() {
    const r = await action.run<{ account: Account }>(`${base}/connection`, { method: "DELETE" });
    if (!r) return;
    onNote({ tone: "info", text: s.disconnected });
    await onChanged();
  }

  return (
    <section className="card">
      <div className="body stack-sm">
        <ProfileHeader account={account} s={s} locale={ctx.locale} />
        <p className="profile-bio">{account.bio ? <UserText>{account.bio}</UserText> : <span className="muted">{s.no_bio}</span>}</p>
        <dl className="kv">
          {account.website && (
            <>
              <dt>{s.website}</dt>
              <dd>
                <span className="url" dir="ltr">
                  {account.website}
                </span>
              </dd>
            </>
          )}
          <dt>{s.last_sync}</dt>
          <dd>{account.lastSyncAt ? <span title={dateTime(account.lastSyncAt, ctx.locale)}>{relative(account.lastSyncAt, ctx.locale)}</span> : s.never}</dd>
          {account.connectedAt && (
            <>
              <dt>{s.connected_at}</dt>
              <dd>{dateTime(account.connectedAt, ctx.locale)}</dd>
            </>
          )}
          {!tg && account.profile.accountType && (
            <>
              <dt>{s.account_type}</dt>
              <dd>{maybe(s, `acct_${account.profile.accountType}`) ?? <span translate="no">{account.profile.accountType}</span>}</dd>
            </>
          )}
          {!tg && account.tokenExpiresAt && (
            <>
              <dt>{s.token_expires}</dt>
              <dd title={s.token_renew_help}>{dateTime(account.tokenExpiresAt, ctx.locale)}</dd>
            </>
          )}
          {tg && account.profile.botUsername && (
            <>
              <dt>{s.bot}</dt>
              <dd>
                <span dir="ltr" translate="no">
                  @{account.profile.botUsername}
                </span>
              </dd>
            </>
          )}
          {tg && account.profile.updates && (
            <>
              <dt>{s.updates_mode}</dt>
              <dd>{account.profile.updates.mode === "webhook" ? s.mode_webhook : s.mode_polling}</dd>
            </>
          )}
        </dl>
        {tg && account.profile.updates?.error && <p className="hint">{s.webhook_failed}</p>}
        {tg && (
          <div>
            <h4 className="sub-h">{s.rights}</h4>
            <ul className="checklist rights">
              {(["can_post_messages", "can_edit_messages", "can_change_info"] as const).map((r) => (
                <li key={r} className={rights[r] ? undefined : "missing"}>
                  <Icon name={rights[r] ? "check" : "x"} />
                  <span>
                    <b>{maybe(s, `right_${r}`)}</b> — {maybe(s, `right_use_${r}`)}{" "}
                    <span className={`pill ${rights[r] ? "ok" : "crit"}`}>{rights[r] ? s.right_ok : s.right_missing}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {action.error && <Flash tone="crit">{action.error}</Flash>}
        <div className="row">
          {ctx.can.write && (
            <button type="button" className="btn primary sm" onClick={onSync} disabled={syncing || account.status === "NOT_CONNECTED"}>
              {syncing ? <span className="spin" aria-hidden="true" /> : <Icon name="refresh" />}
              {syncing ? s.syncing : s.sync_now}
            </button>
          )}
          {ctx.can.check && (
            <button type="button" className="btn ghost sm" onClick={() => void check()} disabled={action.busy}>
              <Icon name="shield" />
              {s.check}
            </button>
          )}
          {ctx.can.connect && (
            <ConfirmButton label={s.disconnect} confirmLabel={s.disconnect_confirm} onConfirm={() => void disconnect()} disabled={action.busy} icon="x" className="btn danger sm" />
          )}
        </div>
      </div>
    </section>
  );
}

export function ScoreCard({
  ctx,
  s,
  c,
  audit,
  onRan,
  compact,
}: {
  ctx: SocialCtx;
  s: SocialStrings;
  c: CommonStrings;
  audit: Loaded<AuditResult>;
  onRan?: () => void;
  compact?: boolean;
}) {
  const action = useAction(ctx.locale);
  const [done, setDone] = useState<string | null>(null);
  const data = audit.data;

  async function run() {
    setDone(null);
    const r = await action.run<AuditResult>(`/api/projects/${encodeURIComponent(ctx.projectId)}/social/audit`);
    if (!r) return;
    audit.setData(r);
    setDone(fmt(s.audit_done, { score: num(r.score, ctx.locale), n: num(r.findings.filter((f) => f.status === "OPEN").length, ctx.locale) }));
    onRan?.();
  }

  const open = data?.findings.filter((f) => f.status === "OPEN") ?? [];
  const bySev = (["CRITICAL", "SERIOUS", "WARNING", "INFO"] as const).map((sev) => ({ sev, n: open.filter((f) => f.severity === sev).length }));

  return (
    <section className="card">
      <header>
        <h3>{s.score}</h3>
        {data?.run?.finishedAt && <span className="sub">{relative(data.run.finishedAt, ctx.locale)}</span>}
      </header>
      <div className="body stack-sm">
        {audit.error && !data ? (
          <ErrorNote message={audit.error} onRetry={() => void audit.reload()} c={c} />
        ) : !data ? (
          <Loading label={c.loading} rows={3} />
        ) : (
          <>
            {data.score === null ? (
              <p className="muted">{s.no_audit}</p>
            ) : (
              <div className="gauge-wrap">
                <ScoreGauge score={data.score} label={s.score} locale={ctx.locale} />
                <div className="stack-xs" style={{ flex: "1 1 160px" }}>
                  {bySev.map(({ sev, n }) => (
                    <div key={sev} className="row" style={{ justifyContent: "space-between" }}>
                      <SevPill severity={sev} s={s} />
                      <b className="num">{num(n, ctx.locale)}</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!compact && <p className="hint">{s.score_help}</p>}
            {done && <Flash tone="ok">{done}</Flash>}
            {action.error && <Flash tone="crit">{action.error}</Flash>}
            <div className="row">
              {data.score !== null && (
                <Link className="btn ghost sm" href={ctx.links.audit}>
                  <Icon name="list" />
                  {s.view_findings} ({num(open.length, ctx.locale)})
                </Link>
              )}
              {ctx.can.write && !compact && (
                <button type="button" className="btn ghost sm" onClick={() => void run()} disabled={action.busy}>
                  {action.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="pulse" />}
                  {action.busy ? s.auditing : s.run_audit}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function KeyMetrics({ ctx, s, c, analytics }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings; analytics: Loaded<Analytics> }) {
  const a = analytics.data;
  const L = ctx.locale;
  if (analytics.error && !a) return <ErrorNote message={analytics.error} onRetry={() => void analytics.reload()} c={c} />;
  if (!a) return <Loading label={c.loading} rows={2} />;
  const tg = ctx.platform === "TELEGRAM";
  const change =
    a.followers.net === null ? (
      <span className="muted small">{s.m_no_change}</span>
    ) : (
      <span className={`delta ${a.followers.net > 0 ? "up" : a.followers.net < 0 ? "down" : "flat"}`}>
        <span dir="ltr">{signed(a.followers.net, L)}</span>
        {a.followers.percent !== null && <span>({fmt(s.m_change_pct, { n: decimal(a.followers.percent, L, 1) })})</span>}
      </span>
    );
  return (
    <section className="card">
      <header>
        <h3>{s.metrics}</h3>
      </header>
      <div className="body">
        <div className="statgrid">
          <div className="stat">
            <span className="k">{pk(s, "m_followers", ctx.platform)}</span>
            <span className="v">{num(a.followers.current, L)}</span>
            <span className="row small" style={{ gap: 6 }}>
              {change}
            </span>
            <SourcePill source={a.sources.followers} platform={ctx.platform} s={s} />
          </div>
          <div className="stat">
            <span className="k">{s.m_posts_week}</span>
            <span className="v">{decimal(a.posts.perWeek, L, 1)}</span>
            <span className="small muted">{fmt(s.m_posts_n, { n: num(a.posts.count, L) })}</span>
          </div>
          {tg ? (
            <>
              <div className="stat">
                <span className="k">{s.m_avg_views}</span>
                <span className="v">{a.engagement.averageViews == null ? "—" : num(Math.round(a.engagement.averageViews), L)}</span>
                <SourcePill source={a.sources.views} platform={ctx.platform} s={s} />
              </div>
              <div className="stat">
                <span className="k">{s.m_view_rate}</span>
                <span className="v">{percent(a.engagement.averageViewRate, L)}</span>
                <SourcePill source={a.sources.views} platform={ctx.platform} s={s} />
              </div>
            </>
          ) : (
            <>
              <div className="stat">
                <span className="k">{s.m_er_reach}</span>
                <span className="v">{percent(a.engagement.averageErByReach, L)}</span>
                <SourcePill source="api" platform={ctx.platform} s={s} />
              </div>
              <div className="stat">
                <span className="k">{s.m_er_followers}</span>
                <span className="v">{percent(a.engagement.averageErByFollowers, L)}</span>
                <SourcePill source="api" platform={ctx.platform} s={s} />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function CapabilitiesCard({ ctx, s, status }: { ctx: SocialCtx; s: SocialStrings; status: SocialStatus }) {
  const cap = status.capabilities;
  const yn = (v: boolean | null | undefined) =>
    v === null || v === undefined ? (
      <span className="pill mute">{s.cap_unknown}</span>
    ) : v ? (
      <span className="pill ok">
        <Icon name="check" />
        {s.cap_yes}
      </span>
    ) : (
      <span className="pill mute">
        <Icon name="x" />
        {s.cap_no}
      </span>
    );
  return (
    <section className="card">
      <header>
        <h3>{s.caps_title}</h3>
      </header>
      <div className="body stack-sm">
        <dl className="kv">
          <dt>{pk(s, "cap_edit_profile", ctx.platform)}</dt>
          <dd>{yn(cap.editProfile)}</dd>
          <dt>{s.cap_publish}</dt>
          <dd>
            <span className="row" style={{ gap: 4 }}>
              {cap.publish.map((f) => (
                <span key={f} className="pill mute">
                  {maybe(s, `fmt_${f}`) ?? f}
                </span>
              ))}
            </span>
          </dd>
          <dt>{s.cap_edit_posts}</dt>
          <dd>{yn(cap.editPosts)}</dd>
          <dt>{s.cap_pin}</dt>
          <dd>{yn(cap.pin)}</dd>
          <dt>{s.cap_competitors}</dt>
          <dd>{yn(cap.competitors)}</dd>
          {ctx.platform === "TELEGRAM" && (
            <>
              <dt>{s.cap_views_TG}</dt>
              <dd>{yn(cap.views)}</dd>
            </>
          )}
        </dl>
        <ul className="plain notes-inline">
          {cap.notes.map((n) => (
            <li key={n} className="hint">
              <Icon name="info" />
              <span>
                <Rich text={maybe(s, `note_${n}`) ?? ""} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SettingsCard({ ctx, s, c, account, onSaved }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings; account: Account; onSaved: (a: Account) => void }) {
  const [keywords, setKeywords] = useState<string[]>(account.settings.keywords ?? []);
  const [draft, setDraft] = useState("");
  const [cta, setCta] = useState(account.settings.cta ?? "");
  const [link, setLink] = useState(account.settings.link ?? "");
  const [tz, setTz] = useState(account.settings.timezone ?? "Asia/Tehran");
  const [saved, setSaved] = useState(false);
  const action = useAction(ctx.locale);
  const linkOk = !link.trim() || /^https?:\/\/\S+\.\S+/i.test(link.trim());
  const disabled = !ctx.can.write;

  function add() {
    const k = draft.trim();
    if (k.length < 2 || keywords.length >= 10 || keywords.includes(k)) return;
    setKeywords([...keywords, k]);
    setDraft("");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!linkOk) return;
    setSaved(false);
    const r = await action.run<{ account: Account }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/social`, {
      method: "PATCH",
      body: { keywords, cta: cta.trim() || null, link: link.trim() || null, timezone: tz },
    });
    if (!r) return;
    onSaved(r.account);
    setSaved(true);
  }

  return (
    <section className="card">
      <header>
        <h3>{s.settings_title}</h3>
      </header>
      <div className="body">
        <form className="stack-sm" onSubmit={save}>
          <p className="hint">{s.settings_help}</p>
          <div className="field">
            <label htmlFor="kw-input">{s.keywords}</label>
            {keywords.length > 0 && (
              <ul className="chips">
                {keywords.map((k) => (
                  <li key={k}>
                    <UserText>{k}</UserText>
                    {!disabled && (
                      <button type="button" className="chip-x" aria-label={fmt(s.keyword_remove, { k })} onClick={() => setKeywords(keywords.filter((x) => x !== k))}>
                        <Icon name="x" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!disabled && (
              <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <input
                  id="kw-input"
                  value={draft}
                  maxLength={60}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add();
                    }
                  }}
                  placeholder={s.keyword_placeholder}
                  disabled={keywords.length >= 10}
                />
                <button type="button" className="btn ghost sm" onClick={add} disabled={draft.trim().length < 2 || keywords.length >= 10}>
                  <Icon name="plus" />
                  {s.keyword_add}
                </button>
              </div>
            )}
            <span className="hint">{keywords.length >= 10 ? s.keywords_max : pk(s, "keywords_help", ctx.platform)}</span>
          </div>
          <div className="formgrid">
            <label className="field">
              <span>{s.cta}</span>
              <input value={cta} maxLength={80} onChange={(e) => setCta(e.target.value)} placeholder={s.cta_placeholder} disabled={disabled} />
              <span className="hint">{s.cta_help}</span>
            </label>
            <label className="field">
              <span>{s.link}</span>
              <input value={link} maxLength={200} dir="ltr" onChange={(e) => setLink(e.target.value)} placeholder="https://…" disabled={disabled} aria-invalid={!linkOk} />
              <span className="hint">{linkOk ? <Rich text={s.link_help} /> : <Rich text={s.link_invalid} />}</span>
            </label>
            <label className="field">
              <span>{s.timezone}</span>
              <select value={tz} onChange={(e) => setTz(e.target.value)} disabled={disabled}>
                {[...new Set([tz, ...TIMEZONES])].map((z) => (
                  <option key={z} value={z} translate={TIMEZONES.includes(z) ? undefined : "no"}>
                    {tzLabel(z, s)}
                  </option>
                ))}
              </select>
              <span className="hint">{s.timezone_help}</span>
            </label>
          </div>
          {saved && <Flash tone="ok">{s.settings_saved}</Flash>}
          {action.error && <Flash tone="crit">{action.error}</Flash>}
          {!disabled && (
            <div>
              <button type="submit" className="btn primary sm" disabled={action.busy || !linkOk}>
                {action.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="check" />}
                {action.busy ? c.saving : s.save_settings}
              </button>
            </div>
          )}
        </form>
      </div>
    </section>
  );
}

function NextSteps({ ctx, s }: { ctx: SocialCtx; s: SocialStrings }) {
  const items = [
    { href: ctx.links.audit, icon: "pulse", label: s.step_audit },
    { href: ctx.links.analytics, icon: "trend", label: s.step_analytics },
    { href: ctx.links.planner, icon: "calendar", label: s.step_planner },
    { href: ctx.links.competitors, icon: "users", label: s.step_competitors },
  ];
  return (
    <section className="card">
      <header>
        <h3>{s.next_steps}</h3>
      </header>
      <div className="body">
        <div className="quicklinks">
          {items.map((i) => (
            <Link key={i.href} href={i.href} className="quicklink">
              <Icon name={i.icon} />
              <span>{i.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

