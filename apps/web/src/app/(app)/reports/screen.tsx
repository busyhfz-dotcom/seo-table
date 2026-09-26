"use client";

import { useCallback, useState } from "react";
import { Card, Rich } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { ConfirmButton, Flash, JobLine, Loading, useAction, useJob, useLoad, type JobView } from "../../../components/kit";
import { bytes, relative } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import { REPORT_KIND_HELP, REPORT_KIND_LABELS } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { Locale } from "../../../lib/i18n";
import type { ReportStrings } from "./strings";

type Report = { id: string; kind: string; fileKey: string; bytes: number; createdAt: string };
type Pending = { jobId: string; kind: string; state: string; queuedAt: string };
type Brand = { name?: string; color?: string; logo?: string; defaults: { name: string } };

export type ReportsCtx = { projectId: string; locale: Locale; canWrite: boolean; canBrand: boolean };

const MAX_LOGO = 300 * 1024;
const KINDS = ["executive", "audit", "keywords"] as const;

export function ReportsScreen({ ctx, s, c }: { ctx: ReportsCtx; s: ReportStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/reports`;
  const list = useLoad<{ reports: Report[]; pending: Pending[] }>(base, locale);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("executive");
  const [lang, setLang] = useState<Locale>(locale);
  const gen = useAction(locale);
  const del = useAction(locale);
  const [jobUrl, setJobUrl] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "crit" | "info"; text: string } | null>(null);

  const onDone = useCallback(
    (job: JobView<unknown>) => {
      setJobUrl(null);
      setNote(job.state === "failed" ? { tone: "crit", text: s.failed } : { tone: "ok", text: s.ready });
      void list.reload();
    },
    [list, s],
  );
  const { job } = useJob<unknown>(jobUrl, onDone, 2500);

  async function generate() {
    setNote(null);
    const r = await gen.run<{ jobId: string; deduplicated: boolean }>(base, { body: { kind, locale: lang } });
    if (!r) return;
    setNote({ tone: "info", text: r.deduplicated ? c.job_deduplicated : s.queued });
    setJobUrl(`${base}/jobs/${encodeURIComponent(r.jobId)}`);
    void list.reload();
  }

  return (
    <>
      <div className="split">
        <Card title={s.pdf_title}>
          <div className="stack">
            <p className="hint">{s.pdf_intro}</p>
            <div className="radios">
              {KINDS.map((k) => (
                <label key={k} className={`radio ${kind === k ? "on" : "off"}`}>
                  <input type="radio" name="report-kind" checked={kind === k} onChange={() => setKind(k)} disabled={!ctx.canWrite} />
                  <span>
                    <b>{REPORT_KIND_LABELS[k]![locale]}</b>
                    <small>{REPORT_KIND_HELP[k]![locale]}</small>
                  </span>
                </label>
              ))}
            </div>
            <label className="field" style={{ maxWidth: 240 }}>
              {s.language}
              <select value={lang} onChange={(e) => setLang(e.target.value as Locale)} disabled={!ctx.canWrite}>
                <option value="fa">{s.lang_fa}</option>
                <option value="en">{s.lang_en}</option>
              </select>
            </label>
            {ctx.canWrite ? (
              <div className="row">
                <button type="button" className="btn primary" disabled={gen.busy || Boolean(jobUrl)} onClick={() => void generate()}>
                  <Icon name="doc" />
                  {jobUrl ? s.generating : s.generate}
                </button>
                {jobUrl && <JobLine state={job?.state} c={c} />}
              </div>
            ) : (
              <p className="muted small">{c.read_only}</p>
            )}
            {gen.error && <Flash tone="crit">{gen.error}</Flash>}
            {note && <Flash tone={note.tone}>{note.text}</Flash>}
          </div>
        </Card>
        <BrandCard ctx={ctx} s={s} c={c} />
      </div>

      <Card title={s.list} bare>
        {del.error && (
          <div style={{ padding: "10px 18px 0" }}>
            <Flash tone="crit">{del.error}</Flash>
          </div>
        )}
        {!list.data ? (
          list.error ? (
            <div style={{ padding: 18 }}>
              <Flash tone="crit">{list.error}</Flash>
            </div>
          ) : (
            <Loading label={c.loading} />
          )
        ) : list.data.reports.length === 0 && list.data.pending.length === 0 ? (
          <div className="empty">
            <Icon name="doc" />
            <div>{s.empty}</div>
          </div>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{s.col_file}</th>
                  <th>{s.col_kind}</th>
                  <th style={{ textAlign: "end" }}>{s.col_size}</th>
                  <th>{s.col_created}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.pending.map((p) => (
                  <tr key={p.jobId}>
                    <td className="muted">
                      <span className="spin" aria-hidden="true" /> {s.pending}
                    </td>
                    <td>{REPORT_KIND_LABELS[p.kind]?.[locale] ?? p.kind}</td>
                    <td />
                    <td className="muted small">{relative(p.queuedAt, locale)}</td>
                    <td />
                  </tr>
                ))}
                {list.data.reports.map((r) => (
                  <tr key={r.id}>
                    <td style={{ maxWidth: 320 }}>
                      <span className="url" dir="auto" translate="no">
                        {r.fileKey}
                      </span>
                    </td>
                    <td>{REPORT_KIND_LABELS[r.kind]?.[locale] ?? r.kind}</td>
                    <td className="tnum">{bytes(r.bytes, locale)}</td>
                    <td className="muted small">{relative(r.createdAt, locale)}</td>
                    <td style={{ textAlign: "end" }}>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <a className="btn ghost sm" href={`${base}/${encodeURIComponent(r.id)}/download?inline=1`} target="_blank" rel="noreferrer">
                          <Icon name="eye" />
                          {s.open}
                        </a>
                        <a className="btn ghost sm" href={`${base}/${encodeURIComponent(r.id)}/download`}>
                          <Icon name="dl" />
                          {s.download}
                        </a>
                        {ctx.canWrite && (
                          <ConfirmButton
                            label={c.delete}
                            confirmLabel={c.confirm}
                            disabled={del.busy}
                            onConfirm={async () => {
                              if (await del.run(`${base}/${encodeURIComponent(r.id)}`, { method: "DELETE" })) await list.reload();
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function BrandCard({ ctx, s, c }: { ctx: ReportsCtx; s: ReportStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const url = `/api/projects/${encodeURIComponent(ctx.projectId)}/reports/brand`;
  const brand = useLoad<{ brand: Brand }>(url, locale);
  const save = useAction(locale);
  const [edit, setEdit] = useState<{ name: string; color: string; logo: string | null } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const b = brand.data?.brand;
  const form = edit ?? (b ? { name: b.name ?? "", color: b.color ?? "#0e9a5c", logo: b.logo ?? null } : null);

  function pickFile(file: File | undefined) {
    setFileError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return setFileError(s.brand_logo_type);
    if (file.size > MAX_LOGO) return setFileError(s.brand_logo_too_big);
    const reader = new FileReader();
    reader.onload = () => form && setEdit({ ...form, logo: String(reader.result) });
    reader.readAsDataURL(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaved(false);
    const r = await save.run<{ brand: Brand }>(url, { method: "PUT", body: { name: form.name.trim() || null, color: form.color, logo: form.logo } });
    if (!r) return;
    setSaved(true);
    setEdit(null);
    await brand.reload();
  }

  return (
    <Card title={s.brand_title} sub={s.brand_intro}>
      {!form ? (
        brand.error ? <Flash tone="crit">{brand.error}</Flash> : <Loading label={c.loading} />
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="brand-preview" style={{ borderColor: form.color }}>
            {form.logo && (
              // A data URL the reader just chose or the stored logo; never a remote address.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.logo} alt={s.brand_logo} />
            )}
            <b translate="no" dir="auto">
              {form.name || b?.defaults.name}
            </b>
            <i style={{ background: form.color }} />
          </div>
          <label className="field">
            {s.brand_name}
            <input
              value={form.name}
              onChange={(e) => setEdit({ ...form, name: e.target.value })}
              dir="auto"
              maxLength={100}
              disabled={!ctx.canBrand}
              placeholder={b ? fmt(s.brand_name_default, { name: b.defaults.name }) : undefined}
              translate="no"
            />
          </label>
          <div className="formgrid">
            <label className="field">
              {s.brand_color}
              <span className="row" style={{ flexWrap: "nowrap" }}>
                <input type="color" value={form.color} onChange={(e) => setEdit({ ...form, color: e.target.value })} disabled={!ctx.canBrand} style={{ width: 48, height: 34, padding: 2 }} aria-label={s.brand_color} />
                <input value={form.color} onChange={(e) => setEdit({ ...form, color: e.target.value })} dir="ltr" pattern="^#[0-9a-fA-F]{6}$" disabled={!ctx.canBrand} aria-label={s.brand_color} />
              </span>
            </label>
            <div className="field">
              {s.brand_logo}
              {/* The native file button speaks the browser's language, not the panel's; this one is ours. */}
              <label className={`btn${ctx.canBrand ? "" : " disabled"}`} style={{ alignSelf: "flex-start" }}>
                <Icon name="upload" />
                {s.brand_logo_pick}
                <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => pickFile(e.target.files?.[0])} disabled={!ctx.canBrand} />
              </label>
              <span className="hint">
                <Rich text={s.brand_logo_help} />
              </span>
            </div>
          </div>
          {fileError && <Flash tone="crit">{fileError}</Flash>}
          {save.error && <Flash tone="crit">{save.error}</Flash>}
          {saved && <Flash tone="ok">{s.brand_saved}</Flash>}
          {ctx.canBrand ? (
            <div className="row">
              <button type="submit" className="btn primary" disabled={save.busy}>
                <Icon name="check" />
                {save.busy ? c.saving : s.brand_save}
              </button>
              {form.logo && (
                <button type="button" className="btn ghost" onClick={() => setEdit({ ...form, logo: null })}>
                  <Icon name="x" />
                  {s.brand_remove_logo}
                </button>
              )}
            </div>
          ) : (
            <p className="muted small">{c.read_only}</p>
          )}
        </form>
      )}
    </Card>
  );
}
