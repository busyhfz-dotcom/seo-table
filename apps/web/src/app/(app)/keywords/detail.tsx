"use client";

import { useMemo, useState } from "react";
import { Icon } from "../../../components/icons";
import { ConfirmButton, Flash, LineChart, Loading, SourceBadge, useAction, useLoad } from "../../../components/kit";
import { decimal, num, shortDate } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import { SERP_FEATURES, pickLabel } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { KeywordStrings } from "./strings";
import type { Ctx, KeywordRow, Point } from "./types";
import { samePage } from "./tracked";

const RANGES = [28, 90, 180] as const;

export function KeywordDetail({
  k,
  ctx,
  s,
  c,
  onChanged,
}: {
  k: KeywordRow;
  ctx: Ctx;
  s: KeywordStrings;
  c: CommonStrings;
  onChanged: (closed: boolean) => Promise<void>;
}) {
  const { locale, projectId } = ctx;
  const base = `/api/projects/${encodeURIComponent(projectId)}/keywords/${encodeURIComponent(k.id)}`;
  const [days, setDays] = useState<(typeof RANGES)[number]>(90);
  const from = useMemo(() => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), [days]);
  const history = useLoad<{ keyword: { series: Point[] } | null }>(`${base}/history?from=${from}`, locale);
  const [target, setTarget] = useState(k.targetUrl ?? "");
  const [tags, setTags] = useState(k.tags.join("، "));
  const save = useAction(locale);
  const [saved, setSaved] = useState(false);

  const series = history.data?.keyword?.series ?? [];
  const gsc = series.filter((p) => p.source === "gsc");
  const serp = series.filter((p) => p.source === "dataforseo");
  const ranking = k.gsc?.url ?? k.serp?.url ?? null;

  async function patch(body: Record<string, unknown>, closes = false) {
    setSaved(false);
    const r = await save.run(base, { method: "PATCH", body });
    if (!r) return;
    setSaved(true);
    await onChanged(closes);
  }

  async function remove() {
    const r = await save.run(base, { method: "DELETE" });
    if (r) await onChanged(true);
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="seg" role="group" aria-label={s.range}>
          {RANGES.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
              {fmt(s.days_n, { n: num(d, locale) })}
            </button>
          ))}
        </div>
        <div className="row">
          {k.gsc && <SourceBadge source="gsc" c={c} />}
          {k.serp && <SourceBadge source="serp" c={c} />}
        </div>
      </div>

      <section className="stack">
        <h4>{s.pos_chart}</h4>
        {!history.data ? (
          history.error ? <Flash tone="crit">{history.error}</Flash> : <Loading label={c.loading} />
        ) : gsc.length + serp.length === 0 ? (
          <p className="muted small">{s.no_history}</p>
        ) : (
          <>
            <LineChart
              locale={locale}
              ariaLabel={s.pos_chart}
              invert
              height={190}
              series={[
                ...(gsc.length
                  ? [{ key: "gsc", label: s.series_gsc, color: "#5BB8F5", points: gsc.map((p) => ({ x: p.date, y: p.position })) }]
                  : []),
                ...(serp.length
                  ? [{ key: "serp", label: s.series_serp, color: "#2BE08A", points: serp.map((p) => ({ x: p.date, y: p.position })) }]
                  : []),
              ]}
              formatX={(x) => shortDate(x, locale)}
              formatY={(v) => decimal(v, locale, v % 1 ? 1 : 0)}
            />
            <p className="hint">{s.pos_chart_help}</p>
          </>
        )}
      </section>

      {gsc.length > 0 && (
        <section className="stack">
          <h4>{s.traffic_chart}</h4>
          <LineChart
            locale={locale}
            ariaLabel={s.traffic_chart}
            height={160}
            yMin={0}
            series={[
              { key: "i", label: s.series_impr, color: "#5BB8F5", points: gsc.map((p) => ({ x: p.date, y: p.impressions })) },
              { key: "c", label: s.series_clicks, color: "#2BE08A", points: gsc.map((p) => ({ x: p.date, y: p.clicks })) },
            ]}
            formatX={(x) => shortDate(x, locale)}
          />
        </section>
      )}

      <dl className="kv">
        <dt>{s.ranking_url}</dt>
        <dd>
          {ranking ? (
            <a className="url lnk" href={ranking} target="_blank" rel="noreferrer" dir="ltr">
              {ranking}
            </a>
          ) : (
            <span className="muted">{s.map_no_rank}</span>
          )}
          {k.targetUrl && ranking && (
            <div className="cell-sub">
              {samePage(k.targetUrl, ranking) ? (
                <span className="pill ok">
                  <Icon name="check" />
                  {s.target_matches}
                </span>
              ) : (
                <span className="pill warn">
                  <Icon name="alert" />
                  {s.target_differs}
                </span>
              )}
            </div>
          )}
        </dd>
        {k.serp && k.serp.features.length > 0 && (
          <>
            <dt>{s.serp_features}</dt>
            <dd className="row">
              {k.serp.features.map((f) => {
                const label = pickLabel(SERP_FEATURES, f, locale);
                return label ? (
                  <span key={f} className="pill mute">
                    {label}
                  </span>
                ) : (
                  <code key={f} className="inline-code">
                    {f}
                  </code>
                );
              })}
            </dd>
          </>
        )}
      </dl>

      {ctx.canWrite && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void patch({
              targetUrl: target.trim() || null,
              tags: tags
                .split(/[,،]/)
                .map((t) => t.trim())
                .filter(Boolean),
            });
          }}
        >
          <label className="field">
            {s.target_url}
            <input value={target} onChange={(e) => setTarget(e.target.value)} dir="ltr" type="url" placeholder={`${ctx.baseUrl.replace(/\/$/, "")}/…`} />
            <span className="hint">{s.target_help}</span>
          </label>
          <label className="field">
            {s.tags}
            <input value={tags} onChange={(e) => setTags(e.target.value)} dir="auto" />
            <span className="hint">{s.tags_help}</span>
          </label>
          {save.error && <Flash tone="crit">{save.error}</Flash>}
          {saved && !save.error && <Flash tone="ok">{c.saved}</Flash>}
          <div className="row">
            <button type="submit" className="btn primary" disabled={save.busy}>
              <Icon name="check" />
              {save.busy ? c.saving : c.save}
            </button>
            <span className="spacer" />
            {k.archivedAt ? (
              <button type="button" className="btn ghost" disabled={save.busy} onClick={() => void patch({ archived: false }, true)}>
                <Icon name="undo" />
                {s.unarchive}
              </button>
            ) : (
              <button type="button" className="btn ghost" disabled={save.busy} onClick={() => void patch({ archived: true }, true)}>
                <Icon name="box" />
                {s.archive}
              </button>
            )}
            <ConfirmButton label={s.delete_kw} confirmLabel={c.confirm} disabled={save.busy} onConfirm={() => void remove()} className="btn danger" />
          </div>
        </form>
      )}
    </>
  );
}
