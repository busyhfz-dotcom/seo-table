"use client";

import { useMemo, useState } from "react";
import { Card } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { ConfirmButton, Flash, Loading, PosChange, Sheet, SourceBadge, useAction, useLoad, type Loaded } from "../../../components/kit";
import { decimal, num, pathOf, pct } from "../../../lib/format";
import { fmt } from "../../../lib/dict";
import { countryName } from "../../../lib/seo-labels";
import type { CommonStrings } from "../../../lib/common-strings";
import type { KeywordStrings } from "./strings";
import type { Ctx, KeywordList, KeywordRow } from "./types";
import { KeywordDetail } from "./detail";

type Sort = "recent" | "position" | "clicks" | "impressions" | "phrase";

export function TrackedPanel({
  ctx,
  s,
  c,
  list,
  onChanged,
}: {
  ctx: Ctx;
  s: KeywordStrings;
  c: CommonStrings;
  list: Loaded<KeywordList>;
  onChanged: () => Promise<void>;
}) {
  const { locale, projectId } = ctx;
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const [archived, setArchived] = useState(false);
  const archive = useLoad<KeywordList>(archived ? `${base}/keywords?archived=1` : null, locale);
  const shown = archived ? archive : list;
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const bulk = useAction(locale);
  const [bulkTag, setBulkTag] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = shown.data?.keywords ?? [];
    const needle = q.trim().toLocaleLowerCase();
    const filtered = all.filter((k) => (!needle || k.phrase.toLocaleLowerCase().includes(needle)) && (!tag || k.tags.includes(tag)));
    const pos = (k: KeywordRow) => k.gsc?.position ?? k.serp?.position ?? Infinity;
    const sorted = [...filtered];
    if (sort === "position") sorted.sort((a, b) => pos(a) - pos(b));
    if (sort === "clicks") sorted.sort((a, b) => (b.gsc?.clicks ?? -1) - (a.gsc?.clicks ?? -1));
    if (sort === "impressions") sorted.sort((a, b) => (b.gsc?.impressions ?? -1) - (a.gsc?.impressions ?? -1));
    if (sort === "phrase") sorted.sort((a, b) => a.phrase.localeCompare(b.phrase, locale));
    return sorted;
  }, [shown.data, q, tag, sort, locale]);

  const tags = list.data?.tags ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const showSerp = ctx.sources.dataforseo || rows.some((r) => r.serp);
  const showMetrics = rows.some((r) => r.metrics);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBulk(action: "archive" | "unarchive" | "delete" | "add_tag" | "remove_tag") {
    setNote(null);
    const r = await bulk.run<{ affected: number }>(`${base}/keywords/bulk`, {
      body: { action, ids: [...selected], ...(action.endsWith("_tag") ? { tag: bulkTag.trim() } : {}) },
    });
    if (!r) return;
    setNote(fmt(s.bulk_done, { n: num(r.affected, locale) }));
    setSelected(new Set());
    await Promise.all([onChanged(), archived ? archive.reload() : Promise.resolve()]);
  }

  const openRow = rows.find((r) => r.id === openId) ?? shown.data?.keywords.find((r) => r.id === openId) ?? null;

  return (
    <Card
      title={s.tab_tracked}
      right={
        <div className="toolbar">
          <div className="seg" role="group">
            <button type="button" aria-pressed={!archived} onClick={() => (setArchived(false), setSelected(new Set()))}>
              {s.active}
            </button>
            <button type="button" aria-pressed={archived} onClick={() => (setArchived(true), setSelected(new Set()))}>
              {s.archived}
            </button>
          </div>
          {ctx.canWrite && !archived && (
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              {s.add}
            </button>
          )}
        </div>
      }
      bare
    >
      <div className="toolbar" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <label className="search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={s.q_placeholder} aria-label={s.q_placeholder} />
        </label>
        {tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label={s.tags}>
            <option value="">{s.tag_all}</option>
            {tags.map((t) => (
              <option key={t} value={t} translate="no">
                {t}
              </option>
            ))}
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={s.sort_label}>
          <option value="recent">{s.sort_recent}</option>
          <option value="position">{s.sort_position}</option>
          <option value="clicks">{s.sort_clicks}</option>
          <option value="impressions">{s.sort_impr}</option>
          <option value="phrase">{s.sort_phrase}</option>
        </select>
      </div>

      {ctx.canWrite && selected.size > 0 && (
        <div className="bulkbar">
          <b>{fmt(c.selected_n, { n: num(selected.size, locale) })}</b>
          {archived ? (
            <button type="button" className="btn sm" disabled={bulk.busy} onClick={() => runBulk("unarchive")}>
              <Icon name="undo" />
              {s.bulk_unarchive}
            </button>
          ) : (
            <button type="button" className="btn sm" disabled={bulk.busy} onClick={() => runBulk("archive")}>
              <Icon name="box" />
              {s.bulk_archive}
            </button>
          )}
          <input value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder={s.tag_placeholder} aria-label={s.tag_placeholder} maxLength={40} />
          <button type="button" className="btn sm" disabled={bulk.busy || !bulkTag.trim()} onClick={() => runBulk("add_tag")}>
            <Icon name="tag" />
            {s.bulk_add_tag}
          </button>
          <button type="button" className="btn ghost sm" disabled={bulk.busy || !bulkTag.trim()} onClick={() => runBulk("remove_tag")}>
            {s.bulk_remove_tag}
          </button>
          <span className="spacer" />
          <ConfirmButton label={s.bulk_delete} confirmLabel={c.confirm} disabled={bulk.busy} onConfirm={() => runBulk("delete")} />
        </div>
      )}
      {bulk.error && (
        <div style={{ padding: "10px 14px 0" }}>
          <Flash tone="crit">{bulk.error}</Flash>
        </div>
      )}
      {note && (
        <div style={{ padding: "10px 14px 0" }}>
          <Flash tone="ok">{note}</Flash>
        </div>
      )}

      {!shown.data ? (
        shown.error ? (
          <div style={{ padding: 14 }}>
            <Flash tone="crit">{shown.error}</Flash>
          </div>
        ) : (
          <Loading label={c.loading} rows={5} />
        )
      ) : rows.length === 0 ? (
        <div className="empty">
          <Icon name="search" />
          <div>{shown.data.keywords.length === 0 ? (archived ? s.empty_archived : s.empty_tracked) : s.empty_filtered}</div>
          {!archived && shown.data.keywords.length === 0 && ctx.canWrite && (
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              {s.add}
            </button>
          )}
        </div>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                {ctx.canWrite && (
                  <th className="check">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      aria-label={c.select_all}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                    />
                  </th>
                )}
                <th>{s.col_keyword}</th>
                <th style={{ textAlign: "end" }}>{s.col_pos_gsc}</th>
                <th style={{ textAlign: "end" }}>{s.col_change}</th>
                {showSerp && <th style={{ textAlign: "end" }}>{s.col_pos_serp}</th>}
                <th style={{ textAlign: "end" }}>{s.col_clicks}</th>
                <th style={{ textAlign: "end" }}>{s.col_impr}</th>
                <th style={{ textAlign: "end" }}>{s.col_ctr}</th>
                {showMetrics && <th style={{ textAlign: "end" }}>{s.col_volume}</th>}
                <th>{s.col_url}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <Row key={k.id} k={k} ctx={ctx} s={s} c={c} selected={selected.has(k.id)} onToggle={() => toggle(k.id)} onOpen={() => setOpenId(k.id)} showSerp={showSerp} showMetrics={showMetrics} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddKeywords
        open={adding}
        onClose={() => setAdding(false)}
        ctx={ctx}
        s={s}
        c={c}
        onAdded={async () => {
          await onChanged();
        }}
      />
      <Sheet
        open={Boolean(openRow)}
        onClose={() => setOpenId(null)}
        closeLabel={c.close}
        title={openRow ? <span translate="no" dir="auto">{openRow.phrase}</span> : ""}
        sub={openRow ? fmt(s.market, { country: countryName(openRow.country, locale), lang: openRow.locale === "en" ? s.lang_en : s.lang_fa }) : undefined}
      >
        {openRow && (
          <KeywordDetail
            key={openRow.id}
            k={openRow}
            ctx={ctx}
            s={s}
            c={c}
            onChanged={async (closed) => {
              if (closed) setOpenId(null);
              await Promise.all([onChanged(), archived ? archive.reload() : Promise.resolve()]);
            }}
          />
        )}
      </Sheet>
    </Card>
  );
}

function Row({
  k,
  ctx,
  s,
  c,
  selected,
  onToggle,
  onOpen,
  showSerp,
  showMetrics,
}: {
  k: KeywordRow;
  ctx: Ctx;
  s: KeywordStrings;
  c: CommonStrings;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  showSerp: boolean;
  showMetrics: boolean;
}) {
  const { locale } = ctx;
  const ranking = k.gsc?.url ?? k.serp?.url ?? null;
  const differs = Boolean(k.targetUrl && ranking && !samePage(k.targetUrl, ranking));
  const ctr = k.gsc && k.gsc.impressions > 0 ? k.gsc.clicks / k.gsc.impressions : null;
  return (
    <tr className={`clickable${selected ? " selected" : ""}`} onClick={onOpen}>
      {ctx.canWrite && (
        <td className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={fmt(s.select_row, { k: k.phrase })} />
        </td>
      )}
      <td>
        <button type="button" className="lnk-plain" onClick={onOpen}>
          <span translate="no" dir="auto" style={{ fontWeight: 500 }}>
            {k.phrase}
          </span>
        </button>
        <div className="cell-sub">
          <span>{countryName(k.country, locale)}</span>
          {k.device && <span>· {k.device === "mobile" ? s.device_mobile : s.device_desktop}</span>}
          {k.tags.map((t) => (
            <span key={t} className="pill mute" translate="no">
              {t}
            </span>
          ))}
        </div>
      </td>
      <td className="tnum">
        {k.gsc?.position != null ? (
          <b>{decimal(k.gsc.position, locale)}</b>
        ) : (
          <span className="muted small">{k.gsc ? "—" : s.no_data_yet}</span>
        )}
      </td>
      <td className="tnum">
        <PosChange current={k.gsc?.position ?? null} previous={k.gsc?.previousPosition ?? null} locale={locale} />
      </td>
      {showSerp && (
        <td className="tnum">
          {k.serp ? (
            k.serp.position === null ? (
              <span className="muted small">{s.not_in_top100}</span>
            ) : (
              <b>{num(k.serp.position, locale)}</b>
            )
          ) : (
            "—"
          )}
        </td>
      )}
      <td className="tnum">{k.gsc ? num(k.gsc.clicks, locale) : "—"}</td>
      <td className="tnum">{k.gsc ? num(k.gsc.impressions, locale) : "—"}</td>
      <td className="tnum">{ctr === null ? "—" : pct(ctr, locale)}</td>
      {showMetrics && <td className="tnum">{k.metrics?.volume != null ? num(k.metrics.volume, locale) : "—"}</td>}
      <td style={{ maxWidth: 260 }}>
        {ranking ? (
          <span className="path" dir="ltr">
            {pathOf(ranking)}
          </span>
        ) : (
          <span className="muted small">—</span>
        )}
        {differs && (
          <div className="cell-sub">
            <span className="pill warn">
              <Icon name="alert" />
              {s.target_differs}
            </span>
          </div>
        )}
        {(k.gsc || k.serp) && (
          <div className="cell-sub">
            {k.gsc && <SourceBadge source="gsc" c={c} />}
            {k.serp && <SourceBadge source="serp" c={c} />}
          </div>
        )}
      </td>
    </tr>
  );
}

export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const p = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
    return x.hostname.replace(/^www\./, "") === y.hostname.replace(/^www\./, "") && p(x) === p(y);
  } catch {
    return a === b;
  }
}

export function AddKeywords({
  open,
  onClose,
  ctx,
  s,
  c,
  onAdded,
  initial = "",
}: {
  open: boolean;
  onClose: () => void;
  ctx: Ctx;
  s: KeywordStrings;
  c: CommonStrings;
  onAdded: () => Promise<void>;
  initial?: string;
}) {
  const { locale } = ctx;
  const [phrases, setPhrases] = useState(initial);
  const [country, setCountry] = useState("IR");
  const [lang, setLang] = useState<"fa" | "en">(locale);
  const [device, setDevice] = useState<"" | "desktop" | "mobile">("");
  const [tags, setTags] = useState("");
  const add = useAction(locale);
  const [result, setResult] = useState<string | null>(null);
  const count = phrases.split(/\r?\n|[,،]/).filter((l) => l.trim()).length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const r = await add.run<{ added: unknown[]; skipped: number }>(`/api/projects/${encodeURIComponent(ctx.projectId)}/keywords`, {
      body: {
        phrases,
        country,
        locale: lang,
        device: device || null,
        tags: tags
          .split(/[,،]/)
          .map((t) => t.trim())
          .filter(Boolean),
      },
    });
    if (!r) return;
    setResult(fmt(s.add_result, { added: num(r.added.length, locale), skipped: num(r.skipped, locale) }));
    setPhrases("");
    await onAdded();
  }

  return (
    <Sheet open={open} onClose={() => (setResult(null), onClose())} title={s.add_title} closeLabel={c.close} size="narrow">
      <form className="stack" onSubmit={submit}>
        <label className="field">
          {s.add_phrases}
          <textarea
            value={phrases}
            onChange={(e) => setPhrases(e.target.value)}
            rows={8}
            dir="auto"
            placeholder={s.add_placeholder}
            required
          />
          <span className="hint">
            {s.add_help} {count > 0 && `· ${fmt(s.add_count, { n: num(count, locale) })}`}
          </span>
        </label>
        <div className="formgrid">
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
          <label className="field">
            {s.device}
            <select value={device} onChange={(e) => setDevice(e.target.value as "" | "desktop" | "mobile")}>
              <option value="">{s.device_any}</option>
              <option value="desktop">{s.device_desktop}</option>
              <option value="mobile">{s.device_mobile}</option>
            </select>
          </label>
          <label className="field">
            {s.tags}
            <input value={tags} onChange={(e) => setTags(e.target.value)} dir="auto" />
            <span className="hint">{s.tags_help}</span>
          </label>
        </div>
        {add.error && <Flash tone="crit">{add.error}</Flash>}
        {result && <Flash tone="ok">{result}</Flash>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {c.close}
          </button>
          <button type="submit" className="btn primary" disabled={add.busy || count === 0}>
            <Icon name="plus" />
            {add.busy ? c.saving : s.add_submit}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
