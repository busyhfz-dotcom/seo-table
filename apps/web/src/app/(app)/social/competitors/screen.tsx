"use client";

/**
 * Competing profiles: add by @name or address, refresh, remove, and compare
 * followers, posting frequency and average views or interactions with the
 * profile's own. Instagram figures exist only where Business Discovery works
 * for the connection; otherwise the state says so and no number is shown.
 */
import { useState } from "react";
import { Icon } from "../../../../components/icons";
import { Table, UserText } from "../../../../components/ui";
import { BarList, ConfirmButton, ErrorNote, Flash, Loading, useAction, useLoad } from "../../../../components/kit";
import { fmt } from "../../../../lib/dict";
import { dateTime, decimal, num, relative } from "../../../../lib/format";
import { localized } from "../../../../lib/seo-labels";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { SocialStrings } from "../strings";
import type { Analytics, Competitor } from "../api-types";
import { SourcePill, maybe, pk, type SocialCtx, type SocialStatus } from "../parts";

const USERNAME = /^(https?:\/\/(www\.)?(instagram\.com|t\.me)\/(s\/)?)?@?[A-Za-z0-9._]{2,32}\/?$/i;
const TONE: Record<Competitor["status"], string> = { ok: "ok", pending: "mute", unsupported: "mute", not_found: "crit", no_public_preview: "warn", error: "crit" };

type List = { competitors: Competitor[]; max: number };

export function SocialCompetitorsScreen({ ctx, s, c }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings }) {
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social`;
  const list = useLoad<List>(`${base}/competitors`, ctx.locale);
  const status = useLoad<SocialStatus>(base, ctx.locale);
  const connected = status.data ? status.data.account.status !== "NOT_CONNECTED" : false;
  const mine = useLoad<Analytics & { recentPosts?: Array<{ interactions: number | null }> }>(connected ? `${base}/analytics` : null, ctx.locale);
  const action = useAction(ctx.locale);
  const [name, setName] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const L = ctx.locale;
  const tg = ctx.platform === "TELEGRAM";
  const valid = USERNAME.test(name.trim());

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return setNote({ tone: "crit", text: s.co_invalid });
    setNote(null);
    const r = await action.run<{ competitor: Competitor }>(`${base}/competitors`, { method: "POST", body: { username: name.trim() } }, {
      CONFLICT: { fa: s.co_duplicate, en: s.co_duplicate },
      BAD_REQUEST: { fa: s.co_invalid, en: s.co_invalid },
    });
    if (!r) return;
    setName("");
    list.setData((p) => (p ? { ...p, competitors: [...p.competitors, r.competitor] } : p));
    setNote({ tone: "ok", text: s.co_added });
    await refresh(r.competitor.id, false);
  }

  async function refresh(id: string | undefined, announce = true) {
    setBusyId(id ?? "all");
    const r = await action.run<{ competitors: Competitor[] }>(`${base}/competitors/refresh`, { body: id ? { competitorId: id } : {} });
    setBusyId(null);
    if (!r) return;
    list.setData((p) => (p ? { ...p, competitors: r.competitors } : p));
    if (announce) setNote({ tone: "ok", text: s.co_refreshed });
  }

  async function remove(id: string) {
    const r = await action.run(`${base}/competitors/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r) list.setData((p) => (p ? { ...p, competitors: p.competitors.filter((x) => x.id !== id) } : p));
  }

  if (list.error && !list.data) return <ErrorNote message={list.error} onRetry={() => void list.reload()} c={c} />;
  if (!list.data || !status.data) return <Loading label={c.loading} rows={6} />;
  const rows = list.data.competitors;
  const full = rows.length >= list.data.max;
  const bd = status.data.capabilities.competitors;
  const withData = rows.filter((r) => r.snapshot);

  const me = status.data.account;
  const myAvg = tg
    ? (mine.data?.engagement.averageViews ?? null)
    : (() => {
        const vals = (mine.data?.recentPosts ?? []).map((p) => p.interactions).filter((v): v is number => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      })();
  const myLabel = me.username ? `@${me.username}` : s.you;

  return (
    <>
      <p className="desc" style={{ maxWidth: 780 }}>
        {pk(s, "co_intro", ctx.platform)}
      </p>
      {!tg && bd === false && (
        <div className="nc">
          <span className="mico">
            <Icon name="info" />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <b>{s.co_unsupported_title}</b>
            <p className="desc">{s.co_unsupported_body}</p>
          </div>
        </div>
      )}
      {!tg && bd === null && <p className="hint">{s.co_unknown_bd}</p>}
      {note && <Flash tone={note.tone}>{note.text}</Flash>}
      {action.error && <Flash tone="crit">{action.error}</Flash>}

      {ctx.can.write && (
        <section className="card">
          <div className="body">
            <form className="row" onSubmit={add} style={{ alignItems: "flex-end" }}>
              <label className="field" style={{ flex: "1 1 260px" }}>
                <span>{s.co_add_label}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} dir="ltr" placeholder={tg ? "t.me/…" : "instagram.com/…"} aria-label={s.co_placeholder} disabled={full} />
                <span className="hint">{full ? fmt(s.co_limit, { n: num(list.data.max, L) }) : s.co_placeholder}</span>
              </label>
              <button type="submit" className="btn primary" disabled={action.busy || full || !name.trim()}>
                <Icon name="plus" />
                {s.co_add}
              </button>
              {rows.length > 0 && (
                <button type="button" className="btn ghost" onClick={() => void refresh(undefined)} disabled={action.busy}>
                  {busyId === "all" ? <span className="spin" aria-hidden="true" /> : <Icon name="refresh" />}
                  {s.co_refresh_all}
                </button>
              )}
            </form>
          </div>
        </section>
      )}

      {rows.length === 0 ? (
        <section className="card">
          <div className="body">
            <div className="empty">
              <Icon name="users" />
              <div>{s.co_empty}</div>
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <Table
            head={[
              { label: s.col_account },
              { label: s.col_status },
              { label: pk(s, "col_followers", ctx.platform), numeric: true },
              { label: s.col_ppw, numeric: true },
              { label: tg ? s.col_avg_views : s.col_avg_int, numeric: true },
              { label: s.col_fetched },
              { label: "" },
            ]}
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <b dir="ltr" translate="no">
                    @{r.username}
                  </b>
                  {r.snapshot?.name && (
                    <div className="small muted">
                      <UserText>{r.snapshot.name}</UserText>
                    </div>
                  )}
                </td>
                <td>
                  <span className={`pill ${TONE[r.status]}`}>{maybe(s, `cs_${r.status}`) ?? r.status}</span>
                  {r.statusText && <div className="hint">{localized(r.statusText, L)}</div>}
                  {r.snapshot && (
                    <div style={{ marginTop: 4 }}>
                      <SourcePill source={r.snapshot.source} platform={ctx.platform} s={s} />
                    </div>
                  )}
                </td>
                <td className="tnum">{num(r.snapshot?.followers ?? null, L)}</td>
                <td className="tnum">{r.snapshot?.postsPerWeek == null ? "—" : decimal(r.snapshot.postsPerWeek, L, 1)}</td>
                <td className="tnum">{num(tg ? (r.snapshot?.avgViews == null ? null : Math.round(r.snapshot.avgViews)) : r.snapshot?.avgInteractions == null ? null : Math.round(r.snapshot.avgInteractions), L)}</td>
                <td className="muted" title={r.fetchedAt ? dateTime(r.fetchedAt, L) : undefined}>
                  {r.fetchedAt ? relative(r.fetchedAt, L) : "—"}
                </td>
                <td style={{ textAlign: "end", whiteSpace: "nowrap" }}>
                  {ctx.can.write && (
                    <span className="row" style={{ gap: 4, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <button type="button" className="btn ghost sm" onClick={() => void refresh(r.id)} disabled={action.busy} aria-label={`${s.co_refresh} @${r.username}`}>
                        {busyId === r.id ? <span className="spin" aria-hidden="true" /> : <Icon name="refresh" />}
                      </button>
                      <ConfirmButton label={s.co_remove} confirmLabel={c.confirm} onConfirm={() => void remove(r.id)} disabled={action.busy} className="btn danger sm" />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {withData.length > 0 && (
        <section className="card">
          <header>
            <h3>{s.co_compare}</h3>
          </header>
          <div className="body grid g3">
            <Compare
              title={pk(s, "col_followers", ctx.platform)}
              L={L}
              me={{ label: myLabel, value: me.followers }}
              rows={withData.map((r) => ({ label: `@${r.username}`, value: r.snapshot!.followers }))}
            />
            <Compare
              title={s.col_ppw}
              L={L}
              digits={1}
              me={{ label: myLabel, value: mine.data?.posts.perWeek ?? null }}
              rows={withData.map((r) => ({ label: `@${r.username}`, value: r.snapshot!.postsPerWeek }))}
            />
            <Compare
              title={tg ? s.col_avg_views : s.col_avg_int}
              L={L}
              me={{ label: myLabel, value: myAvg === null ? null : Math.round(myAvg) }}
              rows={withData.map((r) => ({ label: `@${r.username}`, value: tg ? r.snapshot!.avgViews : r.snapshot!.avgInteractions }))}
            />
          </div>
        </section>
      )}
    </>
  );
}

function Compare({
  title,
  me,
  rows,
  L,
  digits,
}: {
  title: string;
  me: { label: string; value: number | null };
  rows: Array<{ label: string; value: number | null }>;
  L: SocialCtx["locale"];
  digits?: number;
}) {
  return (
    <div>
      <h4 className="sub-h">{title}</h4>
      <BarList
        locale={L}
        format={digits ? (v) => decimal(v, L, digits) : undefined}
        items={[
          { key: "me", label: <span dir="ltr" translate="no">{me.label}</span>, value: me.value, highlight: true },
          ...rows.map((r) => ({ key: r.label, label: <span dir="ltr" translate="no">{r.label}</span>, value: r.value === null ? null : digits ? r.value : Math.round(r.value) })),
        ]}
      />
    </div>
  );
}
