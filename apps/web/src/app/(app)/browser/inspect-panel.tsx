"use client";

/**
 * What a crawler gets from the page on screen: POST /api/browser/render renders
 * it in a fresh browser, reads the SEO fields from the rendered DOM, and
 * compares them with the raw HTML so JavaScript-only content stands out.
 */
import { useState } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { decimal, num } from "../../../lib/format";
import type { Locale } from "../../../lib/i18n";
import type { BrowserStrings } from "./keys";
import styles from "./browser.module.css";

export type RenderResult = {
  url: string;
  finalUrl: string;
  status: number | null;
  timedOut: boolean;
  screenshot: string;
  seo: {
    title: string | null;
    description: string | null;
    canonical: string | null;
    robots: string | null;
    h1: string[];
    hreflang: Array<{ lang: string; href: string }>;
    jsonld: string[];
    links: { internal: number; external: number };
    lang: string | null;
    wordCount: number;
    imagesMissingAlt: number;
  };
  console: Array<{ type: "error" | "exception"; text: string; source?: string }>;
  metrics: { lcpMs?: number; cls?: number; ttfbMs?: number };
  renderedVsRaw: {
    available: boolean;
    titleDiffers: boolean;
    descriptionDiffers: boolean;
    canonicalDiffers: boolean;
    robotsDiffers: boolean;
    h1Differs: boolean;
    linksOnlyInRendered: number;
  };
  blockedRequests: number;
};

type Tone = "ok" | "warn" | "crit";

/** Google's Core Web Vitals thresholds (good / needs improvement / poor). */
function tone(value: number, good: number, poor: number): Tone {
  return value <= good ? "ok" : value <= poor ? "warn" : "crit";
}

export function InspectPanel({
  locale,
  s,
  target,
  device,
  errorOverrides,
}: {
  locale: Locale;
  s: BrowserStrings;
  /** The address to inspect: the live page's, or what is in the address bar. */
  target: string;
  device: "desktop" | "mobile";
  errorOverrides: Parameters<typeof apiErrorMessage>[2];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RenderResult | null>(null);

  async function run() {
    if (!target) return;
    setBusy(true);
    setError(null);
    const res = await callApi<RenderResult>("/api/browser/render", { method: "POST", body: { url: target, device } });
    setBusy(false);
    if (!res.ok) {
      setError(apiErrorMessage(locale, res.failure, errorOverrides));
      return;
    }
    setResult(res.data);
  }

  const n = (value: number) => num(value, locale);
  const toneLabel = { ok: s.br_good, warn: s.br_needs_work, crit: s.br_poor };

  return (
    <aside className={`card ${styles.inspect}`} aria-busy={busy}>
      <header>
        <h3>{s.br_inspect}</h3>
        <span className="spacer" />
        <button className="btn sm primary" onClick={run} disabled={busy || !target}>
          <Icon name="search" />
          {result ? s.br_inspect_again : s.br_inspect_run}
        </button>
      </header>
      <div className={styles.inspectBody}>
        {!result && !busy && !error && <p className={styles.muted}>{s.br_inspect_hint}</p>}
        {busy && (
          <div className={styles.inspectBusy} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            {s.br_inspect_running}
          </div>
        )}
        {error && (
          <div className="note crit" role="alert">
            <Icon name="alert" />
            <div>{error}</div>
          </div>
        )}
        {result && !busy && (
          <>
            <dl className="kv">
              <dt>{s.br_inspected_url}</dt>
              <dd dir="ltr" className={styles.url}>
                {result.finalUrl}
              </dd>
              <dt>{s.br_http_status}</dt>
              <dd>
                <span className={`pill ${result.status && result.status < 400 ? "ok" : "crit"}`}>
                  {result.status === null ? "—" : n(result.status)}
                </span>
              </dd>
            </dl>
            {result.timedOut && (
              <div className="note">
                <Icon name="clock" />
                <div>{s.br_timed_out}</div>
              </div>
            )}
            {result.blockedRequests > 0 && (
              <div className="note lock">
                <Icon name="shield" />
                <div>{s.br_blocked_requests.replace("{n}", n(result.blockedRequests))}</div>
              </div>
            )}

            <section className={styles.section}>
              <h4>{s.br_js_risks}</h4>
              <JsRisks result={result} s={s} n={n} />
            </section>

            <section className={styles.section}>
              <h4>{s.br_seo}</h4>
              <dl className={`kv ${styles.seoKv}`}>
                <dt>{s.br_title}</dt>
                <dd>
                  <Text value={result.seo.title} s={s} n={n} />
                </dd>
                <dt>{s.br_description}</dt>
                <dd>
                  <Text value={result.seo.description} s={s} n={n} />
                </dd>
                <dt>{s.br_h1}</dt>
                <dd>
                  {result.seo.h1.length === 0 ? (
                    <span className={styles.muted}>{s.br_none}</span>
                  ) : (
                    <ul className={styles.plainList}>
                      {result.seo.h1.map((h, i) => (
                        <li key={i} dir="auto">
                          {h}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
                <dt>{s.br_canonical}</dt>
                <dd dir="ltr" className={styles.url}>
                  {result.seo.canonical ?? <span className={styles.muted}>{s.br_none}</span>}
                </dd>
                <dt>{s.br_robots}</dt>
                <dd dir="ltr" className={styles.url}>
                  {result.seo.robots ?? <span className={styles.muted}>{s.br_none}</span>}
                </dd>
                <dt>{s.br_lang}</dt>
                <dd dir="ltr">{result.seo.lang ?? <span className={styles.muted}>{s.br_none}</span>}</dd>
                <dt>{s.br_hreflang}</dt>
                <dd>
                  {result.seo.hreflang.length === 0 ? (
                    <span className={styles.muted}>{s.br_none}</span>
                  ) : (
                    <ul className={styles.plainList} dir="ltr">
                      {result.seo.hreflang.slice(0, 12).map((h, i) => (
                        <li key={i} className={styles.url}>
                          <b>{h.lang}</b> {h.href}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
                <dt>{s.br_jsonld}</dt>
                <dd>
                  {result.seo.jsonld.length === 0 ? (
                    <span className={styles.muted}>{s.br_none}</span>
                  ) : (
                    <span className={styles.chips} dir="ltr">
                      {result.seo.jsonld.map((type) => (
                        <span key={type} className="pill info">
                          {type}
                        </span>
                      ))}
                    </span>
                  )}
                </dd>
                <dt>{s.br_links}</dt>
                <dd>
                  {s.br_links_value
                    .replace("{internal}", n(result.seo.links.internal))
                    .replace("{external}", n(result.seo.links.external))}
                </dd>
                <dt>{s.br_missing_alt}</dt>
                <dd>{n(result.seo.imagesMissingAlt)}</dd>
                <dt>{s.br_words}</dt>
                <dd>{n(result.seo.wordCount)}</dd>
              </dl>
            </section>

            <section className={styles.section}>
              <h4>{s.br_metrics}</h4>
              <div className={styles.metrics}>
                <Metric
                  label={s.br_lcp}
                  value={result.metrics.lcpMs}
                  text={(v) => s.br_seconds.replace("{n}", decimal(v / 1000, locale, 1))}
                  tone={(v) => tone(v, 2_500, 4_000)}
                  toneLabel={toneLabel}
                  empty={s.br_not_measured}
                />
                <Metric
                  label={s.br_cls}
                  value={result.metrics.cls}
                  text={(v) => decimal(v, locale, 2)}
                  tone={(v) => tone(v, 0.1, 0.25)}
                  toneLabel={toneLabel}
                  empty={s.br_not_measured}
                />
                <Metric
                  label={s.br_ttfb}
                  value={result.metrics.ttfbMs}
                  text={(v) => s.br_ms.replace("{n}", n(v))}
                  tone={(v) => tone(v, 800, 1_800)}
                  toneLabel={toneLabel}
                  empty={s.br_not_measured}
                />
              </div>
              <p className={styles.muted}>{s.br_metrics_note}</p>
            </section>

            <section className={styles.section}>
              <h4>
                {s.br_console}
                {result.console.length > 0 && <span className="pill crit">{n(result.console.length)}</span>}
              </h4>
              {result.console.length === 0 ? (
                <p className={styles.muted}>{s.br_console_none}</p>
              ) : (
                <ul className={styles.console}>
                  {result.console.map((c, i) => (
                    <li key={i}>
                      {c.type === "exception" && <span className={styles.consoleKind}>{s.br_exception}</span>}
                      <code dir="ltr">{c.text}</code>
                      {c.source && (
                        <code dir="ltr" className={styles.consoleSource}>
                          {c.source}
                        </code>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <details className={styles.section}>
              <summary>{s.br_screenshot}</summary>
              {/* A data: URL, which the page's Content-Security-Policy allows for images. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.shot} src={`data:image/jpeg;base64,${result.screenshot}`} alt={s.br_screenshot} />
            </details>
          </>
        )}
      </div>
    </aside>
  );
}

function Text({ value, s, n }: { value: string | null; s: BrowserStrings; n: (v: number) => string }) {
  if (!value) return <span className={styles.muted}>{s.br_none}</span>;
  return (
    <>
      <span dir="auto">{value}</span>{" "}
      <span className={styles.count}>{s.br_chars.replace("{n}", n([...value].length))}</span>
    </>
  );
}

function JsRisks({ result, s, n }: { result: RenderResult; s: BrowserStrings; n: (v: number) => string }) {
  const r = result.renderedVsRaw;
  if (!r.available) {
    return (
      <div className="note">
        <Icon name="info" />
        <div>{s.br_js_unavailable}</div>
      </div>
    );
  }
  const risks = [
    r.titleDiffers && s.br_js_title,
    r.descriptionDiffers && s.br_js_description,
    r.canonicalDiffers && s.br_js_canonical,
    r.robotsDiffers && s.br_js_robots,
    r.h1Differs && s.br_js_h1,
    r.linksOnlyInRendered > 0 && s.br_js_links.replace("{n}", n(r.linksOnlyInRendered)),
  ].filter((x): x is string => Boolean(x));
  if (risks.length === 0) {
    return (
      <div className="note acc">
        <Icon name="check" />
        <div>{s.br_js_ok}</div>
      </div>
    );
  }
  return (
    <ul className={styles.risks}>
      {risks.map((text) => (
        <li key={text}>
          <Icon name="alert" />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

function Metric({
  label,
  value,
  text,
  tone: toneOf,
  toneLabel,
  empty,
}: {
  label: string;
  value: number | undefined;
  text: (v: number) => string;
  tone: (v: number) => Tone;
  toneLabel: Record<Tone, string>;
  empty: string;
}) {
  const t = value === undefined ? null : toneOf(value);
  return (
    <div className={styles.metric}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={styles.metricValue}>{value === undefined ? "—" : text(value)}</div>
      {t ? <span className={`pill ${t}`}>{toneLabel[t]}</span> : <span className="pill mute">{empty}</span>}
    </div>
  );
}
