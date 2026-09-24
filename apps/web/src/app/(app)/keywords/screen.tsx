"use client";

import { useCallback, useMemo, useState } from "react";
import { Card } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import {
  Flash,
  JobLine,
  LineChart,
  Loading,
  PosChange,
  SourceBadge,
  Tabs,
  useAction,
  useJob,
  useLoad,
  type JobView,
} from "../../../components/kit";
import { decimal, num, shortDate } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import type { CommonStrings } from "../../../lib/common-strings";
import type { KeywordStrings } from "./strings";
import type { Ctx, KeywordList, Movers, Visibility } from "./types";
import { TrackedPanel } from "./tracked";
import { GscMissing, OpportunitiesPanel, ResearchPanel } from "./research";
import { MappingPanel } from "./mapping";

type Tab = "tracked" | "opps" | "research" | "mapping";

type RankJobResult = {
  gsc: { configured: boolean; keywords: number; rows: number };
  dataforseo: { configured: boolean; disabled: boolean; checked: number; failed: number; cost: number; stopped: { fa: string; en: string } | null };
} | null;

export function KeywordsScreen({ ctx, s, c }: { ctx: Ctx; s: KeywordStrings; c: CommonStrings }) {
  const { locale, projectId } = ctx;
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const [tab, setTab] = useState<Tab>("tracked");
  const list = useLoad<KeywordList>(`${base}/keywords`, locale);
  const visibility = useLoad<Visibility>(`${base}/rank/visibility`, locale);
  const movers = useLoad<Movers>(`${base}/rank/movers?days=7&limit=6`, locale);

  const reloadAll = useCallback(async () => {
    await Promise.all([list.reload(), visibility.reload(), movers.reload()]);
  }, [list, visibility, movers]);

  // ---- rank sync as a background job
  const sync = useAction(locale);
  const [jobUrl, setJobUrl] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<{ tone: "ok" | "crit" | "info"; text: string } | null>(null);
  const onJobDone = useCallback(
    (job: JobView<RankJobResult>) => {
      setJobUrl(null);
      if (job.state === "failed") {
        setSyncNote({ tone: "crit", text: s.sync_failed });
        return;
      }
      const r = job.result;
      const parts: string[] = [];
      if (r) {
        parts.push(r.gsc.configured ? fmt(s.sync_gsc, { k: num(r.gsc.keywords, locale), r: num(r.gsc.rows, locale) }) : s.sync_gsc_off);
        if (r.dataforseo.configured && !r.dataforseo.disabled) {
          parts.push(fmt(s.sync_dfs, { n: num(r.dataforseo.checked, locale), cost: decimal(r.dataforseo.cost, locale, 3) }));
          if (r.dataforseo.failed) parts.push(fmt(s.sync_dfs_failed, { n: num(r.dataforseo.failed, locale) }));
          if (r.dataforseo.stopped) parts.push(r.dataforseo.stopped[locale]);
        }
      }
      setSyncNote({ tone: "ok", text: [c.job_done, ...parts].join(" · ") });
      void reloadAll();
    },
    [s, c, locale, reloadAll],
  );
  const { job, timedOut } = useJob<RankJobResult>(jobUrl, onJobDone);

  async function startSync() {
    setSyncNote(null);
    const r = await sync.run<{ jobId: string; deduplicated: boolean }>(`${base}/rank/sync`);
    if (!r) return;
    setSyncNote({ tone: "info", text: r.deduplicated ? c.job_deduplicated : c.job_started });
    setJobUrl(`${base}/jobs/${encodeURIComponent(r.jobId)}`);
  }

  const stats = useMemo(() => summarize(list.data), [list.data]);
  const lastVis = visibility.data?.series.at(-1) ?? null;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <p className="desc" style={{ maxWidth: 720 }}>
          {s.intro}
        </p>
        {ctx.canWrite && (
          <div className="row">
            {jobUrl && <JobLine state={job?.state} c={c} />}
            <button type="button" className="btn" onClick={startSync} disabled={sync.busy || Boolean(jobUrl)}>
              <Icon name="refresh" />
              {jobUrl ? s.syncing : s.sync}
            </button>
          </div>
        )}
      </div>
      {sync.error && <Flash tone="crit">{sync.error}</Flash>}
      {syncNote && <Flash tone={syncNote.tone}>{syncNote.text}</Flash>}
      {timedOut && <Flash tone="info">{c.job_slow}</Flash>}

      <div className="statgrid">
        <Stat label={s.st_tracked} value={stats ? num(stats.tracked, locale) : null} />
        <Stat
          label={s.st_avg_pos}
          value={stats?.avgPos != null ? decimal(stats.avgPos, locale) : "—"}
          foot={<SourceBadge source="gsc" c={c} title={s.gsc_basis} />}
          loading={!stats}
        />
        <Stat label={s.st_clicks} value={stats ? num(stats.clicks, locale) : null} foot={<SourceBadge source="gsc" c={c} />} />
        <Stat label={s.st_impr} value={stats ? num(stats.impressions, locale) : null} foot={<SourceBadge source="gsc" c={c} />} />
        <Stat label={s.st_top10} value={stats ? num(stats.top10, locale) : null} foot={<SourceBadge source="gsc" c={c} />} />
        {/* num(null) is "—": a source with no data shows as unknown, never as zero. */}
        <Stat
          label={s.st_visibility}
          value={lastVis ? decimal(lastVis.visibility, locale) : visibility.data ? "—" : null}
          foot={<SourceBadge source="gsc" c={c} />}
        />
      </div>

      <div className="split">
        <Card title={s.vis_title} sub={<SourceBadge source="gsc" c={c} />}>
          {!visibility.data ? (
            visibility.error ? (
              <Flash tone="crit">{visibility.error}</Flash>
            ) : (
              <Loading label={c.loading} />
            )
          ) : visibility.data.series.length === 0 ? (
            ctx.sources.gsc ? (
              <p className="muted small">{s.vis_empty}</p>
            ) : (
              <GscMissing ctx={ctx} c={c} />
            )
          ) : (
            <>
              <LineChart
                locale={locale}
                ariaLabel={s.vis_axis}
                height={180}
                yMin={0}
                series={[
                  {
                    key: "v",
                    label: s.st_visibility,
                    color: "#2BE08A",
                    points: visibility.data.series.map((p) => ({ x: p.date, y: p.visibility })),
                  },
                ]}
                formatX={(x) => shortDate(x, locale)}
                formatY={(v) => decimal(v, locale, 0)}
              />
              <p className="hint" style={{ marginTop: 8 }}>
                {s.vis_help}
              </p>
            </>
          )}
        </Card>
        <MoversCard movers={movers} s={s} c={c} locale={locale} />
      </div>

      <Tabs
        label={s.tabs_label}
        locale={locale}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "tracked", label: s.tab_tracked, icon: "list", count: list.data?.keywords.length ?? null },
          { key: "opps", label: s.tab_opps, icon: "bulb" },
          { key: "research", label: s.tab_research, icon: "search" },
          { key: "mapping", label: s.tab_mapping, icon: "link" },
        ]}
      />

      {tab === "tracked" && (
        <TrackedPanel ctx={ctx} s={s} c={c} list={list} onChanged={reloadAll} />
      )}
      {tab === "opps" && <OpportunitiesPanel ctx={ctx} s={s} c={c} onTracked={reloadAll} />}
      {tab === "research" && <ResearchPanel ctx={ctx} s={s} c={c} onTracked={reloadAll} />}
      {tab === "mapping" && <MappingPanel ctx={ctx} s={s} c={c} />}
    </>
  );
}

function Stat({ label, value, foot, loading }: { label: string; value: string | null; foot?: React.ReactNode; loading?: boolean }) {
  return (
    <div className="stat">
      <span className="k">{label}</span>
      <span className="v">{value === null || loading ? <span className="spin" aria-hidden="true" /> : value}</span>
      {foot && <span className="f">{foot}</span>}
    </div>
  );
}

/**
 * Totals over the keywords Search Console has data for. With no such keyword
 * the Search Console figures are unknown ("—"), not zero.
 */
function summarize(list: KeywordList | null) {
  if (!list) return null;
  if (!list.keywords.some((k) => k.gsc)) return { tracked: list.keywords.length, avgPos: null, clicks: null, impressions: null, top10: null };
  let weighted = 0;
  let weight = 0;
  let clicks = 0;
  let impressions = 0;
  let top10 = 0;
  for (const k of list.keywords) {
    if (!k.gsc) continue;
    clicks += k.gsc.clicks;
    impressions += k.gsc.impressions;
    if (k.gsc.position !== null) {
      // Impression-weighted, the way Search Console averages positions itself.
      const w = Math.max(1, k.gsc.impressions);
      weighted += k.gsc.position * w;
      weight += w;
      if (k.gsc.position <= 10) top10++;
    }
  }
  return { tracked: list.keywords.length, avgPos: weight ? weighted / weight : null, clicks, impressions, top10 };
}

function MoversCard({
  movers,
  s,
  c,
  locale,
}: {
  movers: ReturnType<typeof useLoad<Movers>>;
  s: KeywordStrings;
  c: CommonStrings;
  locale: "fa" | "en";
}) {
  const [side, setSide] = useState<"gains" | "losses">("gains");
  const data = movers.data;
  const items = data ? data[side] : [];
  return (
    <Card
      title={s.movers_title}
      sub={s.movers_sub}
      right={
        <div className="seg" role="group">
          <button type="button" aria-pressed={side === "gains"} onClick={() => setSide("gains")}>
            {s.gains}
          </button>
          <button type="button" aria-pressed={side === "losses"} onClick={() => setSide("losses")}>
            {s.losses}
          </button>
        </div>
      }
    >
      {!data ? (
        movers.error ? <Flash tone="crit">{movers.error}</Flash> : <Loading label={c.loading} />
      ) : items.length === 0 ? (
        <p className="muted small">{s.no_movers}</p>
      ) : (
        <ul className="movers">
          {items.map((m) => (
            <li key={m.keywordId}>
              <span className="ph">
                <span translate="no" dir="auto">
                  {m.phrase}
                </span>
              </span>
              <span className="pos">
                {m.previousPosition === null ? "—" : decimal(m.previousPosition, locale)} {locale === "fa" ? "←" : "→"}{" "}
                {m.position === null ? s.vanished : decimal(m.position, locale)}
              </span>
              <PosChange current={m.position} previous={m.previousPosition} locale={locale} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
