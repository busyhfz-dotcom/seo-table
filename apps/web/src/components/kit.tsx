"use client";

/**
 * Client-side building blocks shared by the SEO data screens: data loading with
 * honest loading and error states, tabs, a side sheet, source badges, position
 * changes, a line chart, and polling for a background job.
 *
 * Every failure goes through errors-ui (apiErrorMessage), so a screen never
 * shows a raw server message or a status code on its own.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { apiErrorMessage, callApi, type ApiFailure } from "../lib/errors-ui";
import { decimal, num } from "../lib/format";
import type { Locale } from "../lib/i18n";
import type { CommonStrings } from "../lib/common-strings";

// ---------------------------------------------------------------- data

export type Loaded<T> = {
  data: T | null;
  error: string | null;
  failure: ApiFailure | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T | null | ((prev: T | null) => T | null)) => void;
};

/** GET a JSON endpoint; `url` null waits (e.g. until a choice is made). */
export function useLoad<T>(url: string | null, locale: Locale): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!url) return;
    const mine = ++seq.current;
    setLoading(true);
    const r = await callApi<T>(url);
    // A slower answer to an older request must not overwrite a newer one.
    if (mine !== seq.current) return;
    setLoading(false);
    if (r.ok) {
      setData(r.data);
      setFailure(null);
    } else setFailure(r.failure);
  }, [url]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, failure, error: failure ? apiErrorMessage(locale, failure) : null, loading, reload, setData };
}

/** A mutation's state: busy flag, the last error in the reader's language, and a runner. */
export function useAction(locale: Locale) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(
      url: string,
      init: { method?: string; body?: unknown } = {},
      overrides?: Parameters<typeof apiErrorMessage>[2],
    ): Promise<T | null> => {
      setBusy(true);
      setError(null);
      const r = await callApi<T>(url, { method: init.method ?? "POST", ...(init.body !== undefined ? { body: init.body } : {}) });
      setBusy(false);
      if (!r.ok) {
        setError(apiErrorMessage(locale, r.failure, overrides));
        return null;
      }
      return r.data;
    },
    [locale],
  );
  return { busy, error, setError, run };
}

// ---------------------------------------------------------------- states

export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} style={{ width: `${92 - i * 17}%` }} />
      ))}
    </div>
  );
}

export function ErrorNote({ message, onRetry, c }: { message: string; onRetry?: () => void; c: CommonStrings }) {
  return (
    <div className="note crit" role="alert">
      <Icon name="alert" />
      <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
        <span>{message}</span>
        {onRetry && (
          <button type="button" className="btn ghost sm" onClick={onRetry}>
            <Icon name="refresh" />
            {c.retry}
          </button>
        )}
      </div>
    </div>
  );
}

/** Loading → error → content, the order every panel follows. */
export function Resolve<T>({
  state,
  c,
  children,
  rows,
}: {
  state: Loaded<T>;
  c: CommonStrings;
  children: (data: T) => ReactNode;
  rows?: number;
}) {
  if (state.error && !state.data) return <ErrorNote message={state.error} onRetry={() => void state.reload()} c={c} />;
  if (!state.data) return <Loading label={c.loading} rows={rows} />;
  return <>{children(state.data)}</>;
}

export function Flash({ tone, children }: { tone: "ok" | "crit" | "info" | "warn"; children: ReactNode }) {
  const icon = tone === "ok" ? "check" : tone === "crit" ? "alert" : "info";
  const cls = tone === "ok" ? "note acc flash" : tone === "crit" ? "note crit" : tone === "warn" ? "note lock" : "note";
  return (
    <div className={cls} role={tone === "crit" ? "alert" : "status"}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- layout

export type TabSpec<K extends string> = { key: K; label: string; count?: number | null; icon?: string };

/** Section tabs; on a phone the strip scrolls sideways instead of wrapping into rows. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  locale,
  label,
}: {
  tabs: TabSpec<K>[];
  value: K;
  onChange: (key: K) => void;
  locale: Locale;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          className="tab"
          onClick={() => onChange(tab.key)}
        >
          {tab.icon && <Icon name={tab.icon} />}
          <span>{tab.label}</span>
          {tab.count !== undefined && tab.count !== null && <span className="tag">{num(tab.count, locale)}</span>}
        </button>
      ))}
    </div>
  );
}

/** A modal side sheet (the native dialog: focus trap, Escape and backdrop come with it). */
export function Sheet({
  open,
  onClose,
  title,
  sub,
  children,
  closeLabel,
  size = "wide",
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  size?: "wide" | "narrow";
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`sheet ${size === "narrow" ? "narrow" : ""}`}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <header>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h3>{title}</h3>
              {sub && <div className="muted small">{sub}</div>}
            </div>
            {actions}
            <button type="button" className="btn ghost sm" onClick={onClose} aria-label={closeLabel}>
              <Icon name="x" />
            </button>
          </header>
          <div className="sheet-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- data labels

export type Source = "gsc" | "dataforseo" | "serp" | "autocomplete" | "psi" | "crawl" | "field" | "lab";

const SOURCE_TONE: Record<Source, string> = {
  gsc: "info",
  dataforseo: "acc",
  serp: "acc",
  autocomplete: "mute",
  psi: "info",
  crawl: "mute",
  field: "ok",
  lab: "mute",
};

/** Where a number came from, next to the number. */
export function SourceBadge({ source, c, title }: { source: Source; c: CommonStrings; title?: string }) {
  const label = {
    gsc: c.src_gsc,
    dataforseo: c.src_dataforseo,
    serp: c.src_serp,
    autocomplete: c.src_autocomplete,
    psi: c.src_psi,
    crawl: c.src_crawl,
    field: c.src_field,
    lab: c.src_lab,
  }[source];
  return (
    <span className={`pill src ${SOURCE_TONE[source]}`} title={title}>
      {label}
    </span>
  );
}

/**
 * A position change: previous − current, so positive is better. Arrows and
 * colour together, never colour alone.
 */
export function PosChange({ current, previous, locale }: { current: number | null; previous: number | null; locale: Locale }) {
  if (current === null || previous === null) return <span className="muted">—</span>;
  const change = Math.round((previous - current) * 10) / 10;
  if (change === 0) return <span className="delta flat">＝</span>;
  const up = change > 0;
  return (
    <span className={`delta ${up ? "up" : "down"}`}>
      <Icon name={up ? "up" : "down"} />
      {decimal(Math.abs(change), locale)}
    </span>
  );
}

/** A "not connected / not configured" panel that says what to connect and where. */
export function NotConfigured({
  title,
  body,
  action,
  href,
  icon = "plug",
}: {
  title: string;
  body: ReactNode;
  action?: string | null;
  href?: string | null;
  icon?: string;
}) {
  return (
    <div className="nc">
      <span className="mico">
        <Icon name={icon} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b>{title}</b>
        <p className="desc">{body}</p>
        {action && href && (
          <a className="btn primary sm" href={href} style={{ marginTop: 10 }}>
            <Icon name="plug" />
            {action}
          </a>
        )}
      </div>
    </div>
  );
}

export function CopyButton({ text, c }: { text: string; c: CommonStrings }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        });
      }}
    >
      <Icon name={done ? "check" : "doc"} />
      {done ? c.copied : c.copy}
    </button>
  );
}

/** A destructive button that asks once more in place instead of a browser confirm(). */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  icon = "trash",
  className = "btn danger sm",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  icon?: string;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(t);
  }, [asking]);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        if (asking) {
          setAsking(false);
          onConfirm();
        } else setAsking(true);
      }}
    >
      <Icon name={asking ? "alert" : icon} />
      {asking ? confirmLabel : label}
    </button>
  );
}

// ---------------------------------------------------------------- jobs

export type JobState = "waiting" | "active" | "completed" | "failed" | "delayed" | "prioritized" | "unknown" | "waiting-children";
export type JobView<R> = { jobId: string; state: JobState; result: R | null; error: { message: string | null } | null };

/**
 * Polls a background job until it finishes (or 10 minutes pass), then calls
 * onDone once. `url` null = nothing to watch.
 */
export function useJob<R>(url: string | null, onDone: (job: JobView<R>) => void, intervalMs = 3000) {
  const [job, setJob] = useState<JobView<R> | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    setJob(null);
    setTimedOut(false);
    if (!url) return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      if (stop) return;
      const r = await callApi<JobView<R>>(url);
      if (stop) return;
      if (r.ok) {
        setJob(r.data);
        if (r.data.state === "completed" || r.data.state === "failed") {
          done.current(r.data);
          return;
        }
      }
      if (Date.now() - started > 600_000) {
        setTimedOut(true);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [url, intervalMs]);
  return { job, timedOut };
}

export function jobStateLabel(state: string | undefined, c: CommonStrings): string {
  switch (state) {
    case "active":
      return c.state_active;
    case "completed":
      return c.state_completed;
    case "failed":
      return c.state_failed;
    case "delayed":
      return c.state_delayed;
    default:
      return c.state_waiting;
  }
}

/** A running job's line: spinner and state. */
export function JobLine({ state, c, children }: { state: string | undefined; c: CommonStrings; children?: ReactNode }) {
  const finished = state === "completed" || state === "failed";
  return (
    <div className={`jobline ${state ?? "waiting"}`} role="status" aria-live="polite">
      {finished ? <Icon name={state === "failed" ? "alert" : "check"} /> : <span className="spin" aria-hidden="true" />}
      <span>{jobStateLabel(state, c)}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- charts

export type Series = { key: string; label: string; color: string; points: Array<{ x: string; y: number | null }>; dashed?: boolean };

const PALETTE = ["#2BE08A", "#5BB8F5", "#F3C24B", "#F79245", "#C792EA", "#F0655E"];
export function seriesColor(i: number): string {
  return PALETTE[i % PALETTE.length]!;
}

/**
 * Lines over dates (x = "YYYY-MM-DD" or ISO). `invert` puts small values on
 * top (positions: #1 is best). Gaps (null) break the line instead of drawing
 * through days without data. Drawn left-to-right in both languages: time runs
 * rightwards.
 */
export function LineChart({
  series,
  locale,
  ariaLabel,
  invert = false,
  height = 200,
  yMin,
  yMax,
  formatX,
  formatY,
}: {
  series: Series[];
  locale: Locale;
  ariaLabel: string;
  invert?: boolean;
  height?: number;
  yMin?: number;
  yMax?: number;
  formatX: (x: string) => string;
  formatY?: (y: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const clip = useId();
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const values = series.flatMap((s) => s.points.map((p) => p.y)).filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length === 0 || values.length === 0) return null;
  const fy = formatY ?? ((v: number) => num(v, locale));

  const W = 680;
  const H = height;
  const pl = 40;
  const pr = 14;
  const pt = 12;
  const pb = 24;
  let lo = yMin ?? Math.min(...values);
  let hi = yMax ?? Math.max(...values);
  if (hi === lo) {
    lo = Math.max(yMin ?? -Infinity, lo - 1);
    hi = hi + 1;
  }
  const pad = (hi - lo) * 0.08;
  if (yMin === undefined) lo = Math.max(invert ? 1 : 0, lo - pad);
  if (yMax === undefined) hi = hi + pad;
  const x = (i: number) => (xs.length === 1 ? (pl + W - pr) / 2 : pl + (i * (W - pl - pr)) / (xs.length - 1));
  const y = (v: number) => {
    const f = (v - lo) / (hi - lo);
    return invert ? pt + f * (H - pt - pb) : H - pb - f * (H - pt - pb);
  };
  const ticks = niceTicks(lo, hi, 4);
  const index = new Map(xs.map((v, i) => [v, i]));

  function onMove(event: React.MouseEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const rel = (event.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(xs.length - 1, Math.round(rel * (xs.length - 1)))));
  }

  return (
    <div className="linechart">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} style={{ direction: "ltr" }}>
        <defs>
          <clipPath id={clip}>
            <rect x={pl} y={pt - 4} width={W - pl - pr} height={H - pt - pb + 8} />
          </clipPath>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line className="grid-l" x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} />
            <text x={pl - 8} y={y(v) + 3.5} textAnchor="end">
              {fy(v)}
            </text>
          </g>
        ))}
        <text x={pl} y={H - 6} textAnchor="start">
          {formatX(xs[0]!)}
        </text>
        {xs.length > 1 && (
          <text x={W - pr} y={H - 6} textAnchor="end">
            {formatX(xs[xs.length - 1]!)}
          </text>
        )}
        <g clipPath={`url(#${clip})`}>
          {series.map((s) => {
            const segments: string[][] = [];
            let current: string[] = [];
            const sorted = [...s.points].sort((a, b) => a.x.localeCompare(b.x));
            for (const p of sorted) {
              if (p.y === null || !Number.isFinite(p.y)) {
                if (current.length) segments.push(current);
                current = [];
                continue;
              }
              current.push(`${x(index.get(p.x)!).toFixed(1)},${y(p.y).toFixed(1)}`);
            }
            if (current.length) segments.push(current);
            return (
              <g key={s.key}>
                {segments.map((seg, i) =>
                  seg.length === 1 ? (
                    <circle key={i} cx={seg[0]!.split(",")[0]} cy={seg[0]!.split(",")[1]} r="3" fill={s.color} />
                  ) : (
                    <polyline
                      key={i}
                      fill="none"
                      stroke={s.color}
                      strokeWidth="2"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      strokeDasharray={s.dashed ? "5 4" : undefined}
                      points={seg.join(" ")}
                    />
                  ),
                )}
              </g>
            );
          })}
        </g>
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pt} y2={H - pb} stroke="#314138" strokeWidth="1" />
            {series.map((s) => {
              const p = s.points.find((q) => q.x === xs[hover]);
              return p && p.y !== null ? <circle key={s.key} cx={x(hover)} cy={y(p.y)} r="4" fill={s.color} stroke="#080B09" strokeWidth="2" /> : null;
            })}
          </>
        )}
        <rect
          x={pl}
          y={pt}
          width={W - pl - pr}
          height={H - pt - pb}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <div
          className="chart-tip"
          dir={locale === "fa" ? "rtl" : "ltr"}
          style={{
            left: `${(x(hover) / W) * 100}%`,
            transform: x(hover) > W / 2 ? "translate(calc(-100% - 10px), 0)" : "translate(10px, 0)",
          }}
        >
          <div className="muted small">{formatX(xs[hover]!)}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === xs[hover]);
            return (
              <div key={s.key} className="row" style={{ gap: 6 }}>
                <i style={{ background: s.color }} className="dot" />
                <span>{s.label}</span>
                <b className="num">{p && p.y !== null ? fy(p.y) : "—"}</b>
              </div>
            );
          })}
        </div>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <i className="dot" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/** Horizontal bars with a label and a value, for comparisons across sites or buckets. */
export function BarList({
  items,
  locale,
  format,
}: {
  items: Array<{ key: string; label: ReactNode; value: number | null; highlight?: boolean; tone?: string }>;
  locale: Locale;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value ?? 0));
  return (
    <ul className="barlist">
      {items.map((i) => (
        <li key={i.key} className={i.highlight ? "mine" : undefined}>
          <span className="bl-label">{i.label}</span>
          <span className="bl-bar">
            <i style={{ width: `${i.value === null ? 0 : Math.max(2, (i.value / max) * 100)}%`, ...(i.tone ? { background: `var(--${i.tone})` } : {}) }} />
          </span>
          <b className="num">{i.value === null ? "—" : format ? format(i.value) : num(i.value, locale)}</b>
        </li>
      ))}
    </ul>
  );
}

/** A 0–100 score as a ring, coloured by Google's bands (0–49, 50–89, 90–100). */
export function ScoreRing({ score, size = 44, locale, label }: { score: number | null; size?: number; locale: Locale; label: string }) {
  const r = 16;
  const C = 2 * Math.PI * r;
  const tone = score === null ? "var(--border-strong)" : score >= 90 ? "var(--ok)" : score >= 50 ? "var(--warn)" : "var(--crit)";
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} role="img" aria-label={`${label}: ${score === null ? "—" : num(score, locale)}`} style={{ flex: "none" }}>
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="4" />
      {score !== null && (
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${((C * Math.max(0, Math.min(100, score))) / 100).toFixed(1)} ${C.toFixed(1)}`}
          transform="rotate(-90 20 20)"
        />
      )}
      <text x="20" y="24.5" textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 12, fontWeight: 600, fontFamily: "var(--f-en)" }}>
        {score === null ? "—" : num(score, locale)}
      </text>
    </svg>
  );
}
