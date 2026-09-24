"use client";

import { Card } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { Flash, Loading, SourceBadge, useLoad } from "../../../components/kit";
import { decimal, longDate, num, pathOf, pct } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import type { CommonStrings } from "../../../lib/common-strings";
import type { KeywordStrings } from "./strings";
import type { Cannibalization, Ctx, MappingItem } from "./types";
import { GscMissing } from "./research";

export function MappingPanel({ ctx, s, c }: { ctx: Ctx; s: KeywordStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/keywords`;
  const mapping = useLoad<{ items: MappingItem[] }>(`${base}/mapping`, locale);
  const cannib = useLoad<Cannibalization>(`${base}/cannibalization`, locale);

  return (
    <>
      <Card title={s.map_title} bare>
        <div style={{ padding: "12px 18px 0" }}>
          <p className="hint">{s.map_help}</p>
        </div>
        {!mapping.data ? (
          mapping.error ? (
            <div style={{ padding: 18 }}>
              <Flash tone="crit">{mapping.error}</Flash>
            </div>
          ) : (
            <Loading label={c.loading} />
          )
        ) : mapping.data.items.length === 0 ? (
          <div className="empty">
            <Icon name="link" />
            <div>{s.map_empty}</div>
          </div>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{s.col_keyword}</th>
                  <th>{s.target_url}</th>
                  <th>{s.ranking_url}</th>
                  <th>{c.details}</th>
                </tr>
              </thead>
              <tbody>
                {mapping.data.items.map((m) => (
                  <tr key={m.keywordId}>
                    <td>
                      <span translate="no" dir="auto" style={{ fontWeight: 500 }}>
                        {m.phrase}
                      </span>
                    </td>
                    <td>
                      {m.targetUrl ? (
                        <span className="path" dir="ltr">
                          {pathOf(m.targetUrl)}
                        </span>
                      ) : (
                        <span className="muted small">{s.map_no_target}</span>
                      )}
                    </td>
                    <td>
                      {m.rankingUrl ? (
                        <>
                          <span className="path" dir="ltr">
                            {pathOf(m.rankingUrl)}
                          </span>
                          {m.rankingSource && (
                            <div className="cell-sub">
                              <SourceBadge source={m.rankingSource === "gsc" ? "gsc" : "serp"} c={c} />
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="muted small">{s.map_no_rank}</span>
                      )}
                    </td>
                    <td>
                      {m.matches === true ? (
                        <span className="pill ok">
                          <Icon name="check" />
                          {s.map_ok}
                        </span>
                      ) : m.matches === false ? (
                        <span className="pill warn">
                          <Icon name="alert" />
                          {s.map_wrong}
                        </span>
                      ) : (
                        <span className="pill mute">{s.map_unknown}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={s.cannib_title}
        sub={cannib.data?.configured ? fmt(s.period, { from: longDate(cannib.data.from, locale), to: longDate(cannib.data.to, locale) }) : undefined}
        right={<SourceBadge source="gsc" c={c} />}
      >
        <div className="stack">
          <p className="hint">{s.cannib_help}</p>
          {!cannib.data ? (
            cannib.error ? <Flash tone="crit">{cannib.error}</Flash> : <Loading label={c.loading} />
          ) : !cannib.data.configured ? (
            <GscMissing ctx={ctx} c={c} />
          ) : cannib.data.items.length === 0 ? (
            <div className="empty">
              <Icon name="check" />
              <div>{s.cannib_empty}</div>
            </div>
          ) : (
            cannib.data.items.slice(0, 50).map((q) => (
              <div key={q.query} className="nc" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b translate="no" dir="auto">
                    {q.query}
                  </b>
                  <span className="muted small">
                    {num(q.impressions, locale)} {s.col_impr} · {num(q.clicks, locale)} {s.col_clicks}
                    {q.tracked ? ` · ${s.tracked}` : ""}
                  </span>
                </div>
                <ul className="barlist">
                  {q.pages.map((p) => (
                    <li key={p.url}>
                      <span className="bl-label path" dir="ltr" title={p.url}>
                        {pathOf(p.url)}
                      </span>
                      <span className="bl-bar">
                        <i style={{ width: `${Math.max(2, p.share * 100)}%` }} />
                      </span>
                      <b className="num" title={`${s.avg_pos}: ${decimal(p.position, locale)}`}>
                        {pct(p.share, locale, 0)}
                      </b>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}
