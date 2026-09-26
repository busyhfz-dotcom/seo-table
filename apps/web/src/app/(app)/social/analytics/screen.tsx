"use client";

/**
 * Growth and engagement from what the platform reported: follower/member
 * series, Instagram's daily reach/views/engagement, posts by type, top posts,
 * the best publishing hours and weekdays from the profile's own posts,
 * hashtag lift, and the formula behind every rate.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "../../../../components/icons";
import { Table, UserText } from "../../../../components/ui";
import { BarList, ErrorNote, LineChart, Loading, seriesColor, useLoad } from "../../../../components/kit";
import { fmt } from "../../../../lib/dict";
import { dateTime, decimal, num, shortDate } from "../../../../lib/format";
import { localized } from "../../../../lib/seo-labels";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { SocialStrings } from "../strings";
import type { Analytics, Bucket, PerPost } from "../api-types";
import { SourcePill, maybe, percent, pk, signed, tzLabel, type SocialCtx } from "../parts";

const RANGES = [7, 28, 90] as const;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function SocialAnalyticsScreen({ ctx, s, c, connected }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings; connected: boolean }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(28);
  const url = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return `/api/projects/${encodeURIComponent(ctx.projectId)}/social/analytics?from=${isoDay(from)}&to=${isoDay(to)}`;
  }, [ctx.projectId, days]);
  const data = useLoad<Analytics>(connected ? url : null, ctx.locale);
  const L = ctx.locale;
  const tg = ctx.platform === "TELEGRAM";

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

  const a = data.data;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <p className="desc" style={{ maxWidth: 720 }}>
          {s.an_intro}
        </p>
        <div className="seg" role="group" aria-label={s.range}>
          {RANGES.map((n) => (
            <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}>
              {fmt(s.range_n, { n: num(n, L) })}
            </button>
          ))}
        </div>
      </div>
      {data.error && !a ? (
        <ErrorNote message={data.error} onRetry={() => void data.reload()} c={c} />
      ) : !a ? (
        <Loading label={c.loading} rows={8} />
      ) : (
        <>
          <div className="statgrid">
            <div className="stat">
              <span className="k">{pk(s, "m_followers", ctx.platform)}</span>
              <span className="v">{num(a.followers.current, L)}</span>
              <SourcePill source={a.sources.followers} platform={ctx.platform} s={s} />
            </div>
            <div className="stat">
              <span className="k">{s.an_net}</span>
              <span className="v" dir="ltr" style={{ textAlign: "start" }}>
                {a.followers.net === null ? "—" : signed(a.followers.net, L)}
              </span>
              <span className="small muted">{a.followers.percent === null ? s.m_no_change : percent(a.followers.percent, L)}</span>
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

          <div className="split">
            <section className="card">
              <header>
                <h3>{pk(s, "an_followers", ctx.platform)}</h3>
                <span className="spacer" />
                <SourcePill source={a.sources.followers} platform={ctx.platform} s={s} />
              </header>
              <div className="body">
                {a.followers.series.length < 2 ? (
                  <p className="muted">{s.an_no_series}</p>
                ) : (
                  <LineChart
                    locale={L}
                    ariaLabel={pk(s, "an_followers", ctx.platform)}
                    formatX={(x) => shortDate(x, L)}
                    series={[{ key: "f", label: pk(s, "m_followers", ctx.platform), color: seriesColor(0), points: a.followers.series.map((p) => ({ x: p.date, y: p.followers })) }]}
                  />
                )}
              </div>
            </section>
            <section className="card">
              <header>
                <h3>{s.an_posts}</h3>
              </header>
              <div className="body">
                {a.posts.count === 0 ? (
                  <p className="muted">{s.an_posts_none}</p>
                ) : (
                  <BarList
                    locale={L}
                    items={Object.entries(a.posts.byType)
                      .sort((x, y) => y[1] - x[1])
                      .map(([type, n]) => ({ key: type, label: maybe(s, `type_${type}`) ?? type, value: n }))}
                  />
                )}
              </div>
            </section>
          </div>

          {!tg && (
            <section className="card">
              <header>
                <h3>{s.an_daily}</h3>
                <span className="spacer" />
                <SourcePill source="api" platform={ctx.platform} s={s} />
              </header>
              <div className="body">
                {a.daily.length === 0 ? (
                  <p className="muted">{s.an_daily_none}</p>
                ) : (
                  <LineChart
                    locale={L}
                    ariaLabel={s.an_daily}
                    formatX={(x) => shortDate(x, L)}
                    series={(["reach", "views", "engagement"] as const).map((k, i) => ({
                      key: k,
                      label: s[k],
                      color: seriesColor(i),
                      points: a.daily.map((d) => ({ x: d.date, y: d[k] })),
                    }))}
                  />
                )}
              </div>
            </section>
          )}

          <TopPosts posts={a.topPosts} ctx={ctx} s={s} />
          <BestTimes a={a} ctx={ctx} s={s} />
          <Hashtags a={a} ctx={ctx} s={s} />

          <section className="card">
            <header>
              <h3>{s.an_formulas}</h3>
            </header>
            <div className="body">
              <dl className="kv formulas">
                {Object.entries(a.formulas).map(([k, pair]) => (
                  <div key={k} className="kvrow">
                    <dt>{maybe(s, `f_${k}`) ?? k}</dt>
                    <dd>{localized(pair, L)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        </>
      )}
    </>
  );
}

export function PostMetrics({ p, ctx, s }: { p: Pick<PerPost, "metrics" | "erByReach" | "viewRate">; ctx: SocialCtx; s: SocialStrings }) {
  const L = ctx.locale;
  const m = p.metrics;
  const items: Array<[string, string]> =
    ctx.platform === "TELEGRAM"
      ? [
          [s.views, m.views == null ? "—" : num(m.views, L)],
          [s.view_rate, percent(p.viewRate, L)],
        ]
      : [
          [s.likes, m.likes == null ? "—" : num(m.likes, L)],
          [s.comments, m.comments == null ? "—" : num(m.comments, L)],
          ...(m.saves != null ? ([[s.saves, num(m.saves, L)]] as Array<[string, string]>) : []),
          ...(m.shares != null ? ([[s.shares, num(m.shares, L)]] as Array<[string, string]>) : []),
          ...(m.reach != null ? ([[s.reach, num(m.reach, L)]] as Array<[string, string]>) : []),
          [s.er_reach, percent(p.erByReach, L)],
        ];
  return (
    <span className="metric-chips">
      {items.map(([k, v]) => (
        <span key={k}>
          <span className="muted">{k}</span> <b className="num">{v}</b>
        </span>
      ))}
    </span>
  );
}

function TopPosts({ posts, ctx, s }: { posts: PerPost[]; ctx: SocialCtx; s: SocialStrings }) {
  const L = ctx.locale;
  return (
    <section className="card">
      <header>
        <h3>{pk(s, "an_top", ctx.platform)}</h3>
        <span className="spacer" />
        <Link className="btn ghost sm" href={ctx.links.posts}>
          <Icon name="list" />
          {s.col_metrics}
        </Link>
      </header>
      {posts.length === 0 ? (
        <div className="body">
          <p className="muted">{s.an_posts_none}</p>
        </div>
      ) : (
        <Table head={[{ label: s.col_date }, { label: s.col_text }, { label: s.col_metrics }, { label: s.col_source }]}>
          {posts.map((p) => (
            <tr key={p.id}>
              <td style={{ whiteSpace: "nowrap" }}>
                {dateTime(p.publishedAt, L)}
                <div className="muted small">{maybe(s, `type_${p.type}`) ?? p.type}</div>
              </td>
              <td className="cap-cell">
                {p.caption ? <UserText className="clamp2">{p.caption}</UserText> : <span className="muted">{s.no_caption}</span>}
                {p.permalink && (
                  <div>
                    <a href={p.permalink} target="_blank" rel="noreferrer noopener" className="lnk small">
                      <Icon name="external" />
                      {s.open_post}
                    </a>
                  </div>
                )}
              </td>
              <td>
                <PostMetrics p={p} ctx={ctx} s={s} />
              </td>
              <td>
                <SourcePill source={p.source} platform={ctx.platform} s={s} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}

/** One row of cells per bucket kind; the darker the cell, the better its median. */
function HeatStrip({ buckets, size, label, fmtLabel, fmtValue }: { buckets: Bucket[]; size: number; label: string; fmtLabel: (k: number) => string; fmtValue: (b: Bucket) => string }) {
  const best = Math.max(0, ...buckets.map((b) => b.median));
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  return (
    <div className={`heat${size > 12 ? " hours" : ""}`} role="img" aria-label={label} style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}>
      {Array.from({ length: size }, (_, k) => {
        const b = byKey.get(k);
        const strength = b && best > 0 ? b.median / best : 0;
        return (
          <div key={k} className={`heat-cell${b ? "" : " none"}${b && b.median === best ? " top" : ""}`} title={b ? fmtValue(b) : fmtLabel(k)} style={b ? { background: `color-mix(in srgb, var(--acc) ${Math.round(15 + strength * 70)}%, var(--surface-2))` } : undefined}>
            <span>{fmtLabel(k)}</span>
          </div>
        );
      })}
    </div>
  );
}

function BestTimes({ a, ctx, s }: { a: Analytics; ctx: SocialCtx; s: SocialStrings }) {
  const L = ctx.locale;
  const tg = ctx.platform === "TELEGRAM";
  const value = (v: number) => (tg ? num(Math.round(v), L) : percent(v, L));
  const hourLabel = (h: number) => (L === "fa" ? num(h, L) : String(h));
  const dayLabel = (d: number) => maybe(s, `wd_${d}`) ?? String(d);
  const none = a.bestTimes.hours.length === 0 && a.bestTimes.weekdays.length === 0;
  const topHours = a.bestTimes.hours.slice(0, 3);
  // Saturday first in Persian, Sunday first in English.
  const weekOrder = L === "fa" ? [6, 0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
  const dayBuckets = a.bestTimes.weekdays.map((b) => ({ ...b, key: weekOrder.indexOf(b.key) }));
  return (
    <section className="card">
      <header>
        <h3>{s.an_best}</h3>
      </header>
      <div className="body stack-sm">
        <p className="hint">
          <span>{fmt(s.an_best_help, { tz: tzLabel(a.bestTimes.timeZone, s) })}</span> <span className="muted">({localized(a.formulas.bestTimes, L)})</span>
        </p>
        {none ? (
          <p className="muted">{s.an_best_none}</p>
        ) : (
          <>
            {topHours.length > 0 && (
              <div className="row" style={{ gap: 6 }}>
                <span className="muted small">{s.an_top_bucket}:</span>
                {topHours.map((b) => (
                  <span key={b.key} className="pill ok">
                    <Icon name="clock" />
                    {fmt(s.hour_fmt, { h: hourLabel(b.key) })} · {value(b.median)}
                  </span>
                ))}
              </div>
            )}
            <div>
              <h4 className="sub-h">{s.an_hours}</h4>
              <HeatStrip
                buckets={a.bestTimes.hours}
                size={24}
                label={s.an_hours}
                fmtLabel={hourLabel}
                fmtValue={(b) => fmt(s.an_bucket, { label: fmt(s.hour_fmt, { h: hourLabel(b.key) }), v: value(b.median), n: num(b.posts, L) })}
              />
            </div>
            <div>
              <h4 className="sub-h">{s.an_days}</h4>
              <HeatStrip
                buckets={dayBuckets}
                size={7}
                label={s.an_days}
                fmtLabel={(i) => dayLabel(weekOrder[i]!)}
                fmtValue={(b) => fmt(s.an_bucket, { label: dayLabel(weekOrder[b.key]!), v: value(b.median), n: num(b.posts, L) })}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Hashtags({ a, ctx, s }: { a: Analytics; ctx: SocialCtx; s: SocialStrings }) {
  const L = ctx.locale;
  const tg = ctx.platform === "TELEGRAM";
  return (
    <section className="card">
      <header>
        <h3>{s.an_hashtags}</h3>
      </header>
      {a.hashtags.length === 0 ? (
        <div className="body">
          <p className="muted">{s.an_hashtags_none}</p>
        </div>
      ) : (
        <>
          <Table head={[{ label: s.col_tag }, { label: s.col_posts, numeric: true }, { label: s.col_avg, numeric: true }, { label: s.col_lift, numeric: true }]}>
            {a.hashtags.map((h) => (
              <tr key={h.tag}>
                <td>
                  <UserText>#{h.tag.replace(/^#/, "")}</UserText>
                </td>
                <td className="tnum">{num(h.posts, L)}</td>
                <td className="tnum">{tg ? num(Math.round(h.average), L) : percent(h.average, L)}</td>
                <td className="tnum">
                  <span className={h.lift !== null && h.lift >= 1 ? "delta up" : "delta down"}>{h.lift === null ? "—" : fmt(s.lift_fmt, { n: decimal(h.lift, L, 2) })}</span>
                </td>
              </tr>
            ))}
          </Table>
          <div className="body">
            <p className="hint">
              {s.lift_help} ({localized(a.formulas.hashtagLift, L)})
            </p>
          </div>
        </>
      )}
    </section>
  );
}
