"use client";

/**
 * Preview a fix on the live page before anything is written: the page is
 * rendered twice in the panel's browser (POST /api/browser/render) — as it is,
 * and with the proposal's changes applied in the rendered DOM — and the two
 * screenshots and the SEO fields they expose are shown side by side.
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi } from "../../../lib/errors-ui";
import { num, pathOf } from "../../../lib/format";
import { fill, type Locale } from "../../../lib/i18n";
import { readableUrl } from "../../../lib/labels";
import type { ConnectStrings } from "../connect/keys";
import { RENDER_FIELD } from "./preview-fields";

type Change = { url: string; field: string; after: string; selector?: string };
type RenderChange = { field: string; value: string; selector?: string };
type Seo = { title: string | null; description: string | null; canonical: string | null; robots: string | null; h1: string[] };
type Render = { screenshot: string; seo: Seo; finalUrl: string; changesApplied?: number };
type Pair = { before: Render; after: Render };


function renderChanges(changes: Change[], url: string): RenderChange[] {
  return changes
    .filter((c) => c.url === url && RENDER_FIELD[c.field] && (c.field !== "img.alt" || c.selector))
    .map((c) => ({ field: RENDER_FIELD[c.field]!, value: c.after, ...(c.selector ? { selector: c.selector } : {}) }));
}

export function FixPreview({
  changes,
  projectId,
  locale,
  s,
}: {
  changes: Change[];
  projectId: string;
  locale: Locale;
  s: ConnectStrings;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const urls = [...new Set(changes.filter((c) => RENDER_FIELD[c.field]).map((c) => c.url))].slice(0, 25);
  const [url, setUrl] = useState(urls[0] ?? "");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Pair | null>(null);
  const [key, setKey] = useState<string | null>(null);

  const overrides = {
    BROWSER_UNAVAILABLE: { fa: s.br_unavailable, en: s.br_unavailable },
    BROWSER_BUSY: { fa: s.br_busy, en: s.br_busy },
    BLOCKED_ADDRESS: { fa: s.br_blocked, en: s.br_blocked },
  };

  async function run(target: string, dev: "desktop" | "mobile") {
    setBusy(true);
    setError(null);
    setResult(null);
    const render = (withChanges: boolean) =>
      callApi<Render>("/api/browser/render", {
        method: "POST",
        body: { url: target, device: dev, ...(withChanges ? { changes: renderChanges(changes, target) } : {}) },
      });
    const [before, after] = await Promise.all([render(false), render(true)]);
    setBusy(false);
    setKey(`${target}|${dev}`);
    if (!before.ok) return setError(apiErrorMessage(locale, before.failure, overrides));
    if (!after.ok) return setError(apiErrorMessage(locale, after.failure, overrides));
    setResult({ before: before.data, after: after.data });
  }

  function open() {
    dialog.current?.showModal();
    if (key !== `${url}|${device}`) void run(url, device);
  }

  // Changing the page or the device renders again, once the sheet is open.
  useEffect(() => {
    if (dialog.current?.open && key !== null && key !== `${url}|${device}` && !busy) void run(url, device);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, device]);

  if (urls.length === 0) return null;

  // The render reads the page's SEO fields before it applies the changes (they
  // live in <head> and never show in a screenshot), so the "with this fix"
  // column is the page's own values with the proposal's values laid over them.
  const planned = renderChanges(changes, url);
  const proposed = (field: string) => planned.find((c) => c.field === field)?.value;
  const before = result?.before.seo;
  const after = before && {
    title: proposed("title") ?? before.title,
    description: proposed("meta_description") ?? before.description,
    canonical: proposed("canonical") ?? before.canonical,
    robots: proposed("robots") ?? before.robots,
    h1: before.h1,
  };
  const rows: Array<{ label: string; before: string; after: string; ltr?: boolean }> =
    before && after
      ? [
          { label: s.br_title, before: before.title ?? "", after: after.title ?? "" },
          { label: s.br_description, before: before.description ?? "", after: after.description ?? "" },
          { label: s.br_canonical, before: before.canonical ?? "", after: after.canonical ?? "", ltr: true },
          { label: s.br_robots, before: before.robots ?? "", after: after.robots ?? "", ltr: true },
          { label: s.br_h1, before: before.h1.join(" | "), after: after.h1.join(" | ") },
        ]
      : [];
  const applied = result?.after.changesApplied;
  const host = (() => {
    try {
      return new URL(result?.before.finalUrl ?? url).host;
    } catch {
      return "";
    }
  })();

  return (
    <>
      <button type="button" className="btn ghost" onClick={open}>
        <Icon name="browser" />
        {s.preview}
      </button>
      <dialog ref={dialog} className="sheet" aria-labelledby={titleId} onClose={() => setBusy(false)}>
        <header>
          <h3 id={titleId}>{s.pv_title}</h3>
          <span className="spacer" />
          <button type="button" className="btn ghost sm" onClick={() => dialog.current?.close()}>
            <Icon name="x" />
            {s.close}
          </button>
        </header>
        <div className="sheet-body">
          <p className="muted">{s.pv_hint}</p>
          <div className="row">
            {urls.length > 1 && (
              <label className="field" style={{ flex: "1 1 260px" }}>
                <span>{s.pv_page}</span>
                <select value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" translate="no">
                  {urls.map((u) => (
                    <option key={u} value={u}>
                      {readableUrl(pathOf(u))}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="seg" role="group" aria-label={s.br_device}>
              {(["desktop", "mobile"] as const).map((d) => (
                <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)} disabled={busy}>
                  {d === "desktop" ? s.br_desktop : s.br_mobile}
                </button>
              ))}
            </div>
            <button type="button" className="btn ghost sm" onClick={() => run(url, device)} disabled={busy}>
              <Icon name="refresh" />
              {s.pv_render_again}
            </button>
            <Link className="btn ghost sm" href={`/browser?url=${encodeURIComponent(url)}&project=${encodeURIComponent(projectId)}`}>
              <Icon name="external" />
              {s.br_open}
            </Link>
          </div>

          {error && (
            <div className="note crit" role="alert">
              <Icon name="alert" />
              <div>{error}</div>
            </div>
          )}

          {before && after && (
            <div className="shots">
              {(["before", "after"] as const).map((side) => {
                const seo = side === "before" ? before : after;
                return (
                  <div key={side} className="serp">
                    <div className="serp-h">
                      <span className={`pill ${side === "after" ? "acc" : "mute"}`}>
                        {side === "after" ? s.pv_with_fix : s.pv_now}
                      </span>
                      <span className="small muted">
                        {s.pv_serp}
                      </span>
                    </div>
                    <div className="serp-url" dir="ltr" translate="no">
                      {host}
                      {readableUrl(pathOf(url))}
                    </div>
                    <div className="serp-title" dir="auto" translate="no">
                      {seo.title || "—"}
                    </div>
                    <div className="serp-desc" dir="auto" translate="no">
                      {seo.description || "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {applied !== undefined && applied < planned.length && (
            <div className="note" role="status">
              <Icon name="info" />
              <div>{fill(s.pv_applied, { n: num(applied, locale), m: num(planned.length, locale) })}</div>
            </div>
          )}

          <div className="shots" aria-busy={busy}>
            {(["before", "after"] as const).map((side) => (
              <figure key={side}>
                <figcaption>
                  <span className={`pill ${side === "after" ? "acc" : "mute"}`}>{side === "after" ? s.pv_with_fix : s.pv_now}</span>
                  <span className="url" dir="ltr" translate="no">
                    {readableUrl(pathOf(url))}
                  </span>
                </figcaption>
                {result ? (
                  // A one-off data: URL from the render; there is nothing for next/image to optimize.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`data:image/jpeg;base64,${result[side].screenshot}`}
                    alt={side === "after" ? s.pv_with_fix : s.pv_now}
                  />
                ) : (
                  <div className="shot-empty" role={busy ? "status" : undefined}>
                    {busy ? (
                      <span>
                        <span className="spin" aria-hidden="true" /> {s.pv_rendering}
                      </span>
                    ) : null}
                  </div>
                )}
              </figure>
            ))}
          </div>

          {result && (
            <div className="tw">
              <table className="seo-compare">
                <thead>
                  <tr>
                    <th />
                    <th>{s.pv_now}</th>
                    <th>{s.pv_with_fix}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const changed = r.before !== r.after;
                    return (
                      <tr key={r.label}>
                        <th scope="row">
                          {r.label}
                          <div className={`small ${changed ? "" : "muted"}`}>{changed ? s.pv_changed : s.pv_unchanged}</div>
                        </th>
                        <td translate="no" dir={r.ltr ? "ltr" : "auto"}>
                          {r.before || "—"}
                        </td>
                        <td translate="no" dir={r.ltr ? "ltr" : "auto"} className={changed ? "changed" : undefined}>
                          {r.after || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
