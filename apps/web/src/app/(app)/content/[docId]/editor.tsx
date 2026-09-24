"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../../../components/icons";
import { ConfirmButton, Flash, Loading, useAction } from "../../../../components/kit";
import { callApi } from "../../../../lib/errors-ui";
import { num } from "../../../../lib/format";
import { fmt } from "../../../../lib/dict";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { Locale } from "../../../../lib/i18n";
import type { ContentStrings } from "../strings";
import { AnalysisPanel, type Analysis } from "./analysis";
import { PublishPanel, type PublishState } from "./publish";
import { RichText, type RichHandle } from "./rich";

export type EditorDoc = {
  id: string;
  title: string;
  targetKeyword: string | null;
  locale: string;
  body: string;
  url: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  score: number | null;
  analysis: Analysis | null;
  publish: PublishState | null;
  updatedAt: string;
};

type Ctx = {
  projectId: string;
  baseUrl: string;
  locale: Locale;
  canWrite: boolean;
  canApprove: boolean;
  canRollback: boolean;
  wordpress: boolean;
  listHref: string;
  connectHref: string;
};

type Fields = { title: string; targetKeyword: string; locale: "fa" | "en"; url: string; metaTitle: string; metaDescription: string };

export function Editor({ doc, s, c, ctx }: { doc: EditorDoc; s: ContentStrings; c: CommonStrings; ctx: Ctx }) {
  const { locale } = ctx;
  const router = useRouter();
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/content/${encodeURIComponent(doc.id)}`;
  const rich = useRef<RichHandle>(null);
  const [fields, setFields] = useState<Fields>({
    title: doc.title,
    targetKeyword: doc.targetKeyword ?? "",
    locale: doc.locale === "en" ? "en" : "fa",
    url: doc.url ?? "",
    metaTitle: doc.metaTitle ?? "",
    metaDescription: doc.metaDescription ?? "",
  });
  const [body, setBody] = useState(doc.body);
  const [dirty, setDirty] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(doc.analysis);
  const [analyzing, setAnalyzing] = useState(false);
  const [publish, setPublish] = useState<PublishState | null>(doc.publish);
  // Publishing uses the stored document, so it follows the saved URL, not the field being edited.
  const [savedUrl, setSavedUrl] = useState(doc.url);
  const [images, setImages] = useState<Array<{ src: string; alt: string }>>([]);
  const save = useAction(locale);
  const del = useAction(locale);
  const seq = useRef(0);

  const payload = useCallback(
    () => ({
      title: fields.title.trim() || doc.title,
      targetKeyword: fields.targetKeyword.trim() || null,
      locale: fields.locale,
      body: rich.current?.html() ?? body,
      url: fields.url.trim() || null,
      metaTitle: fields.metaTitle.trim() || null,
      metaDescription: fields.metaDescription.trim() || null,
    }),
    [fields, body, doc.title],
  );

  // Live analysis of the unsaved draft, a moment after typing stops.
  useEffect(() => {
    if (!dirty) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setAnalyzing(true);
      const draft = payload();
      const r = await callApi<{ analysis: Analysis }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/content/analyze`, {
        method: "POST",
        body: { ...draft, url: draft.url && /^https?:\/\//.test(draft.url) ? draft.url : null },
      });
      if (mine !== seq.current) return;
      setAnalyzing(false);
      if (r.ok) setAnalysis(r.data.analysis);
    }, 1200);
    return () => clearTimeout(t);
  }, [fields, body, dirty, payload, ctx.projectId]);

  // The images in the text, for editing their alt text.
  useEffect(() => {
    const parsed = new DOMParser().parseFromString(body, "text/html");
    setImages(Array.from(parsed.querySelectorAll("img")).map((i) => ({ src: i.getAttribute("src") ?? "", alt: i.getAttribute("alt") ?? "" })));
  }, [body]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = s.leave_warning;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, s.leave_warning]);

  const doSave = useCallback(async () => {
    const r = await save.run<{ document: EditorDoc }>(base, { method: "PATCH", body: payload() });
    if (!r) return;
    seq.current++;
    setAnalyzing(false);
    setDirty(false);
    setAnalysis(r.document.analysis);
    setPublish(r.document.publish);
    setSavedUrl(r.document.url);
  }, [save, base, payload]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (ctx.canWrite && dirty) void doSave();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [doSave, dirty, ctx.canWrite]);

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFields((f) => ({ ...f, [k]: e.target.value }));
    setDirty(true);
  };
  const dir = fields.locale === "fa" ? "rtl" : "ltr";
  const ro = !ctx.canWrite;

  return (
    <>
      <div className="editor-top">
        <Link className="btn ghost sm" href={ctx.listHref}>
          <Icon name={locale === "fa" ? "arrowR" : "arrowL"} />
          {s.back}
        </Link>
        <span className="spacer" />
        <span className={`pill ${dirty ? "warn" : "ok"}`} role="status">
          {save.busy ? s.saving : dirty ? s.unsaved : s.saved}
        </span>
        <a className="btn ghost sm" href={`${base}/export`}>
          <Icon name="dl" />
          {s.export}
        </a>
        {ctx.canWrite && (
          <>
            <ConfirmButton
              label={s.delete_doc}
              confirmLabel={c.confirm}
              disabled={del.busy}
              onConfirm={async () => {
                if (await del.run(base, { method: "DELETE" })) {
                  setDirty(false);
                  router.push(ctx.listHref);
                }
              }}
            />
            <button type="button" className="btn primary" disabled={!dirty || save.busy} onClick={() => void doSave()}>
              <Icon name="check" />
              {save.busy ? s.saving : s.save}
            </button>
          </>
        )}
      </div>
      {save.error && <Flash tone="crit">{save.error}</Flash>}
      {del.error && <Flash tone="crit">{del.error}</Flash>}

      <div className="editor-grid">
        <div className="stack">
          <section className="card">
            <div className="body stack">
              <input
                className="doc-title"
                value={fields.title}
                onChange={set("title")}
                placeholder={s.title_placeholder}
                aria-label={s.title}
                dir={dir}
                maxLength={300}
                readOnly={ro}
                translate="no"
              />
              <div className="formgrid">
                <label className="field">
                  {s.keyword}
                  <input value={fields.targetKeyword} onChange={set("targetKeyword")} dir="auto" maxLength={150} placeholder={s.keyword_placeholder} readOnly={ro} />
                </label>
                <label className="field">
                  {s.language}
                  <select value={fields.locale} onChange={set("locale")} disabled={ro}>
                    <option value="fa">{s.lang_fa}</option>
                    <option value="en">{s.lang_en}</option>
                  </select>
                </label>
                <label className="field span2">
                  {s.url}
                  <input value={fields.url} onChange={set("url")} dir="ltr" placeholder={`${ctx.baseUrl.replace(/\/$/, "")}/…`} readOnly={ro} />
                  <span className="hint">{s.url_help}</span>
                </label>
                <label className="field span2">
                  <span className="row" style={{ justifyContent: "space-between" }}>
                    {s.meta_title}
                    <span className="muted small">{fmt(s.chars, { n: num([...fields.metaTitle].length, locale) })}</span>
                  </span>
                  <input value={fields.metaTitle} onChange={set("metaTitle")} dir={dir} maxLength={300} readOnly={ro} />
                  <span className="hint">{s.meta_title_help}</span>
                </label>
                <label className="field span2">
                  <span className="row" style={{ justifyContent: "space-between" }}>
                    {s.meta_desc}
                    <span className="muted small">{fmt(s.chars, { n: num([...fields.metaDescription].length, locale) })}</span>
                  </span>
                  <textarea value={fields.metaDescription} onChange={set("metaDescription")} dir={dir} rows={3} maxLength={1000} readOnly={ro} />
                </label>
              </div>
            </div>
          </section>

          <section className="card">
            <RichText
              ref={rich}
              initial={doc.body}
              dir={dir}
              s={s}
              c={c}
              disabled={ro}
              onChange={(html) => {
                setBody(html);
                setDirty(true);
              }}
            />
          </section>

          {images.length > 0 && (
            <section className="card">
              <header>
                <h3>{s.images_title}</h3>
              </header>
              <div className="body stack">
                {images.map((img, i) => (
                  <label key={`${img.src}-${i}`} className="field">
                    <span className="url" dir="ltr">
                      {img.src}
                    </span>
                    <input
                      defaultValue={img.alt}
                      dir="auto"
                      placeholder={s.image_no_alt}
                      aria-label={s.image_alt}
                      readOnly={ro}
                      onBlur={(e) => {
                        if (e.target.value !== img.alt) rich.current?.setAlt(i, e.target.value);
                      }}
                    />
                  </label>
                ))}
                <span className="hint">{s.image_alt_help}</span>
              </div>
            </section>
          )}
        </div>

        <aside className="editor-side">
          {analysis ? (
            <AnalysisPanel
              a={analysis}
              s={s}
              c={c}
              locale={locale}
              busy={analyzing}
              url={fields.url || null}
              baseUrl={ctx.baseUrl}
              canWrite={ctx.canWrite}
              onInsertLink={(url, anchor) => rich.current?.insertLink(url, anchor)}
            />
          ) : (
            <Loading label={s.analyzing} />
          )}
          <PublishPanel
            docUrl={savedUrl}
            base={base}
            state={publish}
            onChange={setPublish}
            dirty={dirty}
            s={s}
            c={c}
            locale={locale}
            perms={{ write: ctx.canWrite, approve: ctx.canApprove, rollback: ctx.canRollback }}
            wordpress={ctx.wordpress}
            connectHref={ctx.connectHref}
          />
        </aside>
      </div>
    </>
  );
}
