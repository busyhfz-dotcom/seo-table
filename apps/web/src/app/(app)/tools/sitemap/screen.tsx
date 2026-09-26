"use client";

import { useState } from "react";
import { Card } from "../../../../components/ui";
import { Icon } from "../../../../components/icons";
import { Flash, Loading, NotConfigured, SourceBadge, useAction, useLoad } from "../../../../components/kit";
import { callApi, apiErrorMessage } from "../../../../lib/errors-ui";
import { bytes, num, pathOf, relative } from "../../../../lib/format";
import { fmt } from "../../../../lib/dict";
import { SITEMAP_PROBLEMS, SITEMAP_SOURCE_KIND } from "../../../../lib/seo-labels";
import { LocText } from "../../../../components/loc-text";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { Locale } from "../../../../lib/i18n";
import type { ToolStrings } from "../strings";
import { ApplyResult, TargetNote, type ApplyTarget, type Proposal } from "../shared";

type Generated = {
  status: "ok" | "no_scan";
  scannedAt: string | null;
  files: Array<{ path: string; urls: number; bytes: number }>;
  urls: number;
  withLastmod: number;
  images: number;
  excluded: Record<string, number>;
  apply: ApplyTarget;
};
type Validation = {
  sources: Array<{ url: string; status: number | null; kind: "urlset" | "index" | "invalid" | "unreachable"; urls: number }>;
  urls: number;
  truncated: boolean;
  issues: Array<{ code: string; level: "error" | "warning" | "info"; message: { fa: string; en: string }; count?: number }>;
  problems: Record<string, number>;
  examples: Array<{ url: string; problem: string; status: number | null; detail: string | null }>;
};

export type SitemapCtx = {
  projectId: string;
  baseUrl: string;
  locale: Locale;
  canPropose: boolean;
  canSubmit: boolean;
  gsc: boolean;
  links: { fixes: string; approvals: string; connect: string; audit: string; connectGsc: string };
};

export function SitemapScreen({ ctx, s, c }: { ctx: SitemapCtx; s: ToolStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/sitemap`;
  const [images, setImages] = useState(false);
  const gen = useLoad<Generated>(`${base}${images ? "?images=1" : ""}`, locale);
  const [applied, setApplied] = useState<{ proposal: Proposal; target: ApplyTarget } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [applying, setApplying] = useState(false);
  const submit = useAction(locale);
  const [submitUrl, setSubmitUrl] = useState(`${ctx.baseUrl.replace(/\/$/, "")}/sitemap.xml`);
  const [submitted, setSubmitted] = useState<string | null>(null);

  async function apply() {
    setApplyError(null);
    setManual(false);
    setApplying(true);
    const r = await callApi<{ proposal: Proposal; target: ApplyTarget }>(`${base}/apply`, { method: "POST", body: { images } });
    setApplying(false);
    if (r.ok) setApplied(r.data);
    else if (r.failure.status === 409 && r.failure.details?.manual) setManual(true);
    else setApplyError(apiErrorMessage(locale, r.failure));
  }

  async function doSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(null);
    const r = await submit.run<{ ok: true; sitemapUrl: string } | { ok: false; message: string }>(`${base}/submit`, { body: { sitemapUrl: submitUrl.trim() } });
    if (!r) return;
    if (r.ok) setSubmitted(s.sm_submitted);
    else submit.setError(r.message);
  }

  const g = gen.data;
  return (
    <>
      {!g ? (
        gen.error ? (
          <Flash tone="crit">{gen.error}</Flash>
        ) : (
          <Loading label={c.loading} rows={5} />
        )
      ) : g.status === "no_scan" ? (
        <NotConfigured title={c.no_scan_title} body={c.no_scan_body} action={c.go_audit} href={ctx.links.audit} icon="pulse" />
      ) : (
        <div className="split">
          <Card
            title={s.sm_generated}
            sub={g.scannedAt ? fmt(s.il_scanned, { when: relative(g.scannedAt, locale) }) : undefined}
            right={
              <label className="pick">
                <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />
                {s.sm_images}
              </label>
            }
          >
            <div className="stack">
              <p className="hint">{s.sm_generated_help}</p>
              <div className="statgrid">
                <div className="stat">
                  <span className="k">{s.sm_urls}</span>
                  <span className="v">{num(g.urls, locale)}</span>
                </div>
                <div className="stat">
                  <span className="k">{s.sm_lastmod}</span>
                  <span className="v">{num(g.withLastmod, locale)}</span>
                </div>
                {images && (
                  <div className="stat">
                    <span className="k">{s.sm_image_n}</span>
                    <span className="v">{num(g.images, locale)}</span>
                  </div>
                )}
              </div>
              <h4>{s.sm_files}</h4>
              <ul className="movers">
                {g.files.map((f) => (
                  <li key={f.path}>
                    <span className="ph url" dir="ltr">
                      {f.path}
                    </span>
                    <span className="pos">
                      {num(f.urls, locale)} {s.sm_urls} · {bytes(f.bytes, locale)}
                    </span>
                    <a className="btn ghost sm" href={`${base}/file?path=${encodeURIComponent(f.path)}${images ? "&images=1" : ""}`}>
                      <Icon name="dl" />
                      {c.download}
                    </a>
                  </li>
                ))}
              </ul>
              {Object.keys(g.excluded).length > 0 && (
                <>
                  <h4>{s.sm_excluded}</h4>
                  <ul className="chips">
                    {Object.entries(g.excluded).map(([reason, n]) => (
                      <li key={reason}>
                        {SITEMAP_PROBLEMS[reason]?.[locale] ?? reason}: {num(n, locale)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
          <div className="stack">
            <Card title={s.apply_title}>
              <div className="stack">
                <p className="hint">{s.apply_help}</p>
                <TargetNote target={g.apply} s={s} c={c} connectHref={ctx.links.connect} />
                {ctx.canPropose ? (
                  <div>
                    <button type="button" className="btn primary" disabled={applying || !g.apply.supported || g.urls === 0} onClick={() => void apply()}>
                      <Icon name="wand" />
                      {s.propose}
                    </button>
                  </div>
                ) : (
                  <p className="muted small">{c.read_only}</p>
                )}
                {applyError && <Flash tone="crit">{applyError}</Flash>}
                {manual && <Flash tone="warn">{c.manual_only}</Flash>}
                {applied && <ApplyResult proposal={applied.proposal} target={applied.target} links={ctx.links} s={s} c={c} />}
              </div>
            </Card>
            <Card title={s.sm_submit} right={<SourceBadge source="gsc" c={c} />}>
              {!ctx.gsc ? (
                <NotConfigured title={c.nc_gsc_title} body={s.sm_needs_gsc} action={c.nc_gsc_action} href={ctx.links.connectGsc} />
              ) : !ctx.canSubmit ? (
                <p className="muted small">{c.read_only}</p>
              ) : (
                <form className="stack" onSubmit={doSubmit}>
                  <label className="field">
                    {s.sm_submit_url}
                    <input value={submitUrl} onChange={(e) => setSubmitUrl(e.target.value)} dir="ltr" required />
                  </label>
                  <div>
                    <button type="submit" className="btn" disabled={submit.busy}>
                      <Icon name="send" />
                      {submit.busy ? c.loading : s.sm_submit}
                    </button>
                  </div>
                  {submit.error && <Flash tone="crit">{submit.error}</Flash>}
                  {submitted && <Flash tone="ok">{submitted}</Flash>}
                </form>
              )}
            </Card>
          </div>
        </div>
      )}
      <Validator ctx={ctx} s={s} c={c} />
    </>
  );
}

function Validator({ ctx, s, c }: { ctx: SitemapCtx; s: ToolStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const [url, setUrl] = useState("");
  const act = useAction(locale);
  const [result, setResult] = useState<Validation | null>(null);
  async function run(e: React.FormEvent) {
    e.preventDefault();
    let target: string | undefined;
    try {
      target = url.trim() ? new URL(url.trim(), ctx.baseUrl).toString() : undefined;
    } catch {
      target = undefined;
    }
    setResult(await act.run<Validation>(`/api/projects/${encodeURIComponent(ctx.projectId)}/sitemap/validate`, { body: target ? { url: target } : {} }));
  }
  const problems = result ? Object.entries(result.problems).filter(([, n]) => n > 0) : [];
  return (
    <Card title={s.sm_validate}>
      <div className="stack">
        <p className="hint">{s.sm_validate_help}</p>
        <form className="row" onSubmit={run}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" placeholder={s.sm_validate_url} aria-label={s.sm_validate_url} style={{ flex: "1 1 260px", width: "auto" }} />
          <button type="submit" className="btn primary" disabled={act.busy}>
            {act.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="check" />}
            {act.busy ? c.loading : s.sm_validate_run}
          </button>
        </form>
        {act.error && <Flash tone="crit">{act.error}</Flash>}
        {result && (
          <>
            <h4>{s.sm_sources}</h4>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>{c.url}</th>
                    <th>{s.sm_kind}</th>
                    <th style={{ textAlign: "end" }}>{s.sm_urls}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sources.map((x) => (
                    <tr key={x.url}>
                      <td className="path" dir="ltr">
                        {x.url}
                      </td>
                      <td>
                        <span className={`pill ${x.kind === "invalid" || x.kind === "unreachable" ? "crit" : "mute"}`}>{SITEMAP_SOURCE_KIND[x.kind]?.[locale] ?? x.kind}</span>
                        {x.status !== null && x.status !== 200 && <span className="muted small"> ({num(x.status, locale)})</span>}
                      </td>
                      <td className="tnum">{num(x.urls, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">
              {fmt(s.sm_listed, { n: num(result.urls, locale) })}
              {result.truncated && ` · ${s.sm_truncated}`}
            </p>
            {result.issues.length > 0 && (
              <ul className="checks">
                {result.issues.map((x, i) => (
                  <li key={i} className={x.level === "error" ? "fail" : x.level === "warning" ? "warn" : "na"}>
                    <Icon name={x.level === "error" ? "x" : x.level === "warning" ? "alert" : "info"} />
                    <span>
                      <LocText pair={x.message} locale={locale} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <h4>{s.sm_problems}</h4>
            {problems.length === 0 ? (
              <p className="small" style={{ color: "var(--ok)" }}>
                <Icon name="check" /> {s.sm_no_problems}
              </p>
            ) : (
              <>
                <ul className="chips">
                  {problems.map(([k, n]) => (
                    <li key={k}>
                      {SITEMAP_PROBLEMS[k]?.[locale] ?? k}: {num(n, locale)}
                    </li>
                  ))}
                </ul>
                <h4>{s.sm_examples}</h4>
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th>{c.url}</th>
                        <th>{s.sm_status}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.examples.slice(0, 100).map((x, i) => (
                        <tr key={i}>
                          <td className="path" dir="ltr">
                            {pathOf(x.url)}
                          </td>
                          <td>
                            <span className="pill warn">{SITEMAP_PROBLEMS[x.problem]?.[locale] ?? x.problem}</span>
                            {x.status !== null && <span className="muted small"> {num(x.status, locale)}</span>}
                          </td>
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
