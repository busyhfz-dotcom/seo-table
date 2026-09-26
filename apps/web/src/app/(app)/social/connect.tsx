"use client";

/**
 * Connecting the account: Instagram through its own consent screen (or, when
 * the server has no Instagram app, what the administrator must set up), and
 * Telegram through a bot the owner makes a channel administrator — with the
 * BotFather steps, the rights it needs and why, and the owner's explicit
 * permission before anything is stored.
 */
import { useState } from "react";
import { Icon } from "../../../components/icons";
import { Rich } from "../../../components/ui";
import { CopyButton, Flash } from "../../../components/kit";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import type { CommonStrings } from "../../../lib/common-strings";
import type { SocialStrings } from "./strings";
import { maybe, reasonOf, type Account, type SocialCtx, type SocialStatus } from "./parts";

const RIGHTS = ["can_post_messages", "can_edit_messages", "can_change_info"] as const;
const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CHANNEL = /^(-?\d{1,20}|@?[A-Za-z][A-Za-z0-9_]{3,31}|(https?:\/\/)?t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/?)$/i;

export function ConnectPanel({
  ctx,
  s,
  c,
  status,
  redirectUri,
  onConnected,
}: {
  ctx: SocialCtx;
  s: SocialStrings;
  c: CommonStrings;
  status: SocialStatus;
  redirectUri: string | null;
  onConnected: (account: Account) => void;
}) {
  return ctx.platform === "INSTAGRAM" ? (
    <InstagramConnect ctx={ctx} s={s} c={c} status={status} redirectUri={redirectUri} />
  ) : (
    <TelegramConnect ctx={ctx} s={s} onConnected={onConnected} />
  );
}

function InstagramConnect({ ctx, s, c, status, redirectUri }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings; status: SocialStatus; redirectUri: string | null }) {
  if (!status.instagramConfigured) {
    return (
      <section className="card">
        <header>
          <h3>{s.connect_title_IG}</h3>
        </header>
        <div className="body stack-sm">
          <div className="nc">
            <span className="mico">
              <Icon name="plug" />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <b>{s.ig_nc_title}</b>
              <p className="desc">{s.ig_nc_body}</p>
            </div>
          </div>
          <div>
            <h4 className="sub-h">{s.ig_nc_steps}</h4>
            <ol className="steps-list">
              <li>
                <Rich text={s.ig_nc_1} />
              </li>
              <li>
                <span>
                  <Rich text={s.ig_nc_2} />
                </span>
                {redirectUri && (
                  <span className="row" style={{ gap: 8 }}>
                    <code className="inline-code" dir="ltr">
                      {redirectUri}
                    </code>
                    <CopyButton text={redirectUri} c={c} />
                  </span>
                )}
              </li>
              <li>
                <Rich text={s.ig_nc_3} />
              </li>
              <li>{s.ig_nc_4}</li>
              <li>{s.ig_nc_5}</li>
            </ol>
          </div>
          <p className="hint">{s.ig_nc_ask}</p>
        </div>
      </section>
    );
  }
  const again = status.account.status !== "NOT_CONNECTED";
  return (
    <section className="card">
      <header>
        <h3>{s.connect_title_IG}</h3>
      </header>
      <div className="body stack-sm">
        <p className="desc">{s.ig_intro}</p>
        <div className="note">
          <Icon name="info" />
          <div>{s.ig_req_pro}</div>
        </div>
        <div>
          <h4 className="sub-h">{s.ig_perms}</h4>
          <ul className="checklist">
            {[s.perm_basic, s.perm_publish, s.perm_insights, s.perm_comments].map((p) => (
              <li key={p}>
                <Icon name="check" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="hint">{s.ig_cannot}</p>
        {ctx.can.connect ? (
          <div>
            <a className="btn primary" href={`/api/oauth/instagram/start?project=${encodeURIComponent(ctx.projectId)}`}>
              <Icon name="insta" />
              {again ? s.ig_reconnect_btn : s.ig_connect_btn}
            </a>
          </div>
        ) : (
          <div className="note lock">
            <Icon name="lock" />
            <div>{s.ask_admin}</div>
          </div>
        )}
      </div>
    </section>
  );
}

function TelegramConnect({ ctx, s, onConnected }: { ctx: SocialCtx; s: SocialStrings; onConnected: (a: Account) => void }) {
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; missing: string[] } | null>(null);
  const [touched, setTouched] = useState(false);

  const tokenOk = TOKEN.test(token.trim());
  const channelOk = CHANNEL.test(channel.trim());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!tokenOk || !channelOk || !consent) return;
    setBusy(true);
    setError(null);
    const r = await callApi<{ ok: true; account: Account } | { ok: false; reason: string; missing?: string[] }>(
      `/api/projects/${encodeURIComponent(ctx.projectId)}/social/telegram`,
      { method: "POST", body: { botToken: token.trim(), channel: channel.trim() } },
    );
    setBusy(false);
    if (!r.ok) return setError({ text: apiErrorMessage(ctx.locale, r.failure), missing: [] });
    if (!r.data.ok) return setError({ text: reasonOf(ctx, s, r.data.reason), missing: r.data.missing ?? [] });
    setToken("");
    onConnected(r.data.account);
  }

  return (
    <section className="card">
      <header>
        <h3>{s.connect_title_TG}</h3>
      </header>
      <div className="body stack-sm">
        <p className="desc">{s.tg_intro}</p>
        <ol className="connect-steps">
          <li>
            <h4>{s.tg_s1}</h4>
            <ul className="steps-list">
              <li>
                <Rich text={s.tg_s1_1} />
              </li>
              <li>
                <Rich text={s.tg_s1_2} />
              </li>
              <li>
                <Rich text={s.tg_s1_3} />
              </li>
            </ul>
          </li>
          <li>
            <h4>{s.tg_s2}</h4>
            <ul className="steps-list">
              <li>{s.tg_s2_1}</li>
              <li>{s.tg_s2_2}</li>
            </ul>
            <ul className="checklist rights">
              {RIGHTS.map((r) => (
                <li key={r} className={error?.missing.includes(r) ? "missing" : undefined}>
                  <Icon name={error?.missing.includes(r) ? "alert" : "check"} />
                  <span>
                    <b>{maybe(s, `right_${r}`)}</b> — {maybe(s, `right_use_${r}`)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="hint">{s.tg_s2_3}</p>
          </li>
          <li>
            <h4>{s.tg_s3}</h4>
            {ctx.can.connect ? (
              <form onSubmit={submit} className="stack-sm" noValidate>
                <div className="formgrid">
                  <label className="field">
                    <span>{s.token}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      dir="ltr"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      aria-invalid={touched && !tokenOk}
                      name="botToken"
                    />
                    <span className="hint">{touched && !tokenOk ? <Rich text={s.token_format} /> : s.token_help}</span>
                  </label>
                  <label className="field">
                    <span>{s.channel}</span>
                    <input
                      dir="ltr"
                      spellCheck={false}
                      value={channel}
                      onChange={(e) => setChannel(e.target.value)}
                      placeholder="t.me/…"
                      aria-invalid={touched && !channelOk}
                      name="channel"
                    />
                    <span className="hint">{touched && !channelOk ? s.channel_format : <Rich text={s.channel_help} />}</span>
                  </label>
                </div>
                <label className={`consent-box${touched && !consent ? " warn" : ""}`}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} name="consent" />
                  <span>{s.consent}</span>
                </label>
                {touched && !consent && <p className="hint" style={{ color: "var(--warn)" }}>{s.consent_needed}</p>}
                {error && (
                  <Flash tone="crit">
                    <div>
                      {s.tg_refused} {error.text}
                    </div>
                    {error.missing.length > 0 && (
                      <ul className="plain" style={{ marginTop: 6 }}>
                        {error.missing.map((m) => (
                          <li key={m}>{maybe(s, `right_${m}`) ?? m}</li>
                        ))}
                      </ul>
                    )}
                  </Flash>
                )}
                <div className="row">
                  <button type="submit" className="btn primary" disabled={busy}>
                    {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="tg" />}
                    {busy ? s.tg_checking : s.tg_connect_btn}
                  </button>
                </div>
              </form>
            ) : (
              <div className="note lock">
                <Icon name="lock" />
                <div>{s.ask_admin}</div>
              </div>
            )}
          </li>
        </ol>
      </div>
    </section>
  );
}
