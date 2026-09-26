"use client";

import { ScoreGauge } from "../../../../components/charts";
import { Icon } from "../../../../components/icons";
import { SourceBadge } from "../../../../components/kit";
import { decimal, num, pathOf, pct } from "../../../../lib/format";
import { fmt } from "../../../../lib/dict";
import { LocText } from "../../../../components/loc-text";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { Locale } from "../../../../lib/i18n";
import type { ContentStrings } from "../strings";

type Pair = { fa: string; en: string };
type Fit = { chars: number; px: number; maxPx: number; truncated: boolean; preview: string };
export type Analysis = {
  score: number;
  lang: "fa" | "en";
  stats: {
    words: number;
    sentences: number;
    paragraphs: number;
    headings: Record<string, number>;
    links: { internal: number; external: number };
    images: { total: number; missingAlt: number };
  };
  keyword: null | {
    phrase: string;
    exact: number;
    variants: number;
    density: number;
    inMetaTitle: boolean;
    inTitle: boolean;
    inFirstParagraph: boolean;
    inUrl: boolean | null;
    inMetaDescription: boolean;
    inSubheadings: number;
  };
  serp: { title: Fit; description: Fit | null };
  readability: {
    fleschReadingEase: number | null;
    avgSentenceWords: number;
    longSentencePct: number;
    avgParagraphWords: number;
    longParagraphs: number;
    passivePct: number;
  };
  length: { words: number; benchmarkMedian: number | null; sample: Array<{ url: string; words: number; source: "gsc" | "tracked" | "competitor"; domain?: string }> };
  checks: Array<{ id: string; group: string; status: "pass" | "warn" | "fail" | "na"; weight: number; message: Pair }>;
  suggestions: {
    internalLinks: Array<{ url: string; title: string | null; anchor: string; source: string }>;
    relatedTerms: Array<{ term: string; impressions: number; clicks: number; present: boolean }> | null;
  };
  sources?: { gsc: boolean; crawl: boolean; competitors: number };
};

const GROUPS = ["keyword", "meta", "structure", "length", "readability", "links", "media", "terms"] as const;
const GROUP_KEY = {
  keyword: "g_keyword",
  meta: "g_meta",
  structure: "g_structure",
  length: "g_length",
  readability: "g_readability",
  links: "g_links",
  media: "g_media",
  terms: "g_terms",
} as const;
const STATUS_ICON = { pass: "check", warn: "alert", fail: "x", na: "info" } as const;

export function AnalysisPanel({
  a,
  s,
  c,
  locale,
  busy,
  url,
  baseUrl,
  onInsertLink,
  canWrite,
}: {
  a: Analysis;
  s: ContentStrings;
  c: CommonStrings;
  locale: Locale;
  busy: boolean;
  url: string | null;
  baseUrl: string;
  onInsertLink: (url: string, anchor: string) => void;
  canWrite: boolean;
}) {
  const shownUrl = url || baseUrl;
  const yes = (v: boolean | null) =>
    v === null ? <span className="muted">—</span> : v ? <Icon name="check" className="ok-ic" /> : <Icon name="x" className="bad-ic" />;
  return (
    <div className="stack">
      <section className="side-card">
        <header className="row" style={{ justifyContent: "space-between" }}>
          <h4>{s.score}</h4>
          {busy && (
            <span className="muted small row" style={{ gap: 6 }}>
              <span className="spin" aria-hidden="true" />
              {s.analyzing}
            </span>
          )}
        </header>
        <div className="gauge-wrap" style={{ justifyContent: "center" }}>
          <ScoreGauge score={a.score} label={s.score} locale={locale} />
        </div>
        <p className="hint">{s.score_help}</p>
        {a.sources && (
          <div className="row" style={{ gap: 6 }}>
            <span className={`pill ${a.sources.gsc ? "info" : "mute"}`}>{a.sources.gsc ? s.src_gsc_on : s.src_gsc_off}</span>
            <span className={`pill ${a.sources.crawl ? "info" : "mute"}`}>{a.sources.crawl ? s.src_crawl_on : s.src_crawl_off}</span>
            {a.sources.competitors > 0 && <span className="pill info">{fmt(s.src_comp, { n: num(a.sources.competitors, locale) })}</span>}
          </div>
        )}
      </section>

      <section className="side-card">
        <h4>{s.serp}</h4>
        <div className="serp" dir={a.lang === "fa" ? "rtl" : "ltr"} translate="no">
          <div className="serp-url" dir="ltr">
            {shownUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </div>
          <div className="serp-title">{a.serp.title.preview || "—"}</div>
          <div className="serp-desc">{a.serp.description ? a.serp.description.preview : <span className="muted">{s.serp_no_desc}</span>}</div>
        </div>
        <WidthBar label={fmt(s.serp_title_w, { px: num(a.serp.title.px, locale), max: num(a.serp.title.maxPx, locale) })} fit={a.serp.title} cut={s.serp_cut} />
        {a.serp.description && (
          <WidthBar label={fmt(s.serp_desc_w, { px: num(a.serp.description.px, locale), max: num(a.serp.description.maxPx, locale) })} fit={a.serp.description} cut={s.serp_cut} />
        )}
        <p className="hint">{s.serp_help}</p>
      </section>

      <section className="side-card">
        <h4>{c.details}</h4>
        {GROUPS.map((g) => {
          const items = a.checks.filter((x) => x.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="checkgroup">
              <h4>{s[GROUP_KEY[g]]}</h4>
              <ul className="checks">
                {items.map((x) => (
                  <li key={x.id} className={x.status}>
                    <Icon name={STATUS_ICON[x.status]} />
                    <span>
                      <LocText pair={x.message} locale={locale} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      <section className="side-card">
        <h4>{s.kw_stats}</h4>
        {!a.keyword ? (
          <p className="muted small">{s.no_keyword}</p>
        ) : (
          <dl className="kv compact">
            <dt>{s.kw_exact}</dt>
            <dd className="num">{num(a.keyword.exact, locale)}</dd>
            <dt>{s.kw_variants}</dt>
            <dd className="num">{num(a.keyword.variants, locale)}</dd>
            <dt>{s.kw_density}</dt>
            <dd className="num">{pct(a.keyword.density / 100, locale, 1)}</dd>
            <dt>{s.kw_in_title}</dt>
            <dd>{yes(a.keyword.inMetaTitle)}</dd>
            <dt>{s.kw_in_h1}</dt>
            <dd>{yes(a.keyword.inTitle)}</dd>
            <dt>{s.kw_in_first}</dt>
            <dd>{yes(a.keyword.inFirstParagraph)}</dd>
            <dt>{s.kw_in_meta}</dt>
            <dd>{yes(a.keyword.inMetaDescription)}</dd>
            <dt>{s.kw_in_url}</dt>
            <dd>{yes(a.keyword.inUrl)}</dd>
            <dt>{s.kw_in_sub}</dt>
            <dd className="num">{num(a.keyword.inSubheadings, locale)}</dd>
          </dl>
        )}
      </section>

      <section className="side-card">
        <h4>{s.readability}</h4>
        <dl className="kv compact">
          {a.readability.fleschReadingEase !== null && (
            <>
              <dt>{s.flesch}</dt>
              <dd className="num">{decimal(a.readability.fleschReadingEase, locale, 0)}</dd>
            </>
          )}
          <dt>{s.avg_sentence}</dt>
          <dd className="num">{decimal(a.readability.avgSentenceWords, locale, 1)}</dd>
          <dt>{s.long_sentences}</dt>
          <dd className="num">{pct(a.readability.longSentencePct / 100, locale, 0)}</dd>
          <dt>{s.avg_paragraph}</dt>
          <dd className="num">{decimal(a.readability.avgParagraphWords, locale, 0)}</dd>
          <dt>{s.long_paragraphs}</dt>
          <dd className="num">{num(a.readability.longParagraphs, locale)}</dd>
          <dt>{s.passive}</dt>
          <dd className="num">{pct(a.readability.passivePct / 100, locale, 0)}</dd>
        </dl>
      </section>

      <section className="side-card">
        <h4>{s.length}</h4>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b>{fmt(s.words_now, { n: num(a.length.words, locale) })}</b>
          {a.length.benchmarkMedian !== null && <span className="muted small">{fmt(s.words_median, { n: num(a.length.benchmarkMedian, locale) })}</span>}
        </div>
        {a.length.benchmarkMedian === null ? (
          <p className="hint">{s.no_benchmark}</p>
        ) : (
          <>
            <div className="bar" style={{ marginTop: 8 }}>
              <i style={{ width: `${Math.min(100, (a.length.words / Math.max(1, a.length.benchmarkMedian)) * 100)}%` }} />
            </div>
            <details style={{ marginTop: 8 }}>
              <summary className="small muted">{s.bench_sample}</summary>
              <ul className="plain">
                {a.length.sample.slice(0, 10).map((p) => (
                  <li key={p.url}>
                    <span className="url" dir="ltr">
                      {p.domain ? `${p.domain}${pathOf(p.url)}` : pathOf(p.url)}
                    </span>{" "}
                    <span className="muted small">
                      · {num(p.words, locale)} ·{" "}
                      {p.source === "competitor" ? s.bench_src_competitor : p.source === "tracked" ? s.bench_src_tracked : s.bench_src_gsc}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>

      <section className="side-card">
        <h4>{s.link_sugg}</h4>
        <p className="hint">{s.link_sugg_help}</p>
        {a.suggestions.internalLinks.length === 0 ? (
          <p className="muted small">{s.no_link_sugg}</p>
        ) : (
          <ul className="movers">
            {a.suggestions.internalLinks.slice(0, 8).map((l) => (
              <li key={l.url} style={{ alignItems: "flex-start" }}>
                <span className="ph" style={{ whiteSpace: "normal" }}>
                  <span translate="no" dir="auto" style={{ fontWeight: 500 }}>
                    {l.anchor}
                  </span>
                  <br />
                  <span className="path" dir="ltr">
                    {pathOf(l.url)}
                  </span>
                </span>
                {canWrite && (
                  <button type="button" className="btn ghost sm" onClick={() => onInsertLink(l.url, l.anchor)}>
                    <Icon name="link" />
                    {s.insert_link}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="side-card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h4>{s.terms}</h4>
          <SourceBadge source="gsc" c={c} />
        </div>
        {!a.suggestions.relatedTerms || a.suggestions.relatedTerms.length === 0 ? (
          <p className="muted small">{s.no_terms}</p>
        ) : (
          <>
            <p className="hint">{s.terms_help}</p>
            <ul className="chips">
              {a.suggestions.relatedTerms.slice(0, 30).map((t) => (
                <li key={t.term} className={t.present ? "on" : undefined} translate="no" dir="auto">
                  {t.term}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function WidthBar({ label, fit, cut }: { label: string; fit: Fit; cut: string }) {
  return (
    <div className="widthbar">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small muted">{label}</span>
        {fit.truncated && <span className="pill warn">{cut}</span>}
      </div>
      <div className="bar">
        <i style={{ width: `${Math.min(100, (fit.px / fit.maxPx) * 100)}%`, background: fit.truncated ? "var(--warn)" : undefined }} />
      </div>
    </div>
  );
}
