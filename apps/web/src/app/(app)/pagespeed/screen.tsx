"use client";

import { useCallback, useMemo, useState } from "react";
import { Card } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import {
  Flash,
  JobLine,
  LineChart,
  Loading,
  ScoreRing,
  Sheet,
  SourceBadge,
  useAction,
  useJob,
  useLoad,
  type JobView,
} from "../../../components/kit";
import { bytes, decimal, num, pathOf, relative, seconds, shortDate } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import { CWV_RATING, LIGHTHOUSE_AUDITS } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { Locale } from "../../../lib/i18n";
import type { PageSpeedStrings } from "./strings";

type Rating = "good" | "needs_improvement" | "poor" | null;
type Crux = { p75: number; category: string | null };
type Item = {
  url: string;
  strategy: "mobile" | "desktop";
  fetchedAt: string;
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  tbtMs: number | null;
  fieldData: { scope: "url" | "origin"; overall: string | null; lcpMs?: Crux; cls?: Crux; inpMs?: Crux; fcpMs?: Crux; ttfbMs?: Crux } | null;
  opportunities: Array<{ id: string; title: string; savingsMs: number | null; savingsBytes: number | null }>;
  cwv: { basis: "field" | "lab"; passed: boolean; lcp: Rating; inp: Rating; cls: Rating };
  scoreChange: number | null;
};
type Summary = {
  keySource: "org" | "env" | "none";
  lastRunAt: string | null;
  pages: Item[];
  totals: Record<"mobile" | "desktop", { pages: number; passed: number; failed: number; averageScore: number | null }>;
};
type HistoryRow = { url: string; strategy: "mobile" | "desktop"; fetchedAt: string; performanceScore: number | null; lcpMs: number | null };
type RunResult = { measured: number; failed: Array<{ url: string; strategy: string; reason: string; text: { fa: string; en: string } | null }> } | null;

export type PageSpeedCtx = { projectId: string; baseUrl: string; locale: Locale; canRun: boolean; integrations: string | null };

export function PageSpeedScreen({ ctx, s, c }: { ctx: PageSpeedCtx; s: PageSpeedStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/pagespeed`;
  const summary = useLoad<Summary>(base, locale);
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [jobUrl, setJobUrl] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "crit" | "warn" | "info"; text: string; failed?: NonNullable<RunResult>["failed"] } | null>(null);

  const onDone = useCallback(
    (job: JobView<RunResult>) => {
      setJobUrl(null);
      void summary.reload();
      if (job.state === "failed") return setResult({ tone: "crit", text: s.run_job_failed });
      const r = job.result;
      if (!r) return setResult({ tone: "ok", text: c.job_done });
      if (r.measured === 0 && r.failed.length) return setResult({ tone: "crit", text: s.run_all_failed, failed: r.failed });
      setResult({ tone: r.failed.length ? "warn" : "ok", text: fmt(s.run_done, { n: num(r.measured, locale) }), failed: r.failed });
    },
    [summary, s, c, locale],
  );
  const { job, timedOut } = useJob<RunResult>(jobUrl, onDone, 4000);

  const pages = useMemo(() => (summary.data?.pages ?? []).filter((p) => p.strategy === strategy), [summary.data, strategy]);
  const totals = summary.data?.totals[strategy];
  const knownUrls = useMemo(() => [...new Set((summary.data?.pages ?? []).map((p) => p.url))], [summary.data]);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <p className="desc" style={{ maxWidth: 760 }}>
          {s.intro}
        </p>
        {ctx.canRun && (
          <div className="row">
            {jobUrl && <JobLine state={job?.state} c={c} />}
            <button type="button" className="btn primary" disabled={Boolean(jobUrl)} onClick={() => setRunOpen(true)}>
              <Icon name="gauge" />
              {jobUrl ? s.running : s.run}
            </button>
          </div>
        )}
      </div>

      {summary.data && (
        <div className="note">
          <Icon name="key" />
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span>{summary.data.keySource === "org" ? s.key_org : summary.data.keySource === "env" ? s.key_env : s.key_none}</span>
            {summary.data.keySource === "none" && ctx.integrations && (
              <a className="btn ghost sm" href={ctx.integrations}>
                {c.nc_dfs_action}
              </a>
            )}
          </div>
        </div>
      )}
      {result && (
        <Flash tone={result.tone}>
          <div>{result.text}</div>
          {result.failed && result.failed.length > 0 && (
            <>
              <div style={{ marginTop: 6 }}>{s.run_failed_pages}</div>
              <ul className="plain">
                {groupFailures(result.failed).map((g) => (
                  <li key={g.reason}>
                    {g.items[0]!.text?.[locale] ?? c.unknown} ({num(g.items.length, locale)})
                    <details>
                      <summary className="small">{c.details}</summary>
                      {g.items.map((f, i) => (
                        <div key={i} className="small">
                          <span className="url" dir="ltr">
                            {pathOf(f.url)}
                          </span>{" "}
                          ({f.strategy === "mobile" ? s.mobile : s.desktop})
                        </div>
                      ))}
                    </details>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Flash>
      )}
      {timedOut && <Flash tone="info">{c.job_slow}</Flash>}

      {!summary.data ? (
        summary.error ? <Flash tone="crit">{summary.error}</Flash> : <Loading label={c.loading} rows={6} />
      ) : summary.data.pages.length === 0 ? (
        <Card title={s.col_cwv}>
          <div className="empty">
            <Icon name="gauge" />
            <div style={{ maxWidth: 520 }}>{s.empty}</div>
            {ctx.canRun && !jobUrl && (
              <button type="button" className="btn primary" onClick={() => setRunOpen(true)}>
                <Icon name="play" />
                {s.run}
              </button>
            )}
          </div>
        </Card>
      ) : (
        <>
          <div className="row">
            <div className="seg" role="group" aria-label={s.strategy}>
              <button type="button" aria-pressed={strategy === "mobile"} onClick={() => setStrategy("mobile")}>
                {s.mobile}
              </button>
              <button type="button" aria-pressed={strategy === "desktop"} onClick={() => setStrategy("desktop")}>
                {s.desktop}
              </button>
            </div>
            <SourceBadge source="psi" c={c} />
          </div>
          <div className="statgrid">
            <div className="stat">
              <span className="k">{s.avg_score}</span>
              <span className="row">
                <ScoreRing score={totals?.averageScore ?? null} locale={locale} label={s.avg_score} size={48} />
                <span className="muted small">{fmt(s.pages_n, { n: num(totals?.pages ?? 0, locale) })}</span>
              </span>
            </div>
            <div className="stat">
              <span className="k">{s.passed}</span>
              <span className="v" style={{ color: "var(--ok)" }}>
                {num(totals?.passed ?? 0, locale)}
              </span>
            </div>
            <div className="stat">
              <span className="k">{s.failed}</span>
              <span className="v" style={{ color: totals?.failed ? "var(--crit)" : undefined }}>
                {num(totals?.failed ?? 0, locale)}
              </span>
            </div>
            <div className="stat">
              <span className="k">{s.last_run}</span>
              <span className="v" style={{ fontSize: 16 }}>
                {relative(summary.data.lastRunAt, locale)}
              </span>
            </div>
          </div>

          <Card title={s.col_cwv} sub={s.basis_help} bare>
            {pages.length === 0 ? (
              <div className="empty">
                <Icon name="gauge" />
                <div>{s.empty_strategy}</div>
              </div>
            ) : (
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>{s.col_page}</th>
                      <th>{s.col_score}</th>
                      <th>{s.col_cwv}</th>
                      <th>LCP</th>
                      <th>INP</th>
                      <th>CLS</th>
                      <th>{s.col_basis}</th>
                      <th>{s.col_when}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((p) => (
                      <tr key={p.url} className="clickable" onClick={() => setOpenUrl(p.url)}>
                        <td style={{ maxWidth: 280 }}>
                          <button type="button" className="lnk-plain path" dir="ltr" onClick={() => setOpenUrl(p.url)}>
                            {pathOf(p.url)}
                          </button>
                        </td>
                        <td>
                          <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                            <ScoreRing score={p.performanceScore} locale={locale} label={s.col_score} size={36} />
                            {p.scoreChange !== null && p.scoreChange !== 0 && (
                              <span className={`delta ${p.scoreChange > 0 ? "up" : "down"}`} title={s.change}>
                                <Icon name={p.scoreChange > 0 ? "up" : "down"} />
                                {num(Math.abs(p.scoreChange), locale)}
                              </span>
                            )}
                          </span>
                        </td>
                        <td>
                          <span className={`pill ${p.cwv.passed ? "ok" : "crit"}`}>
                            <Icon name={p.cwv.passed ? "check" : "x"} />
                            {p.cwv.passed ? s.pass : s.fail}
                          </span>
                        </td>
                        <td>
                          <Metric value={seconds(fieldOr(p, "lcpMs"), locale)} rating={p.cwv.lcp} locale={locale} />
                        </td>
                        <td>
                          <Metric value={p.fieldData?.inpMs ? `${num(Math.round(p.fieldData.inpMs.p75), locale)} ${locale === "fa" ? "میلی‌ثانیه" : "ms"}` : "—"} rating={p.cwv.inp} locale={locale} />
                        </td>
                        <td>
                          <Metric value={decimal(fieldOr(p, "cls"), locale, 2)} rating={p.cwv.cls} locale={locale} />
                        </td>
                        <td>
                          <BasisBadge item={p} s={s} c={c} />
                        </td>
                        <td className="muted small">{relative(p.fetchedAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <RunDialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        ctx={ctx}
        s={s}
        c={c}
        knownUrls={knownUrls}
        onStarted={(jobId, deduplicated) => {
          setRunOpen(false);
          setResult({ tone: "info", text: deduplicated ? c.job_deduplicated : s.run_started });
          setJobUrl(`/api/projects/${encodeURIComponent(ctx.projectId)}/jobs/${encodeURIComponent(jobId)}`);
        }}
      />

      <Sheet open={Boolean(openUrl)} onClose={() => setOpenUrl(null)} closeLabel={c.close} title={<span className="url" dir="ltr">{openUrl ? pathOf(openUrl) : ""}</span>}>
        {openUrl && summary.data && <PageDetail url={openUrl} items={summary.data.pages.filter((p) => p.url === openUrl)} ctx={ctx} s={s} c={c} />}
      </Sheet>
    </>
  );
}

/** Field (real users) when Google has it, else the lab value — the same basis the pass/fail used. */
function fieldOr(p: Item, key: "lcpMs" | "cls"): number | null {
  if (p.cwv.basis === "field") return p.fieldData?.[key]?.p75 ?? null;
  return p[key];
}

function Metric({ value, rating, locale }: { value: string; rating: Rating; locale: Locale }) {
  const r = rating ? CWV_RATING[rating] : null;
  return (
    <span className={`cwv ${r?.tone ?? "none"}`} title={r ? r[locale] : undefined}>
      <i aria-hidden="true" />
      <span className="num">{value}</span>
      {r && <span className="sr-only">{r[locale]}</span>}
    </span>
  );
}

function BasisBadge({ item, s, c }: { item: Item; s: PageSpeedStrings; c: CommonStrings }) {
  if (item.cwv.basis === "field") {
    return (
      <span className="pill ok" title={s.basis_help}>
        {item.fieldData?.scope === "origin" ? s.basis_field_origin : s.basis_field_url}
      </span>
    );
  }
  return (
    <span className="pill mute" title={s.basis_help}>
      {c.src_lab} — {s.basis_lab}
    </span>
  );
}

function PageDetail({ url, items, ctx, s, c }: { url: string; items: Item[]; ctx: PageSpeedCtx; s: PageSpeedStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const history = useLoad<{ items: HistoryRow[] }>(
    `/api/projects/${encodeURIComponent(ctx.projectId)}/pagespeed/history?url=${encodeURIComponent(url)}`,
    locale,
  );
  const rows = history.data?.items ?? [];
  const byStrategy = (st: "mobile" | "desktop") => rows.filter((r) => r.strategy === st);
  const enough = byStrategy("mobile").length > 1 || byStrategy("desktop").length > 1;
  const series = (key: "performanceScore" | "lcpMs") =>
    (["mobile", "desktop"] as const)
      .filter((st) => byStrategy(st).length)
      .map((st, i) => ({
        key: st,
        label: st === "mobile" ? s.mobile : s.desktop,
        color: i === 0 ? "#2BE08A" : "#5BB8F5",
        points: byStrategy(st).map((r) => ({ x: r.fetchedAt, y: key === "lcpMs" && r.lcpMs !== null ? r.lcpMs / 1000 : r[key] })),
      }));

  return (
    <>
      <div className="row">
        <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">
          <Icon name="external" />
          {c.open}
        </a>
        <a
          className="btn ghost sm"
          href={`https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}`}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="gauge" />
          {s.open_psi}
        </a>
      </div>

      <section className="stack">
        <h4>{s.trend}</h4>
        {!history.data ? (
          history.error ? <Flash tone="crit">{history.error}</Flash> : <Loading label={c.loading} />
        ) : !enough ? (
          <p className="muted small">{s.no_trend}</p>
        ) : (
          <>
            <LineChart locale={locale} ariaLabel={s.trend} height={170} yMin={0} yMax={100} series={series("performanceScore")} formatX={(x) => shortDate(x, locale)} />
            <h4>{s.trend_lcp}</h4>
            <LineChart
              locale={locale}
              ariaLabel={s.trend_lcp}
              height={150}
              yMin={0}
              series={series("lcpMs")}
              formatX={(x) => shortDate(x, locale)}
              formatY={(v) => decimal(v, locale, 1)}
            />
          </>
        )}
      </section>

      {items.map((p) => (
        <section key={p.strategy} className="stack">
          <div className="row">
            <h4>{p.strategy === "mobile" ? s.mobile : s.desktop}</h4>
            <ScoreRing score={p.performanceScore} locale={locale} label={s.col_score} size={36} />
            <span className={`pill ${p.cwv.passed ? "ok" : "crit"}`}>
              <Icon name={p.cwv.passed ? "check" : "x"} />
              {p.cwv.passed ? s.pass : s.fail}
            </span>
            <BasisBadge item={p} s={s} c={c} />
          </div>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{s.metric}</th>
                  <th>{s.field}</th>
                  <th>{s.lab}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["lcp", "lcpMs", p.lcpMs, "ms", p.cwv.lcp],
                    ["inp", "inpMs", null, "ms", p.cwv.inp],
                    ["cls", "cls", p.cls, "", p.cwv.cls],
                    ["fcp", "fcpMs", p.fcpMs, "ms", null],
                    ["ttfb", "ttfbMs", p.ttfbMs, "ms", null],
                    ["tbt", null, p.tbtMs, "ms", null],
                  ] as const
                ).map(([label, fieldKey, lab, unit, rating]) => {
                  const field = fieldKey ? p.fieldData?.[fieldKey] : undefined;
                  const show = (v: number | null | undefined) => (v === null || v === undefined ? "—" : unit === "ms" ? seconds(v, locale) : decimal(v, locale, 2));
                  return (
                    <tr key={label}>
                      <td>
                        <b dir="ltr">{label.toUpperCase()}</b> <span className="muted small">{s[label]}</span>
                      </td>
                      <td>{field ? <Metric value={show(field.p75)} rating={p.cwv.basis === "field" ? rating : null} locale={locale} /> : "—"}</td>
                      <td>{lab === null ? "—" : <Metric value={show(lab)} rating={p.cwv.basis === "lab" ? rating : null} locale={locale} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div>
            <h4 style={{ marginBottom: 6 }}>{s.opportunities}</h4>
            {p.opportunities.length === 0 ? (
              <p className="muted small">{s.no_opportunities}</p>
            ) : (
              <>
                <p className="hint" style={{ marginBottom: 6 }}>
                  {s.opportunities_help}
                </p>
                <ul className="movers">
                  {p.opportunities.map((o) => {
                    const label = LIGHTHOUSE_AUDITS[o.id]?.[locale];
                    return (
                      <li key={o.id}>
                        <span className="ph" style={{ whiteSpace: "normal" }}>
                          {label ?? (
                            <>
                              {s.unknown_audit} <code className="inline-code">{o.id}</code>
                            </>
                          )}
                        </span>
                        <span className="pos">
                          {o.savingsMs
                            ? fmt(s.saves_ms, { v: seconds(o.savingsMs, locale) })
                            : o.savingsBytes
                              ? fmt(s.saves_bytes, { v: bytes(o.savingsBytes, locale) })
                              : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

function RunDialog({
  open,
  onClose,
  ctx,
  s,
  c,
  knownUrls,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  ctx: PageSpeedCtx;
  s: PageSpeedStrings;
  c: CommonStrings;
  knownUrls: string[];
  onStarted: (jobId: string, deduplicated: boolean) => void;
}) {
  const { locale } = ctx;
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [chosen, setChosen] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const run = useAction(locale);
  const host = hostOf(ctx.baseUrl);

  function addDraft() {
    setDraftError(null);
    let u: URL;
    try {
      u = new URL(draft.trim(), ctx.baseUrl);
    } catch {
      return setDraftError(s.url_not_on_site);
    }
    if (hostOf(u.toString()) !== host) return setDraftError(s.url_not_on_site);
    if (chosen.length >= 10) return setDraftError(s.url_limit);
    setChosen((prev) => [...new Set([...prev, u.toString()])]);
    setDraft("");
  }

  async function start() {
    const r = await run.run<{ jobId: string; deduplicated: boolean }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/pagespeed`, {
      body: mode === "custom" ? { urls: chosen } : {},
    });
    if (r) onStarted(r.jobId, r.deduplicated);
  }

  return (
    <Sheet open={open} onClose={onClose} title={s.run_title} closeLabel={c.close} size="narrow">
      <div className="radios">
        <label className={`radio ${mode === "default" ? "on" : "off"}`}>
          <input type="radio" name="psi-mode" checked={mode === "default"} onChange={() => setMode("default")} />
          <span>
            <b>{s.run_default}</b>
            <small>{s.run_default_help}</small>
          </span>
        </label>
        <label className={`radio ${mode === "custom" ? "on" : "off"}`}>
          <input type="radio" name="psi-mode" checked={mode === "custom"} onChange={() => setMode("custom")} />
          <span>
            <b>{s.run_custom}</b>
            <small>{s.run_custom_help}</small>
          </span>
        </label>
      </div>
      {mode === "custom" && (
        <div className="stack">
          {knownUrls.length > 0 && (
            <div className="chips-pick">
              {knownUrls.map((u) => (
                <label key={u} className="pick">
                  <input
                    type="checkbox"
                    checked={chosen.includes(u)}
                    onChange={(e) => setChosen((prev) => (e.target.checked ? [...prev, u].slice(0, 10) : prev.filter((x) => x !== u)))}
                  />
                  <span className="url" dir="ltr">
                    {pathOf(u)}
                  </span>
                </label>
              ))}
            </div>
          )}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              addDraft();
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={s.url_placeholder} aria-label={s.url_placeholder} dir="ltr" style={{ flex: "1 1 220px", width: "auto" }} />
            <button type="submit" className="btn" disabled={!draft.trim()}>
              <Icon name="plus" />
              {s.add_url}
            </button>
          </form>
          {draftError && <Flash tone="crit">{draftError}</Flash>}
          {chosen.filter((u) => !knownUrls.includes(u)).length > 0 && (
            <ul className="plain">
              {chosen
                .filter((u) => !knownUrls.includes(u))
                .map((u) => (
                  <li key={u} className="row">
                    <span className="url" dir="ltr">
                      {u}
                    </span>
                    <button type="button" className="btn ghost sm" onClick={() => setChosen((prev) => prev.filter((x) => x !== u))} aria-label={c.remove}>
                      <Icon name="x" />
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      {run.error && <Flash tone="crit">{run.error}</Flash>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn ghost" onClick={onClose}>
          {c.cancel}
        </button>
        <button type="button" className="btn primary" disabled={run.busy || (mode === "custom" && chosen.length === 0)} onClick={() => void start()}>
          <Icon name="play" />
          {run.busy ? c.loading : s.start}
        </button>
      </div>
    </Sheet>
  );
}

/** One line per failure reason: a blocked quota fails every page the same way. */
function groupFailures(failed: NonNullable<RunResult>["failed"]) {
  const groups = new Map<string, NonNullable<RunResult>["failed"]>();
  for (const f of failed) groups.set(f.reason, [...(groups.get(f.reason) ?? []), f]);
  return [...groups.entries()].map(([reason, items]) => ({ reason, items }));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
