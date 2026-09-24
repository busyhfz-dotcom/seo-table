"use client";

import { useState } from "react";
import { Card, Rich } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { ConfirmButton, Flash, Loading, useAction, useLoad } from "../../../components/kit";
import { decimal, num, relative } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import { localized } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { Locale } from "../../../lib/i18n";
import type { IntegrationStrings } from "./integrations-strings";

type Kind = "DATAFORSEO" | "PAGESPEED" | "TELEGRAM_ALERTS";
type View = {
  kind: Kind;
  configured: boolean;
  status: string;
  config: Record<string, unknown>;
  lastError: string | null;
  lastErrorText: { fa: string; en: string } | null;
  lastCheckedAt: string | null;
};
type SaveResult = View & { ok: boolean; messageText: { fa: string; en: string } | null };
type Usage = { totalCost: number; calls: number; byEndpoint: Array<{ endpoint: string; calls: number; cost: number }> };

const SLUG: Record<Kind, string> = { DATAFORSEO: "dataforseo", PAGESPEED: "pagespeed", TELEGRAM_ALERTS: "telegram_alerts" };

/** Organization integrations (OWNER/ADMIN): paid data, the PageSpeed key, Telegram alerts. */
export function Integrations({ s, c, locale }: { s: IntegrationStrings; c: CommonStrings; locale: Locale }) {
  const list = useLoad<{ integrations: View[] }>("/api/integrations", locale);
  if (!list.data) return list.error ? <Flash tone="crit">{list.error}</Flash> : <Loading label={c.loading} rows={6} />;
  const by = (k: Kind) => list.data!.integrations.find((i) => i.kind === k)!;
  return (
    <>
      <p className="desc">{s.intro}</p>
      <DataForSeo view={by("DATAFORSEO")} s={s} c={c} locale={locale} onChange={() => void list.reload()} />
      <div className="grid g2">
        <PageSpeed view={by("PAGESPEED")} s={s} c={c} locale={locale} onChange={() => void list.reload()} />
        <Telegram view={by("TELEGRAM_ALERTS")} s={s} c={c} locale={locale} onChange={() => void list.reload()} />
      </div>
    </>
  );
}

function StatusPill({ view, s }: { view: View; s: IntegrationStrings }) {
  if (view.configured)
    return (
      <span className="pill ok">
        <Icon name="check" />
        {s.connected}
      </span>
    );
  if (view.status === "ERROR")
    return (
      <span className="pill crit">
        <Icon name="alert" />
        {s.error}
      </span>
    );
  return <span className="pill mute">{s.not_connected}</span>;
}

/** Save (PUT), test, remove — the parts every integration shares. */
function useIntegration(kind: Kind, locale: Locale, s: IntegrationStrings, onChange: () => void) {
  const act = useAction(locale);
  const [note, setNote] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const url = `/api/integrations/${SLUG[kind]}`;
  const report = (r: SaveResult | null, okText: string) => {
    if (!r) return false;
    setNote(r.ok ? { tone: "ok", text: okText } : { tone: "crit", text: localized(r.messageText, locale) || s.error });
    onChange();
    return r.ok;
  };
  return {
    act,
    note,
    save: async (body: Record<string, unknown>) => {
      setNote(null);
      return report(await act.run<SaveResult>(url, { method: "PUT", body }), s.ok_saved);
    },
    test: async () => {
      setNote(null);
      report(await act.run<SaveResult>(`${url}/test`), s.ok_tested);
    },
    remove: async () => {
      setNote(null);
      if (await act.run(url, { method: "DELETE" })) onChange();
    },
    patch: async (body: Record<string, unknown>) => {
      setNote(null);
      if (await act.run(url, { method: "PATCH", body })) {
        setNote({ tone: "ok", text: s.ok_saved });
        onChange();
      }
    },
  };
}

function Footer({ view, s, c, locale, i }: { view: View; s: IntegrationStrings; c: CommonStrings; locale: Locale; i: ReturnType<typeof useIntegration> }) {
  return (
    <>
      {view.lastErrorText && !i.note && <Flash tone="crit">{localized(view.lastErrorText, locale)}</Flash>}
      {i.act.error && <Flash tone="crit">{i.act.error}</Flash>}
      {i.note && <Flash tone={i.note.tone}>{i.note.text}</Flash>}
      {view.configured && (
        <div className="row">
          <button type="button" className="btn ghost sm" disabled={i.act.busy} onClick={() => void i.test()}>
            <Icon name="refresh" />
            {s.test}
          </button>
          {view.lastCheckedAt && <span className="muted small">{fmt(s.last_checked, { when: relative(view.lastCheckedAt, locale) })}</span>}
          <span className="spacer" />
          <ConfirmButton label={s.remove} confirmLabel={c.confirm} disabled={i.act.busy} onConfirm={() => void i.remove()} />
        </div>
      )}
    </>
  );
}

function DataForSeo({ view, s, c, locale, onChange }: { view: View; s: IntegrationStrings; c: CommonStrings; locale: Locale; onChange: () => void }) {
  const i = useIntegration("DATAFORSEO", locale, s, onChange);
  const usage = useLoad<Usage>("/api/integrations/usage?days=30", locale);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState(false);
  const [rank, setRank] = useState(view.config.rankTracking !== false);
  const [cap, setCap] = useState(String(view.config.maxDailySerpChecks ?? 200));
  const showForm = !view.configured || editing;

  return (
    <Card title={s.dfs_title} right={<StatusPill view={view} s={s} />}>
      <div className="stack">
        <p className="hint">{s.dfs_desc}</p>
        {view.configured && (
          <dl className="kv compact">
            <dt>{s.dfs_account}</dt>
            <dd className="url" dir="ltr">
              {String(view.config.login ?? "—")}
            </dd>
            {typeof view.config.balance === "number" && (
              <>
                <dt>{s.dfs_balance}</dt>
                <dd className="num">{fmt(c.usd, { n: decimal(view.config.balance, locale, 2) })}</dd>
              </>
            )}
          </dl>
        )}
        {showForm ? (
          <form
            className="formgrid"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await i.save({ login: login.trim(), password, rankTracking: rank, maxDailySerpChecks: Number(cap) || 0 })) {
                setPassword("");
                setEditing(false);
              }
            }}
          >
            <label className="field">
              {s.dfs_login}
              <input value={login} onChange={(e) => setLogin(e.target.value)} dir="ltr" autoComplete="off" required minLength={3} />
            </label>
            <label className="field">
              {s.dfs_password}
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" autoComplete="new-password" required minLength={4} />
              <span className="hint">{s.dfs_password_help}</span>
            </label>
            <div className="row span2">
              <button type="submit" className="btn primary" disabled={i.act.busy}>
                {i.act.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="plug" />}
                {s.save_connect}
              </button>
              {editing && (
                <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                  {c.cancel}
                </button>
              )}
            </div>
          </form>
        ) : (
          <div>
            <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}>
              <Icon name="key" />
              {s.replace}
            </button>
          </div>
        )}
        {view.configured && (
          <form
            className="formgrid"
            onSubmit={(e) => {
              e.preventDefault();
              void i.patch({ rankTracking: rank, maxDailySerpChecks: Math.max(0, Math.min(5000, Number(cap) || 0)) });
            }}
          >
            <label className="pick span2">
              <input type="checkbox" checked={rank} onChange={(e) => setRank(e.target.checked)} />
              <span>
                {s.dfs_rank} <span className="muted small">— {s.dfs_rank_help}</span>
              </span>
            </label>
            <label className="field">
              {s.dfs_cap}
              <input type="number" min={0} max={5000} value={cap} onChange={(e) => setCap(e.target.value)} dir="ltr" />
            </label>
            <div className="row span2">
              <button type="submit" className="btn sm" disabled={i.act.busy}>
                <Icon name="check" />
                {s.dfs_settings_save}
              </button>
            </div>
          </form>
        )}
        <Footer view={view} s={s} c={c} locale={locale} i={i} />
        <section className="stack">
          <h4>{s.usage_title}</h4>
          {!usage.data ? (
            usage.error ? <Flash tone="crit">{usage.error}</Flash> : <Loading label={c.loading} rows={2} />
          ) : usage.data.calls === 0 ? (
            <p className="muted small">{s.usage_none}</p>
          ) : (
            <>
              <p className="small">{fmt(s.usage_total, { n: decimal(usage.data.totalCost, locale, 3), c: num(usage.data.calls, locale) })}</p>
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>{s.usage_endpoint}</th>
                      <th style={{ textAlign: "end" }}>{s.usage_calls}</th>
                      <th style={{ textAlign: "end" }}>{s.usage_cost}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.data.byEndpoint.map((u) => (
                      <tr key={u.endpoint}>
                        <td>
                          <code className="inline-code">{u.endpoint}</code>
                        </td>
                        <td className="tnum">{num(u.calls, locale)}</td>
                        <td className="tnum">{decimal(u.cost, locale, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </Card>
  );
}

function PageSpeed({ view, s, c, locale, onChange }: { view: View; s: IntegrationStrings; c: CommonStrings; locale: Locale; onChange: () => void }) {
  const i = useIntegration("PAGESPEED", locale, s, onChange);
  const [key, setKey] = useState("");
  return (
    <Card title={s.psi_title} right={<StatusPill view={view} s={s} />}>
      <div className="stack">
        <p className="hint">{s.psi_desc}</p>
        {view.configured && typeof view.config.keyHint === "string" && (
          <p className="small">
            {fmt(s.psi_hint, { hint: "" })}
            <code className="inline-code">{view.config.keyHint}</code>
          </p>
        )}
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await i.save({ apiKey: key.trim() })) setKey("");
          }}
        >
          <label className="field">
            {view.configured ? s.replace : s.psi_key}
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} dir="ltr" autoComplete="off" required minLength={20} />
            <span className="hint">
              <Rich text={s.psi_key_help} />
            </span>
          </label>
          <div>
            <button type="submit" className="btn primary" disabled={i.act.busy || key.trim().length < 20}>
              {i.act.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="key" />}
              {s.save_connect}
            </button>
          </div>
        </form>
        <Footer view={view} s={s} c={c} locale={locale} i={i} />
      </div>
    </Card>
  );
}

function Telegram({ view, s, c, locale, onChange }: { view: View; s: IntegrationStrings; c: CommonStrings; locale: Locale; onChange: () => void }) {
  const i = useIntegration("TELEGRAM_ALERTS", locale, s, onChange);
  const [token, setToken] = useState("");
  const [chat, setChat] = useState(typeof view.config.chatId === "string" ? view.config.chatId : "");
  return (
    <Card title={s.tg_title} right={<StatusPill view={view} s={s} />}>
      <div className="stack">
        <p className="hint">
          <Rich text={s.tg_desc} />
        </p>
        {view.configured && (
          <dl className="kv compact">
            {typeof view.config.botUsername === "string" && (
              <>
                <dt>{s.tg_bot}</dt>
                <dd className="url" dir="ltr">
                  @{view.config.botUsername}
                </dd>
              </>
            )}
            <dt>{s.tg_chat_title}</dt>
            <dd translate="no" dir="auto">
              {String(view.config.chatTitle ?? view.config.chatId ?? "—")}
            </dd>
          </dl>
        )}
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await i.save({ botToken: token.trim(), chatId: chat.trim() })) setToken("");
          }}
        >
          <label className="field">
            {s.tg_token}
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} dir="ltr" autoComplete="off" required />
          </label>
          <label className="field">
            {s.tg_chat}
            <input value={chat} onChange={(e) => setChat(e.target.value)} dir="ltr" required />
            <span className="hint">{s.tg_chat_help}</span>
          </label>
          <div>
            <button type="submit" className="btn primary" disabled={i.act.busy || !token.trim() || !chat.trim()}>
              {i.act.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="send" />}
              {s.save_connect}
            </button>
          </div>
        </form>
        {view.configured && <p className="hint">{s.tg_test_help}</p>}
        <Footer view={view} s={s} c={c} locale={locale} i={i} />
      </div>
    </Card>
  );
}
