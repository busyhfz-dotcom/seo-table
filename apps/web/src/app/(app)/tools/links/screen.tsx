"use client";

import { useState } from "react";
import { Card } from "../../../../components/ui";
import { Icon } from "../../../../components/icons";
import { BarList, Flash, Loading, NotConfigured, Sheet, SourceBadge, useLoad } from "../../../../components/kit";
import { decimal, num, pathOf, pct, relative } from "../../../../lib/format";
import { fmt } from "../../../../lib/dict";
import { ANCHOR_SOURCE, LINK_REASON } from "../../../../lib/seo-labels";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { Locale } from "../../../../lib/i18n";
import type { ToolStrings } from "../strings";

type LinkedPage = { url: string; title: string | null; indexable: boolean; depth: number | null; inlinks: number; outlinks: number; equity: number; clicks: number | null };
type Suggestion = {
  source: { url: string; title: string | null; equity: number };
  target: { url: string; title: string | null; clicks: number | null };
  relevance: number;
  anchors: Array<{ text: string; source: "gsc" | "h1" | "title" }>;
  reason: "orphan" | "weak" | "related";
};
type Report =
  | { status: "no_scan" | "needs_rescan" }
  | {
      status: "ok";
      scannedAt: string | null;
      importance: "gsc" | "unknown";
      totals: { pages: number; links: number; nofollowLinks: number; orphans: number; weak: number };
      topDecileShare: number;
      inlinkHistogram: Array<{ bucket: string; pages: number }>;
      pages: LinkedPage[];
      orphans: LinkedPage[];
      weak: LinkedPage[];
      suggestions: Suggestion[];
    };
type PageReport =
  | { status: "no_scan" | "needs_rescan" }
  | {
      status: "ok";
      page: LinkedPage;
      inbound: Array<{ url: string; title: string | null; anchors: string[]; equity: number }>;
      outbound: Array<{ url: string; title: string | null; anchor: string }>;
      linkFrom: Suggestion[];
      linkTo: Suggestion[];
    };

export type LinksCtx = { projectId: string; baseUrl: string; locale: Locale; audit: string };

/** A path typed into the lookup is on this site. */
function absolute(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

export function LinksScreen({ ctx, s, c }: { ctx: LinksCtx; s: ToolStrings; c: CommonStrings }) {
  const { locale } = ctx;
  const report = useLoad<Report>(`/api/projects/${encodeURIComponent(ctx.projectId)}/internal-links`, locale);
  const [open, setOpen] = useState<string | null>(null);
  const [lookup, setLookup] = useState("");

  if (!report.data) return report.error ? <Flash tone="crit">{report.error}</Flash> : <Loading label={c.loading} rows={6} />;
  const r = report.data;
  if (r.status !== "ok") {
    return (
      <NotConfigured
        title={c.no_scan_title}
        body={r.status === "needs_rescan" ? c.needs_rescan : c.no_scan_body}
        action={c.go_audit}
        href={ctx.audit}
        icon="pulse"
      />
    );
  }
  const pageLink = (p: { url: string; title: string | null }) => (
    <button type="button" className="lnk-plain" onClick={() => setOpen(p.url)} style={{ textAlign: "start" }}>
      <span className="path" dir="ltr">
        {pathOf(p.url)}
      </span>
      {p.title && (
        <span className="cell-sub" translate="no" dir="auto">
          {p.title}
        </span>
      )}
    </button>
  );

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <p className="desc" style={{ maxWidth: 760 }}>
          {s.il_intro}
        </p>
        <div className="row">
          <SourceBadge source="crawl" c={c} />
          {r.importance === "gsc" && <SourceBadge source="gsc" c={c} title={s.il_importance_gsc} />}
          {r.scannedAt && <span className="muted small">{fmt(s.il_scanned, { when: relative(r.scannedAt, locale) })}</span>}
        </div>
      </div>
      {r.importance !== "gsc" && <Flash tone="info">{s.il_importance_none}</Flash>}

      <div className="statgrid">
        <Stat label={s.il_pages} value={num(r.totals.pages, locale)} />
        <Stat label={s.il_links} value={num(r.totals.links, locale)} />
        <Stat label={s.il_nofollow} value={num(r.totals.nofollowLinks, locale)} />
        <Stat label={s.il_orphans} value={num(r.totals.orphans, locale)} tone={r.totals.orphans ? "crit" : undefined} />
        <Stat label={s.il_weak} value={r.importance === "gsc" ? num(r.totals.weak, locale) : "—"} tone={r.totals.weak ? "warn" : undefined} />
        <Stat label={s.il_top_share} value={pct(r.topDecileShare, locale, 0)} />
      </div>

      <Card title={s.il_page_view}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (lookup.trim()) setOpen(lookup.trim());
          }}
        >
          <input value={lookup} onChange={(e) => setLookup(e.target.value)} dir="ltr" list="il-pages" aria-label={s.page_url} placeholder={s.page_url} style={{ flex: "1 1 260px", width: "auto" }} />
          <datalist id="il-pages">
            {r.pages.slice(0, 300).map((p) => (
              <option key={p.url} value={p.url} />
            ))}
          </datalist>
          <button type="submit" className="btn" disabled={!lookup.trim()}>
            <Icon name="search" />
            {c.open}
          </button>
        </form>
      </Card>

      <div className="split">
        <Card title={s.il_top} bare>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{c.page}</th>
                  <th>{s.il_equity}</th>
                  <th style={{ textAlign: "end" }}>{s.il_inlinks}</th>
                  <th style={{ textAlign: "end" }}>{s.il_outlinks}</th>
                  {r.importance === "gsc" && <th style={{ textAlign: "end" }}>{s.il_clicks}</th>}
                </tr>
              </thead>
              <tbody>
                {r.pages.slice(0, 25).map((p) => (
                  <tr key={p.url}>
                    <td style={{ maxWidth: 280 }}>{pageLink(p)}</td>
                    <td style={{ minWidth: 110 }}>
                      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                        <div className="bar" style={{ flex: 1 }}>
                          <i style={{ width: `${Math.max(2, p.equity)}%` }} />
                        </div>
                        <span className="num small">{decimal(p.equity, locale, 0)}</span>
                      </div>
                    </td>
                    <td className="tnum">{num(p.inlinks, locale)}</td>
                    <td className="tnum">{num(p.outlinks, locale)}</td>
                    {r.importance === "gsc" && <td className="tnum">{num(p.clicks, locale)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={s.il_histogram} sub={s.il_histogram_help}>
          <BarList locale={locale} items={r.inlinkHistogram.map((b) => ({ key: b.bucket, label: <span dir="ltr">{b.bucket}</span>, value: b.pages }))} />
        </Card>
      </div>

      <div className="grid g2">
        <PageList title={s.il_orphans} pages={r.orphans} empty={s.il_none} locale={locale} onOpen={setOpen} s={s} />
        <PageList title={s.il_weak} pages={r.weak} empty={r.importance === "gsc" ? s.il_none : s.il_importance_none} locale={locale} onOpen={setOpen} s={s} />
      </div>

      <Card title={s.il_suggestions} sub={s.il_sugg_help} bare>
        <SuggestionTable items={r.suggestions.slice(0, 50)} s={s} locale={locale} onOpen={setOpen} />
      </Card>

      <Sheet open={Boolean(open)} onClose={() => setOpen(null)} closeLabel={c.close} title={<span className="url" dir="ltr">{open ? pathOf(open) : ""}</span>}>
        {open && <PageDetail ctx={ctx} s={s} c={c} url={open} onOpen={setOpen} />}
      </Sheet>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <span className="k">{label}</span>
      <span className="v" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
    </div>
  );
}

function PageList({ title, pages, empty, locale, onOpen, s }: { title: string; pages: LinkedPage[]; empty: string; locale: Locale; onOpen: (u: string) => void; s: ToolStrings }) {
  return (
    <Card title={title} sub={num(pages.length, locale)} bare>
      {pages.length === 0 ? (
        <div className="empty">
          <Icon name="check" />
          <div>{empty}</div>
        </div>
      ) : (
        <ul className="movers" style={{ padding: "4px 18px 10px" }}>
          {pages.slice(0, 30).map((p) => (
            <li key={p.url}>
              <button type="button" className="lnk-plain ph path" dir="ltr" onClick={() => onOpen(p.url)}>
                {pathOf(p.url)}
              </button>
              {p.clicks !== null && (
                <span className="pos">
                  {num(p.clicks, locale)} {s.il_clicks}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SuggestionTable({ items, s, locale, onOpen }: { items: Suggestion[]; s: ToolStrings; locale: Locale; onOpen: (u: string) => void }) {
  if (!items.length)
    return (
      <div className="empty">
        <Icon name="check" />
        <div>{s.il_none}</div>
      </div>
    );
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            <th>{s.il_from}</th>
            <th>{s.il_to}</th>
            <th>{s.il_anchor}</th>
            <th>{s.il_reason}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((x, i) => (
            <tr key={i}>
              <td style={{ maxWidth: 220 }}>
                <button type="button" className="lnk-plain path" dir="ltr" onClick={() => onOpen(x.source.url)}>
                  {pathOf(x.source.url)}
                </button>
              </td>
              <td style={{ maxWidth: 220 }}>
                <button type="button" className="lnk-plain path" dir="ltr" onClick={() => onOpen(x.target.url)}>
                  {pathOf(x.target.url)}
                </button>
              </td>
              <td>
                {x.anchors.slice(0, 2).map((a) => (
                  <div key={a.text} className="cell-sub" title={ANCHOR_SOURCE[a.source]?.[locale]}>
                    <span translate="no" dir="auto" style={{ color: "var(--ink)" }}>
                      «{a.text}»
                    </span>
                  </div>
                ))}
              </td>
              <td>
                <span className={`pill ${x.reason === "orphan" ? "crit" : x.reason === "weak" ? "warn" : "mute"}`}>{LINK_REASON[x.reason]?.[locale] ?? x.reason}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PageDetail({ ctx, s, c, url, onOpen }: { ctx: LinksCtx; s: ToolStrings; c: CommonStrings; url: string; onOpen: (u: string) => void }) {
  const { locale } = ctx;
  const abs = absolute(url, ctx.baseUrl);
  const data = useLoad<PageReport>(abs ? `/api/projects/${encodeURIComponent(ctx.projectId)}/internal-links/page?url=${encodeURIComponent(abs)}` : null, locale);
  if (!abs) return <Flash tone="crit">{s.page_url}</Flash>;
  if (!data.data) return data.error ? <Flash tone="crit">{data.error}</Flash> : <Loading label={c.loading} />;
  const r = data.data;
  if (r.status !== "ok") return <p className="muted small">{r.status === "needs_rescan" ? c.needs_rescan : c.no_scan_body}</p>;
  return (
    <>
      <div className="statgrid">
        <Stat label={s.il_equity} value={decimal(r.page.equity, locale, 0)} />
        <Stat label={s.il_inlinks} value={num(r.page.inlinks, locale)} />
        <Stat label={s.il_outlinks} value={num(r.page.outlinks, locale)} />
        <Stat label={s.il_depth} value={num(r.page.depth, locale)} />
        {r.page.clicks !== null && <Stat label={s.il_clicks} value={num(r.page.clicks, locale)} />}
      </div>
      {!r.page.indexable && <span className="pill warn">{s.il_not_indexable}</span>}
      <section className="stack">
        <h4>{s.il_link_from}</h4>
        <SuggestionTable items={r.linkFrom} s={s} locale={locale} onOpen={onOpen} />
      </section>
      <section className="stack">
        <h4>{s.il_link_to}</h4>
        <SuggestionTable items={r.linkTo} s={s} locale={locale} onOpen={onOpen} />
      </section>
      <div className="grid g2">
        <section className="stack">
          <h4>
            {s.il_inbound} ({num(r.inbound.length, locale)})
          </h4>
          <ul className="plain">
            {r.inbound.slice(0, 50).map((l) => (
              <li key={l.url}>
                <button type="button" className="lnk-plain path" dir="ltr" onClick={() => onOpen(l.url)}>
                  {pathOf(l.url)}
                </button>{" "}
                {l.anchors[0] && (
                  <span className="muted small" translate="no" dir="auto">
                    «{l.anchors[0]}»
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="stack">
          <h4>
            {s.il_outbound} ({num(r.outbound.length, locale)})
          </h4>
          <ul className="plain">
            {r.outbound.slice(0, 50).map((l) => (
              <li key={l.url}>
                <button type="button" className="lnk-plain path" dir="ltr" onClick={() => onOpen(l.url)}>
                  {pathOf(l.url)}
                </button>{" "}
                {l.anchor && (
                  <span className="muted small" translate="no" dir="auto">
                    «{l.anchor}»
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
