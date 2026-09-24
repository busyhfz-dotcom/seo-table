"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Rich } from "../../../../components/ui";
import { Icon } from "../../../../components/icons";
import { CopyButton, Flash, Loading, useAction, useLoad } from "../../../../components/kit";
import { callApi, apiErrorMessage } from "../../../../lib/errors-ui";
import { fmt } from "../../../../lib/dict";
import { ISSUE_LEVEL, SCHEMA_TYPE_LABELS } from "../../../../lib/seo-labels";
import { LocText } from "../../../../components/loc-text";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { Locale } from "../../../../lib/i18n";
import type { ToolStrings } from "../strings";
import { ApplyResult, type ApplyTarget, type Proposal } from "../shared";
import { SPEC, emptyRow, missingRowFields, type Field } from "./spec";

type Issue = { level: "error" | "warning" | "info"; code: string; path: string; message: { fa: string; en: string } };
type Existing =
  | { status: "no_scan" | "needs_rescan" | "not_crawled" }
  | { status: "ok"; url: string; scannedAt: string | null; nodes: Array<{ type: string; node: unknown; issues: Issue[] }> };
type Preview = { jsonld: Record<string, unknown>; issues: Issue[]; conflicts: Array<{ level: string; code: string; type: string; message: { fa: string; en: string } }>; existing: Existing };
type Data = Record<string, unknown>;

export type SchemaCtx = {
  projectId: string;
  baseUrl: string;
  locale: Locale;
  canPropose: boolean;
  links: { fixes: string; approvals: string; connect: string; audit: string };
  fields: Record<string, string>;
  enums: Record<string, string>;
};

export function SchemaScreen({ ctx, s, c }: { ctx: SchemaCtx; s: ToolStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/schema`;
  const [url, setUrl] = useState(ctx.baseUrl);
  const [loadedUrl, setLoadedUrl] = useState(ctx.baseUrl);
  const info = useLoad<{ types: string[]; existing: Existing }>(`${base}?url=${encodeURIComponent(loadedUrl)}`, locale);
  const [type, setType] = useState<string | null>(null);
  const [data, setData] = useState<Data>({});
  const [from, setFrom] = useState<string[]>([]);
  const [prefilling, setPrefilling] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const seq = useRef(0);

  async function pick(t: string) {
    setType(t);
    setPreview(null);
    setPrefilling(true);
    const r = await callApi<{ data: Data; from: string[] }>(`${base}/prefill?type=${encodeURIComponent(t)}&url=${encodeURIComponent(loadedUrl)}`);
    setPrefilling(false);
    setData(r.ok ? normalize(r.data.data, SPEC[t] ?? []) : {});
    setFrom(r.ok ? r.data.from : []);
  }

  // Live preview and validation, shortly after the form stops changing.
  useEffect(() => {
    if (!type || prefilling) return;
    const mine = ++seq.current;
    const missing = missingRowFields(SPEC[type] ?? [], data);
    if (missing.length) {
      setPreview(null);
      setPreviewError(fmt(s.sc_fill_rows, { f: missing.map((k) => ctx.fields[k] ?? k).join("، ") }));
      return;
    }
    const t = setTimeout(async () => {
      const r = await callApi<Preview>(`${base}/preview`, { method: "POST", body: { type, data: prune(data) ?? {}, url: loadedUrl } });
      if (mine !== seq.current) return;
      if (r.ok) {
        setPreview(r.data);
        setPreviewError(null);
      } else {
        const issues = (r.failure.details?.issues as Array<{ path: string }> | undefined) ?? [];
        const fields = [...new Set(issues.map((i) => ctx.fields[i.path.split(".").filter((p) => !/^\d+$/.test(p)).pop() ?? ""] ?? i.path))];
        setPreviewError(`${apiErrorMessage(locale, r.failure)}${fields.length ? ` (${fields.join("، ")})` : ""}`);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [type, data, loadedUrl, base, locale, ctx.fields, prefilling, s.sc_fill_rows]);

  const errors = preview?.issues.filter((i) => i.level === "error") ?? [];

  return (
    <>
      <Card title={s.page_url}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const next = new URL(url.trim(), ctx.baseUrl).toString();
              setUrl(next);
              setLoadedUrl(next);
              if (type) void pick(type);
            } catch {
              /* the input keeps what was typed; nothing to load */
            }
          }}
        >
          <input value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" aria-label={s.page_url} style={{ flex: "1 1 260px", width: "auto" }} />
          <button type="submit" className="btn">
            <Icon name="refresh" />
            {s.load}
          </button>
        </form>
        <div style={{ marginTop: 14 }}>
          <ExistingPanel state={info} s={s} c={c} locale={locale} audit={ctx.links.audit} />
        </div>
      </Card>

      <Card title={s.sc_pick_type}>
        <div className="typegrid">
          {Object.keys(SPEC).map((t) => (
            <button key={t} type="button" className={`typebtn${type === t ? " on" : ""}`} aria-pressed={type === t} onClick={() => void pick(t)}>
              <b>{SCHEMA_TYPE_LABELS[t]?.[locale] ?? t}</b>
              <code dir="ltr">{t}</code>
            </button>
          ))}
        </div>
      </Card>

      {type && (
        <div className="split">
          <Card title={s.sc_form} sub={SCHEMA_TYPE_LABELS[type]?.[locale]}>
            {prefilling ? (
              <Loading label={c.loading} />
            ) : (
              <div className="stack">
                {from.length > 0 && (
                  <p className="hint">
                    {s.sc_prefilled} {from.map((f) => (f === "crawl" ? s.sc_from_crawl : s.sc_from_markup)).join("، ")}
                  </p>
                )}
                <FieldList fields={SPEC[type] ?? []} value={data} onChange={setData} ctx={ctx} s={s} />
              </div>
            )}
          </Card>
          <div className="stack">
            <Card title={s.sc_preview} right={preview ? <CopyButton text={JSON.stringify(preview.jsonld, null, 2)} c={c} /> : undefined}>
              {previewError ? (
                <Flash tone="crit">{previewError}</Flash>
              ) : !preview ? (
                <Loading label={c.loading} />
              ) : (
                <pre className="code-block">{`<script type="application/ld+json">\n${JSON.stringify(preview.jsonld, null, 2)}\n</script>`}</pre>
              )}
            </Card>
            {preview && (
              <Card title={s.sc_validation}>
                <IssueList issues={preview.issues} s={s} locale={locale} />
                {preview.conflicts.length > 0 && (
                  <>
                    <h4 style={{ margin: "14px 0 6px" }}>{s.sc_conflicts}</h4>
                    <ul className="checks">
                      {preview.conflicts.map((x, i) => (
                        <li key={i} className={x.level === "warning" ? "warn" : "na"}>
                          <Icon name="alert" />
                          <span>
                            <LocText pair={x.message} locale={locale} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Card>
            )}
            {preview && (
              <RenderPreview ctx={ctx} s={s} c={c} url={loadedUrl} jsonld={preview.jsonld} />
            )}
            {preview && (
              <ApplyCard ctx={ctx} s={s} c={c} disabled={errors.length > 0} url={loadedUrl} jsonld={preview.jsonld} />
            )}
          </div>
        </div>
      )}

      <PasteValidator ctx={ctx} s={s} />
    </>
  );
}

function ExistingPanel({ state, s, c, locale, audit }: { state: ReturnType<typeof useLoad<{ types: string[]; existing: Existing }>>; s: ToolStrings; c: CommonStrings; locale: Locale; audit: string }) {
  if (!state.data) return state.error ? <Flash tone="crit">{state.error}</Flash> : <Loading label={c.loading} rows={2} />;
  const ex = state.data.existing;
  if (ex.status === "no_scan")
    return (
      <p className="small muted">
        {c.no_scan_body}{" "}
        <a className="lnk" href={audit}>
          {c.go_audit}
        </a>
      </p>
    );
  if (ex.status !== "ok") return <p className="small muted">{ex.status === "needs_rescan" ? c.needs_rescan : s.sc_not_crawled}</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h4>{s.sc_existing}</h4>
      {ex.nodes.length === 0 ? (
        <p className="small muted">{s.sc_existing_none}</p>
      ) : (
        ex.nodes.map((n, i) => (
          <details key={i} className="node">
            <summary className="row">
              <code className="inline-code">{n.type}</code>
              {n.issues.filter((x) => x.level === "error").length > 0 ? (
                <span className="pill crit">{ISSUE_LEVEL.error![locale]}</span>
              ) : (
                <span className="pill ok">
                  <Icon name="check" />
                </span>
              )}
            </summary>
            <IssueList issues={n.issues} s={s} locale={locale} />
          </details>
        ))
      )}
    </div>
  );
}

export function IssueList({ issues, s, locale }: { issues: Issue[]; s: ToolStrings; locale: Locale }) {
  if (!issues.length)
    return (
      <p className="small" style={{ color: "var(--ok)" }}>
        <Icon name="check" /> {s.sc_valid}
      </p>
    );
  return (
    <ul className="checks">
      {issues.map((x, i) => (
        <li key={i} className={x.level === "error" ? "fail" : x.level === "warning" ? "warn" : "na"}>
          <Icon name={x.level === "error" ? "x" : x.level === "warning" ? "alert" : "info"} />
          <span>
            <LocText pair={x.message} locale={locale} />
            {x.path && (
              <>
                {" "}
                <code className="inline-code">{x.path}</code>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FieldList({ fields, value, onChange, ctx, s }: { fields: Field[]; value: Data; onChange: (next: Data) => void; ctx: SchemaCtx; s: ToolStrings }) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <div className="formgrid">
      {fields.map((f) => {
        const label = <Rich text={ctx.fields[f.key] ?? f.key} />;
        const v = value[f.key];
        switch (f.kind) {
          case "text":
          case "url":
          case "number":
          case "time":
          case "date":
            return (
              <label key={f.key} className="field">
                {label}
                <input
                  type={f.kind === "time" ? "time" : f.kind === "date" ? "date" : f.kind === "number" ? "text" : "text"}
                  inputMode={f.kind === "number" ? "decimal" : undefined}
                  value={typeof v === "string" || typeof v === "number" ? String(f.kind === "date" ? String(v).slice(0, 10) : v) : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  dir={f.kind === "text" ? "auto" : "ltr"}
                />
              </label>
            );
          case "textarea":
            return (
              <label key={f.key} className="field span2">
                {label}
                <textarea rows={3} value={typeof v === "string" ? v : ""} onChange={(e) => set(f.key, e.target.value)} dir="auto" />
              </label>
            );
          case "urls":
          case "strings":
            return (
              <label key={f.key} className="field span2">
                {label}
                <textarea
                  rows={2}
                  value={Array.isArray(v) ? v.join("\n") : ""}
                  onChange={(e) => set(f.key, e.target.value.split("\n"))}
                  dir={f.kind === "urls" ? "ltr" : "auto"}
                />
              </label>
            );
          case "select":
            return (
              <label key={f.key} className="field">
                {label}
                <select value={typeof v === "string" ? v : ""} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">{ctx.enums.none}</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {ctx.enums[o] ?? o}
                    </option>
                  ))}
                </select>
              </label>
            );
          case "multiselect": {
            const list = Array.isArray(v) ? (v as string[]) : [];
            return (
              <fieldset key={f.key} className="field span2 checkset">
                <legend>{label}</legend>
                {f.options.map((o) => (
                  <label key={o} className="pick">
                    <input type="checkbox" checked={list.includes(o)} onChange={(e) => set(f.key, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />
                    {ctx.enums[o] ?? o}
                  </label>
                ))}
              </fieldset>
            );
          }
          case "object":
            return (
              <fieldset key={f.key} className="group span2">
                <legend>{label}</legend>
                <FieldList fields={f.fields} value={(v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Data} onChange={(next) => set(f.key, next)} ctx={ctx} s={s} />
              </fieldset>
            );
          case "rows": {
            const rows = Array.isArray(v) ? (v as Data[]) : [];
            return (
              <fieldset key={f.key} className="group span2">
                <legend>{label}</legend>
                {rows.map((row, i) => (
                  <div key={i} className="rowbox">
                    <FieldList fields={f.fields} value={row} onChange={(next) => set(f.key, rows.map((r, j) => (j === i ? next : r)))} ctx={ctx} s={s} />
                    <button type="button" className="btn ghost sm" onClick={() => set(f.key, rows.filter((_, j) => j !== i))}>
                      <Icon name="x" />
                      {s.sc_remove_row}
                    </button>
                  </div>
                ))}
                <button type="button" className="btn sm" onClick={() => set(f.key, [...rows, emptyRow(f.fields)])}>
                  <Icon name="plus" />
                  {s.sc_add_row}
                </button>
              </fieldset>
            );
          }
        }
      })}
    </div>
  );
}

/** Prefilled data in the shapes the form edits (nested objects, lists of rows). */
function normalize(data: Data, fields: Field[]): Data {
  const out: Data = {};
  for (const f of fields) {
    const v = data[f.key];
    if (v === undefined || v === null) continue;
    if (f.kind === "object") out[f.key] = typeof v === "object" && !Array.isArray(v) ? normalize(v as Data, f.fields) : {};
    else if (f.kind === "rows") out[f.key] = Array.isArray(v) ? v.map((r) => normalize(r as Data, f.fields)) : [];
    else if (f.kind === "urls" || f.kind === "strings") out[f.key] = Array.isArray(v) ? v.map(String) : [String(v)];
    else out[f.key] = v;
  }
  return out;
}

/** Blank fields, blank list lines and wholly empty rows are not sent: an empty property is worse than none. */
function prune(value: unknown): unknown {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (Array.isArray(value)) {
    const list = value.map(prune).filter((x) => x !== undefined);
    return list;
  }
  if (value && typeof value === "object") {
    const out: Data = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p === undefined) continue;
      if (Array.isArray(p) && p.length === 0 && k !== "items" && k !== "steps") continue;
      if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

function RenderPreview({ ctx, s, c, url, jsonld }: { ctx: SchemaCtx; s: ToolStrings; c: CommonStrings; url: string; jsonld: Record<string, unknown> }) {
  const act = useAction(ctx.locale);
  const [result, setResult] = useState<{ screenshot: string; seo: { jsonld: string[] } } | null>(null);
  async function run() {
    setResult(
      await act.run<{ screenshot: string; seo: { jsonld: string[] } }>("/api/browser/render", {
        body: { url, device: "desktop", changes: [{ field: "jsonld", value: JSON.stringify(jsonld) }] },
      }),
    );
  }
  return (
    <Card title={s.sc_render}>
      <div className="stack">
        <p className="hint">{s.sc_render_help}</p>
        <div>
          <button type="button" className="btn" disabled={act.busy} onClick={() => void run()}>
            {act.busy ? <span className="spin" aria-hidden="true" /> : <Icon name="browser" />}
            {act.busy ? c.loading : s.sc_render_run}
          </button>
        </div>
        {act.error && <Flash tone="crit">{act.error}</Flash>}
        {result && (
          <>
            <div className="row">
              <span className="small">{s.sc_render_types}</span>
              {result.seo.jsonld.length ? (
                result.seo.jsonld.map((t) => (
                  <code key={t} className="inline-code">
                    {t}
                  </code>
                ))
              ) : (
                <span className="muted small">{s.sc_render_none}</span>
              )}
            </div>
            {/* The worker's screenshot of the page with the markup added. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="shot" src={`data:image/jpeg;base64,${result.screenshot}`} alt={s.sc_render} />
          </>
        )}
      </div>
    </Card>
  );
}

function ApplyCard({ ctx, s, c, disabled, url, jsonld }: { ctx: SchemaCtx; s: ToolStrings; c: CommonStrings; disabled: boolean; url: string; jsonld: Record<string, unknown> }) {
  const act = useAction(ctx.locale);
  const [result, setResult] = useState<{ proposal: Proposal; target: ApplyTarget } | null>(null);
  const [manual, setManual] = useState(false);
  async function apply() {
    setManual(false);
    const r = await callApi<{ proposal: Proposal; target: ApplyTarget }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/schema/apply`, { method: "POST", body: { url, jsonld } });
    if (r.ok) setResult(r.data);
    else if (r.failure.status === 409 && r.failure.details?.manual) setManual(true);
    else act.setError(apiErrorMessage(ctx.locale, r.failure));
  }
  return (
    <Card title={s.apply_title}>
      <div className="stack">
        <p className="hint">{s.apply_help}</p>
        {!ctx.canPropose ? (
          <p className="muted small">{c.read_only}</p>
        ) : (
          <div>
            <button type="button" className="btn primary" disabled={disabled || act.busy} onClick={() => void apply()}>
              <Icon name="wand" />
              {s.propose}
            </button>
          </div>
        )}
        {disabled && <p className="small" style={{ color: "var(--crit)" }}>{s.sc_has_errors}</p>}
        {act.error && <Flash tone="crit">{act.error}</Flash>}
        {manual && <Flash tone="warn">{c.manual_only}</Flash>}
        {result && <ApplyResult proposal={result.proposal} target={result.target} links={ctx.links} s={s} c={c} />}
      </div>
    </Card>
  );
}

function PasteValidator({ ctx, s }: { ctx: SchemaCtx; s: ToolStrings }) {
  const [text, setText] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const act = useAction(ctx.locale);
  const [results, setResults] = useState<Array<{ type: string; issues: Issue[] }> | null>(null);
  const parse = useCallback(() => {
    try {
      return JSON.parse(text.replace(/^\s*<script[^>]*>|<\/script>\s*$/gi, "")) as unknown;
    } catch {
      return undefined;
    }
  }, [text]);
  const example = useMemo(() => '{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "…"\n}', []);
  async function validate() {
    setLocal(null);
    const value = parse();
    if (value === undefined) {
      setLocal(s.sc_paste_invalid);
      setResults(null);
      return;
    }
    const r = await act.run<{ results: Array<{ type: string; issues: Issue[] }> }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/schema/validate`, { body: { jsonld: value } });
    setResults(r?.results ?? null);
  }
  return (
    <Card title={s.sc_paste}>
      <div className="stack">
        <p className="hint">{s.sc_paste_help}</p>
        <textarea className="code" value={text} onChange={(e) => setText(e.target.value)} placeholder={example} aria-label={s.sc_paste} translate="no" />
        <div>
          <button type="button" className="btn" disabled={!text.trim() || act.busy} onClick={() => void validate()}>
            <Icon name="check" />
            {s.sc_paste_run}
          </button>
        </div>
        {local && <Flash tone="crit">{local}</Flash>}
        {act.error && <Flash tone="crit">{act.error}</Flash>}
        {results &&
          results.map((r, i) => (
            <div key={i} className="stack" style={{ gap: 6 }}>
              <code className="inline-code" style={{ alignSelf: "flex-start" }}>
                {r.type}
              </code>
              <IssueList issues={r.issues} s={s} locale={ctx.locale} />
            </div>
          ))}
        {results && results.length === 0 && <p className="small muted">{fmt(s.sc_type_n, { t: "—" })}</p>}
      </div>
    </Card>
  );
}
