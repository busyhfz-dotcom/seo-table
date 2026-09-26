"use client";

import { useState } from "react";
import { Icon } from "../../../../components/icons";
import { Flash, useAction } from "../../../../components/kit";
import { relative } from "../../../../lib/format";
import { fmt } from "../../../../lib/dict";
import { PUBLISH_STATUS } from "../../../../lib/seo-labels";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { Locale } from "../../../../lib/i18n";
import type { ContentStrings } from "../strings";

export type PublishState = {
  status: "pending" | "publishing" | "rejected" | "published" | "failed" | "rolled_back";
  mode: "draft" | "update";
  postType: string;
  requestedAt: string;
  decidedAt?: string;
  reason?: string;
  post?: { id: number; link: string | null; status: string | null };
  error?: string;
};

/**
 * Publishing under the approval policy: whoever edits may ask, only an approver
 * decides, and the decision is what writes to WordPress.
 */
export function PublishPanel({
  docUrl,
  base,
  state,
  onChange,
  dirty,
  s,
  c,
  locale,
  perms,
  wordpress,
  connectHref,
}: {
  docUrl: string | null;
  base: string;
  state: PublishState | null;
  onChange: (next: PublishState) => void;
  dirty: boolean;
  s: ContentStrings;
  c: CommonStrings;
  locale: Locale;
  perms: { write: boolean; approve: boolean; rollback: boolean };
  wordpress: boolean;
  connectHref: string;
}) {
  const [mode, setMode] = useState<"draft" | "update">(docUrl ? "update" : "draft");
  const [postType, setPostType] = useState<"posts" | "pages">("posts");
  const [reason, setReason] = useState("");
  const act = useAction(locale);
  const status = state ? PUBLISH_STATUS[state.status] : null;
  const canRequest = perms.write && (!state || ["rejected", "failed", "rolled_back", "published"].includes(state.status));

  async function call(path: string, body?: unknown) {
    const r = await act.run<{ publish: PublishState }>(`${base}/publish${path}`, { body: body ?? {} });
    if (r) onChange(r.publish);
  }

  return (
    <section className="side-card">
      <h4>{s.publish}</h4>
      <p className="hint">{s.publish_help}</p>
      {!wordpress && (
        <p className="small muted">
          {s.needs_wp}{" "}
          <a className="lnk" href={connectHref}>
            {c.connect_site}
          </a>
        </p>
      )}
      {state && status && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <span className={`pill ${status.tone}`}>{status[locale]}</span>
            <span className="muted small">
              {state.mode === "draft" ? s.mode_draft : s.mode_update} · {fmt(s.requested_at, { when: relative(state.requestedAt, locale) })}
            </span>
          </div>
          {state.decidedAt && <span className="muted small">{fmt(s.decided_at, { when: relative(state.decidedAt, locale) })}</span>}
          {state.reason && (
            <span className="small" translate="no" dir="auto">
              {state.reason}
            </span>
          )}
          {state.status === "failed" && state.error && (
            <Flash tone="crit">
              {fmt(s.publish_error, { e: "" })}
              <code className="inline-code">{state.error.slice(0, 200)}</code>
            </Flash>
          )}
          {state.post?.link && state.status === "published" && (
            <a className="btn ghost sm" href={state.post.link} target="_blank" rel="noreferrer" style={{ alignSelf: "flex-start" }}>
              <Icon name="external" />
              {s.view_post}
            </a>
          )}
          {state.status === "pending" &&
            (perms.approve ? (
              <div className="stack" style={{ gap: 8 }}>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={s.reject_reason} aria-label={s.reject_reason} dir="auto" maxLength={500} />
                <div className="row">
                  <button type="button" className="btn primary sm" disabled={act.busy} onClick={() => void call("/decision", { decision: "approve" })}>
                    <Icon name="check" />
                    {s.approve}
                  </button>
                  <button
                    type="button"
                    className="btn danger sm"
                    disabled={act.busy}
                    onClick={() => void call("/decision", { decision: "reject", ...(reason.trim() ? { reason: reason.trim() } : {}) })}
                  >
                    <Icon name="x" />
                    {s.reject}
                  </button>
                </div>
              </div>
            ) : (
              <p className="small muted">{s.approver_only}</p>
            ))}
          {state.status === "published" && perms.rollback && (
            <button type="button" className="btn ghost sm" disabled={act.busy} onClick={() => void call("/rollback")} style={{ alignSelf: "flex-start" }}>
              <Icon name="undo" />
              {s.rollback}
            </button>
          )}
        </div>
      )}
      {canRequest && wordpress && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <div className="radios">
            <label className={`radio ${mode === "draft" ? "on" : "off"}`}>
              <input type="radio" name="pub-mode" checked={mode === "draft"} onChange={() => setMode("draft")} />
              <span>
                <b>{s.mode_draft}</b>
                <small>{s.mode_draft_help}</small>
              </span>
            </label>
            <label className={`radio ${mode === "update" ? "on" : "off"}`}>
              <input type="radio" name="pub-mode" checked={mode === "update"} onChange={() => setMode("update")} />
              <span>
                <b>{s.mode_update}</b>
                <small>{s.mode_update_help}</small>
              </span>
            </label>
          </div>
          {mode === "draft" && (
            <label className="field">
              {s.post_type}
              <select value={postType} onChange={(e) => setPostType(e.target.value as "posts" | "pages")}>
                <option value="posts">{s.post_posts}</option>
                <option value="pages">{s.post_pages}</option>
              </select>
            </label>
          )}
          {mode === "update" && !docUrl && <p className="small muted">{s.needs_url}</p>}
          {dirty && <p className="small muted">{s.save_first}</p>}
          <button
            type="button"
            className="btn"
            disabled={act.busy || dirty || (mode === "update" && !docUrl)}
            onClick={() => void call("", { mode, ...(mode === "draft" ? { postType } : {}) })}
            style={{ alignSelf: "flex-start" }}
          >
            <Icon name="send" />
            {s.request_publish}
          </button>
        </div>
      )}
      {act.error && <Flash tone="crit">{act.error}</Flash>}
    </section>
  );
}
