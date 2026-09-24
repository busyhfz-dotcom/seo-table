"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { ConfirmButton, Flash, Loading, ScoreRing, Sheet, SourceBadge, useAction, useLoad } from "../../../components/kit";
import { longDate, num, pathOf, relative, decimal } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import { PUBLISH_STATUS } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { Locale } from "../../../lib/i18n";
import type { ContentStrings } from "./strings";

type Doc = {
  id: string;
  title: string;
  targetKeyword: string | null;
  locale: string;
  score: number | null;
  url: string | null;
  updatedAt: string;
  publishStatus: string | null;
};
type Brief = {
  keyword: string;
  lang: "fa" | "en";
  sources: { gsc: boolean; competitorPages: number; crawl: boolean };
  period: { from: string; to: string } | null;
  queries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  questions: string[];
  ourPages: Array<{ url: string; title: string | null; clicks: number; impressions: number; bestPosition: number; words: number | null }>;
  competitorPages: Array<{ url: string; domain: string; title: string | null; words: number; h2: string[] }>;
  outline: Array<{ heading: string; sites: number; source: "competitors" | "gsc_question" }>;
  targets: { words: number | null; titleChars: [number, number]; descriptionChars: [number, number] };
};

export type DocumentsCtx = { projectId: string; baseUrl: string; locale: Locale; canWrite: boolean; editorHref: string };

export function DocumentsScreen({ ctx, s, c }: { ctx: DocumentsCtx; s: ContentStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/content`;
  const docs = useLoad<{ documents: Doc[] }>(base, locale);
  const del = useAction(locale);
  const [dialog, setDialog] = useState<"new" | "import" | "brief" | null>(null);
  const open = (id: string) => ctx.editorHref.replace("__ID__", encodeURIComponent(id));

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <p className="desc" style={{ maxWidth: 720 }}>
          {s.docs_intro}
        </p>
        {ctx.canWrite && (
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => setDialog("brief")}>
              <Icon name="list" />
              {s.brief}
            </button>
            <button type="button" className="btn" onClick={() => setDialog("import")}>
              <Icon name="dl" />
              {s.import}
            </button>
            <button type="button" className="btn primary" onClick={() => setDialog("new")}>
              <Icon name="plus" />
              {s.new_doc}
            </button>
          </div>
        )}
      </div>
      {del.error && <Flash tone="crit">{del.error}</Flash>}

      <Card title={s.tab_docs} sub={docs.data ? num(docs.data.documents.length, locale) : undefined} bare>
        {!docs.data ? (
          docs.error ? (
            <div style={{ padding: 18 }}>
              <Flash tone="crit">{docs.error}</Flash>
            </div>
          ) : (
            <Loading label={c.loading} rows={4} />
          )
        ) : docs.data.documents.length === 0 ? (
          <div className="empty">
            <Icon name="pen" />
            <div style={{ maxWidth: 420 }}>{s.empty}</div>
            {ctx.canWrite && (
              <button type="button" className="btn primary" onClick={() => setDialog("new")}>
                <Icon name="plus" />
                {s.new_doc}
              </button>
            )}
          </div>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{s.col_title}</th>
                  <th>{s.col_keyword}</th>
                  <th>{s.col_score}</th>
                  <th>{s.col_publish}</th>
                  <th>{s.col_updated}</th>
                  {ctx.canWrite && <th />}
                </tr>
              </thead>
              <tbody>
                {docs.data.documents.map((d) => {
                  const pub = d.publishStatus ? PUBLISH_STATUS[d.publishStatus] : null;
                  return (
                    <tr key={d.id}>
                      <td style={{ maxWidth: 360 }}>
                        <Link href={open(d.id)} className="lnk-plain" style={{ fontWeight: 500 }}>
                          <span translate="no" dir="auto">
                            {d.title}
                          </span>
                        </Link>
                        <div className="cell-sub">
                          <span>{d.locale === "en" ? s.lang_en : s.lang_fa}</span>
                          {d.url && (
                            <span className="path" dir="ltr">
                              {pathOf(d.url)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {d.targetKeyword ? (
                          <span translate="no" dir="auto">
                            {d.targetKeyword}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <ScoreRing score={d.score} locale={locale} label={s.col_score} size={36} />
                      </td>
                      <td>{pub ? <span className={`pill ${pub.tone}`}>{pub[locale]}</span> : <span className="muted">—</span>}</td>
                      <td className="muted small">{relative(d.updatedAt, locale)}</td>
                      {ctx.canWrite && (
                        <td style={{ textAlign: "end" }}>
                          <ConfirmButton
                            label={c.delete}
                            confirmLabel={c.confirm}
                            disabled={del.busy}
                            onConfirm={async () => {
                              if (await del.run(`${base}/${encodeURIComponent(d.id)}`, { method: "DELETE" })) await docs.reload();
                            }}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewDocument open={dialog === "new"} onClose={() => setDialog(null)} ctx={ctx} s={s} c={c} openDoc={open} />
      <ImportDocument open={dialog === "import"} onClose={() => setDialog(null)} ctx={ctx} s={s} c={c} openDoc={open} />
      <BriefDialog open={dialog === "brief"} onClose={() => setDialog(null)} ctx={ctx} s={s} c={c} openDoc={open} />
    </>
  );
}

function NewDocument({ open, onClose, ctx, s, c, openDoc }: DialogProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [keyword, setKeyword] = useState("");
  const [lang, setLang] = useState<"fa" | "en">(ctx.locale);
  const create = useAction(ctx.locale);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await create.run<{ document: { id: string } }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/content`, {
      body: { title: title.trim(), targetKeyword: keyword.trim() || null, locale: lang },
    });
    if (r) router.push(openDoc(r.document.id));
  }
  return (
    <Sheet open={open} onClose={onClose} title={s.new_title} closeLabel={c.close} size="narrow">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          {s.title}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={s.title_placeholder} dir="auto" required maxLength={300} />
        </label>
        <label className="field">
          {s.keyword}
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={s.keyword_placeholder} dir="auto" maxLength={150} />
        </label>
        <label className="field">
          {s.language}
          <select value={lang} onChange={(e) => setLang(e.target.value as "fa" | "en")}>
            <option value="fa">{s.lang_fa}</option>
            <option value="en">{s.lang_en}</option>
          </select>
        </label>
        {create.error && <Flash tone="crit">{create.error}</Flash>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {c.cancel}
          </button>
          <button type="submit" className="btn primary" disabled={create.busy || !title.trim()}>
            <Icon name="plus" />
            {create.busy ? c.saving : s.create}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

type DialogProps = { open: boolean; onClose: () => void; ctx: DocumentsCtx; s: ContentStrings; c: CommonStrings; openDoc: (id: string) => string };

function ImportDocument({ open, onClose, ctx, s, c, openDoc }: DialogProps) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [keyword, setKeyword] = useState("");
  const run = useAction(ctx.locale);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await run.run<{ document: { id: string } }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/content/import`, {
      body: { url: new URL(url.trim(), ctx.baseUrl).toString(), targetKeyword: keyword.trim() || null },
    });
    if (r) router.push(openDoc(r.document.id));
  }
  return (
    <Sheet open={open} onClose={onClose} title={s.import_title} closeLabel={c.close} size="narrow">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          {s.import_url}
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`${ctx.baseUrl.replace(/\/$/, "")}/…`} dir="ltr" required />
          <span className="hint">{s.import_help}</span>
        </label>
        <label className="field">
          {s.keyword}
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={s.keyword_placeholder} dir="auto" maxLength={150} />
        </label>
        {run.error && <Flash tone="crit">{run.error}</Flash>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {c.cancel}
          </button>
          <button type="submit" className="btn primary" disabled={run.busy || !url.trim()}>
            <Icon name="dl" />
            {run.busy ? c.loading : s.import_submit}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function BriefDialog({ open, onClose, ctx, s, c, openDoc }: DialogProps) {
  const router = useRouter();
  const { locale } = ctx;
  const [keyword, setKeyword] = useState("");
  const [lang, setLang] = useState<"fa" | "en">(locale);
  const run = useAction(locale);
  const create = useAction(locale);
  const [brief, setBrief] = useState<Brief | null>(null);

  async function build(e: React.FormEvent) {
    e.preventDefault();
    const r = await run.run<{ brief: Brief }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/content/brief`, { body: { keyword: keyword.trim(), locale: lang } });
    setBrief(r?.brief ?? null);
  }

  async function createFromBrief() {
    if (!brief) return;
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const body = brief.outline.map((o) => `<h2>${esc(o.heading)}</h2><p></p>`).join("");
    const r = await create.run<{ document: { id: string } }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/content`, {
      body: { title: brief.keyword, targetKeyword: brief.keyword, locale: brief.lang, body },
    });
    if (r) router.push(openDoc(r.document.id));
  }

  return (
    <Sheet open={open} onClose={onClose} title={s.brief_title} closeLabel={c.close}>
      <p className="hint">{s.brief_help}</p>
      <form className="row" onSubmit={build}>
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={s.keyword_placeholder} aria-label={s.keyword} dir="auto" required maxLength={150} style={{ flex: "1 1 220px", width: "auto" }} />
        <select value={lang} onChange={(e) => setLang(e.target.value as "fa" | "en")} aria-label={s.language} style={{ width: "auto" }}>
          <option value="fa">{s.lang_fa}</option>
          <option value="en">{s.lang_en}</option>
        </select>
        <button type="submit" className="btn primary" disabled={run.busy || !keyword.trim()}>
          <Icon name="list" />
          {run.busy ? c.loading : s.brief_run}
        </button>
      </form>
      {run.error && <Flash tone="crit">{run.error}</Flash>}
      {brief && (
        <>
          <div className="row">
            {brief.sources.gsc ? <SourceBadge source="gsc" c={c} /> : <span className="pill mute">{s.brief_gsc_off}</span>}
            {brief.sources.competitorPages > 0 ? (
              <span className="pill info">{fmt(s.src_comp, { n: num(brief.sources.competitorPages, locale) })}</span>
            ) : (
              <span className="pill mute">{s.brief_no_comp}</span>
            )}
            {brief.period && <span className="muted small">{fmt(s.brief_period, { from: longDate(brief.period.from, locale), to: longDate(brief.period.to, locale) })}</span>}
          </div>
          <div className="statgrid">
            <div className="stat">
              <span className="k">{s.brief_target_words}</span>
              <span className="v" style={{ fontSize: 18 }}>
                {brief.targets.words ? fmt(s.brief_words_n, { n: num(brief.targets.words, locale) }) : s.brief_words_unknown}
              </span>
            </div>
            <div className="stat">
              <span className="k">{s.meta_title}</span>
              <span className="f">{fmt(s.brief_title_len, { a: num(brief.targets.titleChars[0], locale), b: num(brief.targets.titleChars[1], locale) })}</span>
              <span className="f">{fmt(s.brief_desc_len, { a: num(brief.targets.descriptionChars[0], locale), b: num(brief.targets.descriptionChars[1], locale) })}</span>
            </div>
          </div>
          <section className="stack">
            <h4>{s.brief_outline}</h4>
            {brief.outline.length === 0 ? (
              <p className="muted small">{s.brief_empty}</p>
            ) : (
              <ol className="plain">
                {brief.outline.map((o) => (
                  <li key={o.heading}>
                    <span translate="no" dir="auto">
                      {o.heading}
                    </span>{" "}
                    <span className="muted small">
                      — {o.source === "competitors" ? fmt(s.brief_outline_src_comp, { n: num(o.sites, locale) }) : s.brief_outline_src_q}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {brief.queries.length > 0 && (
            <section className="stack">
              <h4>{s.brief_queries}</h4>
              <div className="tw">
                <table>
                  <tbody>
                    {brief.queries.slice(0, 20).map((q) => (
                      <tr key={q.query}>
                        <td>
                          <span translate="no" dir="auto">
                            {q.query}
                          </span>
                        </td>
                        <td className="tnum">{num(q.impressions, locale)}</td>
                        <td className="tnum">{num(q.clicks, locale)}</td>
                        <td className="tnum">{decimal(q.position, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {brief.questions.length > 0 && (
            <section className="stack">
              <h4>{s.brief_questions}</h4>
              <ul className="plain">
                {brief.questions.map((q) => (
                  <li key={q} translate="no" dir="auto">
                    {q}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {brief.competitorPages.length > 0 && (
            <section className="stack">
              <h4>{s.brief_comp_pages}</h4>
              <ul className="plain">
                {brief.competitorPages.slice(0, 10).map((p) => (
                  <li key={p.url}>
                    <span className="url" dir="ltr">
                      {p.domain}
                      {pathOf(p.url)}
                    </span>{" "}
                    <span className="muted small">· {fmt(s.words_now, { n: num(p.words, locale) })}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {ctx.canWrite && (
            <div>
              {create.error && <Flash tone="crit">{create.error}</Flash>}
              <button type="button" className="btn primary" disabled={create.busy} onClick={() => void createFromBrief()}>
                <Icon name="plus" />
                {s.brief_create}
              </button>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
