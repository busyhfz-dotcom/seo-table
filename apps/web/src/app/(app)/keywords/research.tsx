"use client";

import { useState } from "react";
import { Card } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { Flash, Loading, NotConfigured, SourceBadge, useAction, useLoad } from "../../../components/kit";
import { decimal, longDate, num, pct } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import type { CommonStrings } from "../../../lib/common-strings";
import type { KeywordStrings } from "./strings";
import type { Ctx, Ideas, Opportunities, Suggestions } from "./types";

/** Adds phrases to tracking with the market chosen on screen; returns how many were new. */
function useTrack(ctx: Ctx) {
  const action = useAction(ctx.locale);
  const [tracked, setTracked] = useState<Set<string>>(new Set());
  async function track(phrases: string[], market: { country: string; locale: string } = { country: "IR", locale: ctx.locale }) {
    const r = await action.run<{ added: unknown[]; skipped: number }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/keywords`, {
      body: { phrases: phrases.join("\n"), country: market.country, locale: market.locale },
    });
    if (!r) return false;
    setTracked((prev) => new Set([...prev, ...phrases.map((p) => p.toLocaleLowerCase())]));
    return true;
  }
  return { ...action, track, isTracked: (p: string) => tracked.has(p.toLocaleLowerCase()) };
}

export function GscMissing({ ctx, c }: { ctx: Ctx; c: CommonStrings }) {
  return <NotConfigured title={c.nc_gsc_title} body={c.nc_gsc_body} action={c.nc_gsc_action} href={ctx.links.connectGsc} />;
}

export function DfsMissing({ ctx, c }: { ctx: Ctx; c: CommonStrings }) {
  return (
    <NotConfigured
      title={c.nc_dfs_title}
      body={ctx.links.integrations ? c.nc_dfs_body : `${c.nc_dfs_body} ${c.nc_dfs_ask_admin}`}
      action={ctx.links.integrations ? c.nc_dfs_action : null}
      href={ctx.links.integrations}
      icon="key"
    />
  );
}

export function OpportunitiesPanel({ ctx, s, c, onTracked }: { ctx: Ctx; s: KeywordStrings; c: CommonStrings; onTracked: () => Promise<void> }) {
  const { locale } = ctx;
  const data = useLoad<Opportunities>(`/api/projects/${encodeURIComponent(ctx.projectId)}/keywords/opportunities`, locale);
  const t = useTrack(ctx);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function track(phrases: string[]) {
    if (await t.track(phrases)) {
      setSelected(new Set());
      await onTracked();
    }
  }

  return (
    <Card
      title={s.opp_title}
      sub={data.data?.configured ? fmt(s.period, { from: longDate(data.data.from, locale), to: longDate(data.data.to, locale) }) : undefined}
      right={
        <div className="row">
          <SourceBadge source="gsc" c={c} />
          {ctx.canWrite && selected.size > 0 && (
            <button type="button" className="btn primary sm" disabled={t.busy} onClick={() => void track([...selected])}>
              <Icon name="plus" />
              {s.track_selected} ({num(selected.size, locale)})
            </button>
          )}
        </div>
      }
      bare
    >
      <div style={{ padding: "12px 18px 0" }}>
        <p className="hint">{s.opp_help}</p>
      </div>
      {t.error && (
        <div style={{ padding: "10px 18px 0" }}>
          <Flash tone="crit">{t.error}</Flash>
        </div>
      )}
      {!data.data ? (
        data.error ? (
          <div style={{ padding: 18 }}>
            <Flash tone="crit">{data.error}</Flash>
          </div>
        ) : (
          <Loading label={c.loading} rows={5} />
        )
      ) : !data.data.configured ? (
        <div style={{ padding: 18 }}>
          <GscMissing ctx={ctx} c={c} />
        </div>
      ) : data.data.items.length === 0 ? (
        <div className="empty">
          <Icon name="bulb" />
          <div>{s.opp_empty}</div>
        </div>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                {ctx.canWrite && <th className="check" />}
                <th>{s.opp_query}</th>
                <th style={{ textAlign: "end" }}>{s.avg_pos}</th>
                <th style={{ textAlign: "end" }}>{s.col_impr}</th>
                <th style={{ textAlign: "end" }}>{s.col_clicks}</th>
                <th style={{ textAlign: "end" }}>{s.col_ctr}</th>
                <th style={{ textAlign: "end" }} title={s.opp_potential_help}>
                  {s.opp_potential}
                </th>
                {ctx.canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {data.data.items.map((o) => {
                const done = t.isTracked(o.query);
                return (
                  <tr key={o.query}>
                    {ctx.canWrite && (
                      <td className="check">
                        <input
                          type="checkbox"
                          disabled={done}
                          checked={selected.has(o.query)}
                          aria-label={fmt(s.select_row, { k: o.query })}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(o.query)) next.delete(o.query);
                              else next.add(o.query);
                              return next;
                            })
                          }
                        />
                      </td>
                    )}
                    <td>
                      <span translate="no" dir="auto" style={{ fontWeight: 500 }}>
                        {o.query}
                      </span>
                    </td>
                    <td className="tnum">{decimal(o.position, locale)}</td>
                    <td className="tnum">{num(o.impressions, locale)}</td>
                    <td className="tnum">{num(o.clicks, locale)}</td>
                    <td className="tnum">{pct(o.ctr, locale)}</td>
                    <td className="tnum">
                      <b>+{num(o.potentialClicks, locale)}</b>
                    </td>
                    {ctx.canWrite && (
                      <td style={{ textAlign: "end" }}>
                        {done ? (
                          <span className="pill ok">
                            <Icon name="check" />
                            {s.tracked}
                          </span>
                        ) : (
                          <button type="button" className="btn ghost sm" disabled={t.busy} onClick={() => void track([o.query])}>
                            <Icon name="plus" />
                            {s.track}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function ResearchPanel({ ctx, s, c, onTracked }: { ctx: Ctx; s: KeywordStrings; c: CommonStrings; onTracked: () => Promise<void> }) {
  const { locale, projectId } = ctx;
  const base = `/api/projects/${encodeURIComponent(projectId)}/keywords`;
  const [seed, setSeed] = useState("");
  const [country, setCountry] = useState("IR");
  const [lang, setLang] = useState<"fa" | "en">(locale);
  const sugg = useAction(locale);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const ideasAction = useAction(locale);
  const [ideas, setIdeas] = useState<Ideas | null>(null);
  const t = useTrack(ctx);

  async function suggest(e: React.FormEvent) {
    e.preventDefault();
    if (!seed.trim()) return;
    setIdeas(null);
    const qs = new URLSearchParams({ seed: seed.trim(), locale: lang, country });
    const r = await sugg.run<Suggestions>(`${base}/suggestions?${qs}`, { method: "GET" });
    setSuggestions(r);
  }

  async function research() {
    const r = await ideasAction.run<Ideas>(`${base}/ideas`, { body: { seeds: [seed.trim()], locale: lang, country, limit: 100 } });
    setIdeas(r);
  }

  async function track(phrase: string) {
    if (await t.track([phrase], { country, locale: lang })) await onTracked();
  }

  const trackCell = (phrase: string, already: boolean) =>
    ctx.canWrite ? (
      already || t.isTracked(phrase) ? (
        <span className="pill ok">
          <Icon name="check" />
          {s.tracked}
        </span>
      ) : (
        <button type="button" className="btn ghost sm" disabled={t.busy} onClick={() => void track(phrase)}>
          <Icon name="plus" />
          {s.track}
        </button>
      )
    ) : null;

  return (
    <>
      <Card title={s.tab_research}>
        <form className="formgrid" onSubmit={suggest}>
          <label className="field span2">
            {s.seed}
            <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder={s.seed_placeholder} dir="auto" maxLength={100} required />
          </label>
          <label className="field">
            {s.country}
            <select value={country} onChange={(e) => setCountry(e.target.value)}>
              {ctx.countries.map((co) => (
                <option key={co.code} value={co.code}>
                  {co.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {s.language}
            <select value={lang} onChange={(e) => setLang(e.target.value as "fa" | "en")}>
              <option value="fa">{s.lang_fa}</option>
              <option value="en">{s.lang_en}</option>
            </select>
          </label>
          <div className="row span2">
            <button type="submit" className="btn primary" disabled={sugg.busy || !seed.trim()}>
              <Icon name="search" />
              {sugg.busy ? c.loading : s.suggest}
            </button>
          </div>
        </form>
        {sugg.error && (
          <div style={{ marginTop: 12 }}>
            <Flash tone="crit">{sugg.error}</Flash>
          </div>
        )}
        {t.error && (
          <div style={{ marginTop: 12 }}>
            <Flash tone="crit">{t.error}</Flash>
          </div>
        )}
      </Card>

      {suggestions && (
        <div className="split">
          <Card title={s.sugg_title} right={<SourceBadge source="autocomplete" c={c} />} bare>
            <div style={{ padding: "12px 18px 0" }}>
              <p className="note" style={{ padding: "8px 12px" }}>
                <Icon name="info" />
                <span>{s.sugg_note}</span>
              </p>
            </div>
            {suggestions.items.length === 0 ? (
              <div className="empty">
                <Icon name="search" />
                <div>{s.sugg_empty}</div>
              </div>
            ) : (
              <ul className="movers" style={{ padding: "6px 18px 12px" }}>
                {suggestions.items.map((i) => (
                  <li key={i.idea}>
                    <span className="ph">
                      <span translate="no" dir="auto">
                        {i.idea}
                      </span>
                    </span>
                    {trackCell(i.idea, i.tracked)}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={s.ideas_title} right={<SourceBadge source="dataforseo" c={c} />}>
            {!ctx.sources.dataforseo ? (
              <DfsMissing ctx={ctx} c={c} />
            ) : (
              <div className="stack">
                <p className="hint">{s.ideas_help}</p>
                <p className="hint">
                  <Icon name="info" /> {c.paid_note}
                </p>
                {ctx.canWrite && (
                  <div>
                    <button type="button" className="btn" disabled={ideasAction.busy} onClick={() => void research()}>
                      <Icon name="trend" />
                      {ideasAction.busy ? c.loading : s.ideas_run}
                    </button>
                  </div>
                )}
                {ideasAction.error && <Flash tone="crit">{ideasAction.error}</Flash>}
                {ideas && !ideas.configured && <DfsMissing ctx={ctx} c={c} />}
                {ideas?.configured && (
                  <>
                    <span className="pill mute">
                      {ideas.cached || !ideas.cost ? c.cost_cached : fmt(c.cost_usd, { n: decimal(ideas.cost, locale, 3) })}
                    </span>
                    {ideas.items.length === 0 ? (
                      <p className="muted small">{s.ideas_empty}</p>
                    ) : (
                      <div className="tw">
                        <table>
                          <thead>
                            <tr>
                              <th>{s.col_idea}</th>
                              <th style={{ textAlign: "end" }}>{s.col_volume}</th>
                              <th style={{ textAlign: "end" }}>{s.col_kd}</th>
                              <th style={{ textAlign: "end" }}>{s.col_cpc}</th>
                              {ctx.canWrite && <th />}
                            </tr>
                          </thead>
                          <tbody>
                            {ideas.items.map((i) => (
                              <tr key={i.idea}>
                                <td>
                                  <span translate="no" dir="auto">
                                    {i.idea}
                                  </span>
                                </td>
                                <td className="tnum">{num(i.volume, locale)}</td>
                                <td className="tnum">{num(i.difficulty, locale)}</td>
                                <td className="tnum">{i.cpc === null ? "—" : decimal(i.cpc, locale, 2)}</td>
                                {ctx.canWrite && <td style={{ textAlign: "end" }}>{trackCell(i.idea, i.tracked)}</td>}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
