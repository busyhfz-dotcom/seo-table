"use client";

import { useCallback, useState } from "react";
import { Card } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import {
  BarList,
  ConfirmButton,
  Flash,
  JobLine,
  Loading,
  NotConfigured,
  Sheet,
  SourceBadge,
  useAction,
  useJob,
  useLoad,
  type JobView,
} from "../../../components/kit";
import { decimal, num, pathOf, pct, relative, seconds } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import type { CommonStrings } from "../../../lib/common-strings";
import type { Locale } from "../../../lib/i18n";
import type { CompetitorStrings } from "./strings";

type Competitor = { id: string; domain: string; name: string | null; createdAt: string; lastAnalyzedAt: string | null; pagesSampled: number };
type SiteStats = {
  analyzedAt: string;
  pagesSampled: number;
  okPages: number;
  avgTitleLength: number | null;
  avgMetaDescriptionLength: number | null;
  pagesMissingTitle: number;
  pagesMissingMetaDescription: number;
  pagesWithOneH1: number;
  avgWordCount: number | null;
  medianWordCount: number | null;
  avgH2: number | null;
  avgInternalLinks: number | null;
  avgExternalLinks: number | null;
  schemaTypes: Array<{ type: string; pages: number }>;
  homepage: { url: string; lcpMs: number | null; cls: number | null } | null;
};
type Compare = { ours: SiteStats | null; competitors: Array<{ id: string; domain: string; name: string | null; stats: SiteStats | null }> };
type Snapshot = { id: string; url: string; statusCode: number; title: string | null; wordCount: number; h1: string[]; schemaTypes: string[] };
type Gap = { keyword: string; theirPosition: number; ourPosition: number | null; volume: number | null; difficulty: number | null; url: string | null };
type GapResult = { configured: false } | { configured: true; cost: number; missing: Gap[]; behind: Gap[]; shared: number };
type Backlinks = { backlinks: number | null; referringDomains: number | null; referringMainDomains: number | null; brokenBacklinks: number | null; rank: number | null; spamScore: number | null };
type BacklinkResult = { configured: false } | { configured: true; cost: number; ours: Backlinks; theirs: Backlinks };
type JobResult = { sites: Array<{ domain: string; self: boolean; pages: number; failed: boolean }> } | null;

export type CompetitorsCtx = {
  projectId: string;
  host: string;
  locale: Locale;
  canWrite: boolean;
  dataforseo: boolean;
  integrations: string | null;
  countries: Array<{ code: string; name: string }>;
};

export function CompetitorsScreen({ ctx, s, c }: { ctx: CompetitorsCtx; s: CompetitorStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/competitors`;
  const list = useLoad<{ competitors: Competitor[]; max: number }>(base, locale);
  const compare = useLoad<Compare>(`${base}/compare`, locale);
  const add = useAction(locale);
  const act = useAction(locale);
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "info" | "crit" | "warn"; text: string } | null>(null);
  const [jobUrl, setJobUrl] = useState<string | null>(null);
  const [pagesOf, setPagesOf] = useState<Competitor | null>(null);

  const reload = useCallback(async () => {
    await Promise.all([list.reload(), compare.reload()]);
  }, [list, compare]);

  const onDone = useCallback(
    (job: JobView<JobResult>) => {
      setJobUrl(null);
      void reload();
      if (job.state === "failed") return setNote({ tone: "crit", text: s.analyze_failed });
      const failed = job.result?.sites.filter((x) => x.failed) ?? [];
      setNote({
        tone: failed.length ? "warn" : "ok",
        text: [s.analyze_done, ...failed.map((f) => fmt(s.analyze_site_failed, { d: f.domain }))].join(" "),
      });
    },
    [reload, s],
  );
  const { job, timedOut } = useJob<JobResult>(jobUrl, onDone, 4000);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNote(null);
    const r = await add.run(base, { body: { domain: domain.trim(), ...(name.trim() ? { name: name.trim() } : {}) } });
    if (!r) return;
    setDomain("");
    setName("");
    setNote({ tone: "ok", text: s.added });
    await reload();
  }

  async function analyze(competitorId?: string) {
    setNote(null);
    const r = await act.run<{ jobId: string; deduplicated: boolean }>(`${base}/analyze`, { body: competitorId ? { competitorId } : {} });
    if (!r) return;
    setNote({ tone: "info", text: r.deduplicated ? c.job_deduplicated : s.analyze_started });
    setJobUrl(`/api/projects/${encodeURIComponent(ctx.projectId)}/jobs/${encodeURIComponent(r.jobId)}`);
  }

  async function remove(id: string) {
    if (await act.run(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" })) await reload();
  }

  const competitors = list.data?.competitors ?? [];

  return (
    <>
      <p className="desc" style={{ maxWidth: 780 }}>
        {s.intro}
      </p>
      {note && <Flash tone={note.tone}>{note.text}</Flash>}
      {act.error && <Flash tone="crit">{act.error}</Flash>}
      {timedOut && <Flash tone="info">{c.job_slow}</Flash>}

      <div className="split">
        <Card
          title={s.list_title}
          sub={list.data ? fmt(s.limit, { n: num(competitors.length, locale), max: num(list.data.max, locale) }) : undefined}
          right={
            ctx.canWrite && competitors.length > 0 ? (
              <div className="row">
                {jobUrl && <JobLine state={job?.state} c={c} />}
                <button type="button" className="btn" disabled={Boolean(jobUrl) || act.busy} onClick={() => void analyze()}>
                  <Icon name="refresh" />
                  {jobUrl ? s.analyzing : s.analyze_all}
                </button>
              </div>
            ) : undefined
          }
          bare
        >
          {!list.data ? (
            list.error ? (
              <div style={{ padding: 18 }}>
                <Flash tone="crit">{list.error}</Flash>
              </div>
            ) : (
              <Loading label={c.loading} />
            )
          ) : competitors.length === 0 ? (
            <div className="empty">
              <Icon name="users" />
              <div style={{ maxWidth: 420 }}>{s.empty}</div>
            </div>
          ) : (
            <ul className="complist">
              {competitors.map((co) => (
                <li key={co.id}>
                  <span className="mico">
                    <Icon name="globe" />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b className="url" dir="ltr">
                      {co.domain}
                    </b>
                    {co.name && (
                      <span className="muted small" translate="no" dir="auto">
                        {" "}
                        · {co.name}
                      </span>
                    )}
                    <div className="cell-sub">
                      <span>{co.lastAnalyzedAt ? fmt(s.analyzed, { when: relative(co.lastAnalyzedAt, locale) }) : s.never_analyzed}</span>
                      {co.pagesSampled > 0 && <span>· {fmt(s.sampled, { n: num(co.pagesSampled, locale) })}</span>}
                    </div>
                  </div>
                  <div className="row">
                    {co.pagesSampled > 0 && (
                      <button type="button" className="btn ghost sm" onClick={() => setPagesOf(co)}>
                        <Icon name="list" />
                        {s.pages}
                      </button>
                    )}
                    {ctx.canWrite && (
                      <>
                        <button type="button" className="btn ghost sm" disabled={Boolean(jobUrl) || act.busy} onClick={() => void analyze(co.id)}>
                          <Icon name="play" />
                          {s.analyze}
                        </button>
                        <ConfirmButton label={c.remove} confirmLabel={c.confirm} onConfirm={() => void remove(co.id)} disabled={act.busy} />
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {ctx.canWrite ? (
          <Card title={s.add_title}>
            <form className="stack" onSubmit={submit}>
              <label className="field">
                {s.domain}
                <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={s.domain_placeholder} dir="ltr" required minLength={3} maxLength={253} />
              </label>
              <label className="field">
                {s.name}
                <input value={name} onChange={(e) => setName(e.target.value)} dir="auto" maxLength={120} />
              </label>
              {add.error && <Flash tone="crit">{add.error}</Flash>}
              <div>
                <button type="submit" className="btn primary" disabled={add.busy || domain.trim().length < 3}>
                  <Icon name="plus" />
                  {add.busy ? c.saving : s.add}
                </button>
              </div>
            </form>
          </Card>
        ) : (
          <Card title={s.add_title}>
            <p className="muted small">{c.read_only}</p>
          </Card>
        )}
      </div>

      <CompareCard compare={compare} s={s} c={c} ctx={ctx} />

      <div className="split">
        <GapCard ctx={ctx} s={s} c={c} competitors={competitors} />
        <BacklinksCard ctx={ctx} s={s} c={c} competitors={competitors} />
      </div>

      <Sheet open={Boolean(pagesOf)} onClose={() => setPagesOf(null)} closeLabel={c.close} title={s.pages_title} sub={pagesOf ? <span className="url" dir="ltr">{pagesOf.domain}</span> : undefined}>
        {pagesOf && <PagesTable ctx={ctx} s={s} c={c} competitor={pagesOf} />}
      </Sheet>
    </>
  );
}

function CompareCard({ compare, s, c, ctx }: { compare: ReturnType<typeof useLoad<Compare>>; s: CompetitorStrings; c: CommonStrings; ctx: CompetitorsCtx }) {
  const { locale } = ctx;
  const data = compare.data;
  const sites = data
    ? [
        { key: "ours", label: s.ours, domain: ctx.host, stats: data.ours, mine: true },
        ...data.competitors.map((x) => ({ key: x.id, label: x.name ?? x.domain, domain: x.domain, stats: x.stats, mine: false })),
      ]
    : [];
  const anySampled = sites.some((x) => x.stats && !x.mine);
  const n = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "—" : d ? decimal(v, locale, d) : num(Math.round(v), locale));
  const rows: Array<{ label: string; value: (st: SiteStats) => React.ReactNode }> = [
    { label: s.m_pages, value: (st) => n(st.pagesSampled) },
    { label: s.m_ok, value: (st) => n(st.okPages) },
    { label: s.m_words_median, value: (st) => n(st.medianWordCount) },
    { label: s.m_words_avg, value: (st) => n(st.avgWordCount) },
    { label: s.m_title, value: (st) => n(st.avgTitleLength, 1) },
    { label: s.m_desc, value: (st) => n(st.avgMetaDescriptionLength, 1) },
    { label: s.m_no_desc, value: (st) => n(st.pagesMissingMetaDescription) },
    { label: s.m_one_h1, value: (st) => (st.okPages ? pct(st.pagesWithOneH1 / st.okPages, locale, 0) : "—") },
    { label: s.m_h2, value: (st) => n(st.avgH2, 1) },
    { label: s.m_internal, value: (st) => n(st.avgInternalLinks, 1) },
    { label: s.m_external, value: (st) => n(st.avgExternalLinks, 1) },
    {
      label: s.m_schema,
      value: (st) =>
        st.schemaTypes.length ? (
          <span className="row" style={{ gap: 4 }}>
            {st.schemaTypes.slice(0, 5).map((t) => (
              <code key={t.type} className="inline-code">
                {t.type}
              </code>
            ))}
          </span>
        ) : (
          "—"
        ),
    },
    { label: s.m_lcp, value: (st) => seconds(st.homepage?.lcpMs, locale) },
    { label: s.m_cls, value: (st) => (st.homepage?.cls == null ? "—" : decimal(st.homepage.cls, locale, 2)) },
  ];

  return (
    <Card title={s.compare_title} sub={s.compare_help} right={<SourceBadge source="crawl" c={c} />} bare>
      {!data ? (
        compare.error ? (
          <div style={{ padding: 18 }}>
            <Flash tone="crit">{compare.error}</Flash>
          </div>
        ) : (
          <Loading label={c.loading} />
        )
      ) : !anySampled ? (
        <div className="empty">
          <Icon name="users" />
          <div>{s.compare_empty}</div>
        </div>
      ) : (
        <>
          <div className="grid g2" style={{ padding: 18 }}>
            <div>
              <h4 className="small muted" style={{ marginBottom: 10 }}>
                {s.chart_words}
              </h4>
              <BarList
                locale={locale}
                items={sites.map((x) => ({ key: x.key, label: <span dir="auto">{x.label}</span>, value: x.stats?.medianWordCount ?? null, highlight: x.mine }))}
              />
            </div>
            <div>
              <h4 className="small muted" style={{ marginBottom: 10 }}>
                {s.chart_links}
              </h4>
              <BarList
                locale={locale}
                format={(v) => decimal(v, locale, 1)}
                items={sites.map((x) => ({ key: x.key, label: <span dir="auto">{x.label}</span>, value: x.stats?.avgInternalLinks ?? null, highlight: x.mine }))}
              />
            </div>
          </div>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th />
                  {sites.map((x) => (
                    <th key={x.key} className={x.mine ? "mine" : undefined} style={{ textAlign: "end" }}>
                      <span dir="auto" style={{ textTransform: "none" }} translate={x.mine ? undefined : "no"}>
                        {x.label}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td className="muted">{r.label}</td>
                    {sites.map((x) => (
                      <td key={x.key} className={`tnum${x.mine ? " mine" : ""}`}>
                        {x.stats ? r.value(x.stats) : <span className="muted small">{s.not_sampled}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function PagesTable({ ctx, s, c, competitor }: { ctx: CompetitorsCtx; s: CompetitorStrings; c: CommonStrings; competitor: Competitor }) {
  const { locale } = ctx;
  const data = useLoad<{ pages: Snapshot[] }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/competitors/${encodeURIComponent(competitor.id)}`, locale);
  if (!data.data) return data.error ? <Flash tone="crit">{data.error}</Flash> : <Loading label={c.loading} />;
  if (!data.data.pages.length) return <p className="muted small">{s.no_pages}</p>;
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            <th>{s.col_url}</th>
            <th>{s.col_status}</th>
            <th>{s.col_title}</th>
            <th style={{ textAlign: "end" }}>{s.col_words}</th>
            <th>{s.col_schema}</th>
          </tr>
        </thead>
        <tbody>
          {data.data.pages.map((p) => (
            <tr key={p.id}>
              <td style={{ maxWidth: 220 }}>
                <a className="path" dir="ltr" href={p.url} target="_blank" rel="noreferrer">
                  {pathOf(p.url)}
                </a>
              </td>
              <td>
                <span className={`pill ${p.statusCode === 200 ? "ok" : "crit"}`}>{num(p.statusCode, locale)}</span>
              </td>
              <td style={{ maxWidth: 280 }}>
                <span translate="no" dir="auto">
                  {p.title ?? "—"}
                </span>
              </td>
              <td className="tnum">{num(p.wordCount, locale)}</td>
              <td>
                {p.schemaTypes.length ? (
                  <span className="row" style={{ gap: 4 }}>
                    {p.schemaTypes.map((t) => (
                      <code key={t} className="inline-code">
                        {t}
                      </code>
                    ))}
                  </span>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DfsMissing({ ctx, c }: { ctx: CompetitorsCtx; c: CommonStrings }) {
  return (
    <NotConfigured
      title={c.nc_dfs_title}
      body={ctx.integrations ? c.nc_dfs_body : `${c.nc_dfs_body} ${c.nc_dfs_ask_admin}`}
      action={ctx.integrations ? c.nc_dfs_action : null}
      href={ctx.integrations}
      icon="key"
    />
  );
}

function CompetitorPicker({ value, onChange, competitors, s }: { value: string; onChange: (v: string) => void; competitors: Competitor[]; s: CompetitorStrings }) {
  return (
    <label className="field">
      {s.competitor}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{s.pick_competitor}</option>
        {competitors.map((co) => (
          <option key={co.id} value={co.id} translate="no">
            {co.domain}
          </option>
        ))}
      </select>
    </label>
  );
}

function GapCard({ ctx, s, c, competitors }: { ctx: CompetitorsCtx; s: CompetitorStrings; c: CommonStrings; competitors: Competitor[] }) {
  const { locale } = ctx;
  const [id, setId] = useState("");
  const [country, setCountry] = useState("IR");
  const [lang, setLang] = useState<"fa" | "en">(locale);
  const run = useAction(locale);
  const [result, setResult] = useState<GapResult | null>(null);

  async function go() {
    setResult(await run.run<GapResult>(`/api/projects/${encodeURIComponent(ctx.projectId)}/competitors/${encodeURIComponent(id)}/keyword-gap`, { body: { country, locale: lang } }));
  }

  const table = (items: Gap[]) =>
    items.length === 0 ? (
      <p className="muted small">{s.none_found}</p>
    ) : (
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>{s.col_keyword}</th>
              <th style={{ textAlign: "end" }}>{s.col_theirs}</th>
              <th style={{ textAlign: "end" }}>{s.col_ours}</th>
              <th style={{ textAlign: "end" }}>{s.col_volume}</th>
              <th style={{ textAlign: "end" }}>{s.col_kd}</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 100).map((g) => (
              <tr key={g.keyword}>
                <td>
                  <span translate="no" dir="auto">
                    {g.keyword}
                  </span>
                </td>
                <td className="tnum">{num(g.theirPosition, locale)}</td>
                <td className="tnum">{num(g.ourPosition, locale)}</td>
                <td className="tnum">{num(g.volume, locale)}</td>
                <td className="tnum">{num(g.difficulty, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <Card title={s.gap_title} right={<SourceBadge source="dataforseo" c={c} />}>
      <div className="stack">
        <p className="hint">{s.gap_help}</p>
        {!ctx.dataforseo ? (
          <DfsMissing ctx={ctx} c={c} />
        ) : competitors.length === 0 ? (
          <p className="muted small">{s.empty}</p>
        ) : (
          <>
            <div className="formgrid">
              <CompetitorPicker value={id} onChange={setId} competitors={competitors} s={s} />
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
            </div>
            <p className="hint">{c.paid_note}</p>
            {ctx.canWrite && (
              <div>
                <button type="button" className="btn" disabled={!id || run.busy} onClick={() => void go()}>
                  <Icon name="search" />
                  {run.busy ? c.loading : s.run_gap}
                </button>
              </div>
            )}
            {run.error && <Flash tone="crit">{run.error}</Flash>}
            {result && !result.configured && <DfsMissing ctx={ctx} c={c} />}
            {result?.configured && (
              <>
                <div className="row">
                  <span className="pill mute">{fmt(c.cost_usd, { n: decimal(result.cost, locale, 3) })}</span>
                  <span className="pill mute">{fmt(s.shared_n, { n: num(result.shared, locale) })}</span>
                </div>
                <h4>{s.missing}</h4>
                {table(result.missing)}
                <h4>{s.behind}</h4>
                {table(result.behind)}
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function BacklinksCard({ ctx, s, c, competitors }: { ctx: CompetitorsCtx; s: CompetitorStrings; c: CommonStrings; competitors: Competitor[] }) {
  const { locale } = ctx;
  const [id, setId] = useState("");
  const run = useAction(locale);
  const [result, setResult] = useState<BacklinkResult | null>(null);
  const domain = competitors.find((x) => x.id === id)?.domain ?? "";

  async function go() {
    setResult(await run.run<BacklinkResult>(`/api/projects/${encodeURIComponent(ctx.projectId)}/competitors/${encodeURIComponent(id)}/backlinks`));
  }

  return (
    <Card title={s.bl_title} right={<SourceBadge source="dataforseo" c={c} />}>
      <div className="stack">
        <p className="hint">{s.bl_help}</p>
        {!ctx.dataforseo ? (
          <DfsMissing ctx={ctx} c={c} />
        ) : competitors.length === 0 ? (
          <p className="muted small">{s.empty}</p>
        ) : (
          <>
            <CompetitorPicker value={id} onChange={setId} competitors={competitors} s={s} />
            <p className="hint">{c.paid_note}</p>
            {ctx.canWrite && (
              <div>
                <button type="button" className="btn" disabled={!id || run.busy} onClick={() => void go()}>
                  <Icon name="link" />
                  {run.busy ? c.loading : s.run_bl}
                </button>
              </div>
            )}
            {run.error && <Flash tone="crit">{run.error}</Flash>}
            {result && !result.configured && <DfsMissing ctx={ctx} c={c} />}
            {result?.configured && (
              <>
                <span className="pill mute">{fmt(c.cost_usd, { n: decimal(result.cost, locale, 3) })}</span>
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th />
                        <th className="mine">{s.ours}</th>
                        <th>
                          <span dir="ltr" style={{ textTransform: "none" }} translate="no">
                            {domain}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          [s.bl_backlinks, "backlinks"],
                          [s.bl_domains, "referringDomains"],
                          [s.bl_main, "referringMainDomains"],
                          [s.bl_broken, "brokenBacklinks"],
                          [s.bl_rank, "rank"],
                          [s.bl_spam, "spamScore"],
                        ] as const
                      ).map(([label, key]) => (
                        <tr key={key}>
                          <td className="muted">{label}</td>
                          <td className="tnum mine">{num(result.ours[key], locale)}</td>
                          <td className="tnum">{num(result.theirs[key], locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
