"use client";

/**
 * The post planner: every planned post by status, a month or week calendar
 * in the profile's time zone, and each post's next step for the reader's role
 * — edit and submit (editors), approve, reject, publish now or retry
 * (approvers). A failed post says why; one whose outcome is unknown is never
 * retried and says what to check instead.
 */
import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../../../components/icons";
import { Rich, UserText } from "../../../../components/ui";
import { ConfirmButton, ErrorNote, Flash, Loading, Tabs, useAction, useLoad } from "../../../../components/kit";
import { callApi } from "../../../../lib/errors-ui";
import { fmt } from "../../../../lib/dict";
import { num } from "../../../../lib/format";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { SocialStrings } from "../strings";
import type { PlannedPost } from "../api-types";
import { DEFAULT_TZ, maybe, reasonOf, tzLabel, type SocialCtx, type SocialStatus } from "../parts";
import { Composer, type ComposerSeed } from "./composer";
import { visibleText } from "./text";
import { addDays, dayIn, dayLabel, dayNumber, monthGrid, monthTitle, shiftMonth, wallToIso, weekDays, weekdayShort, whenIn } from "./time";

type Filter = "all" | "awaiting" | "scheduled" | "draft" | "published" | "failed" | "closed";
const FILTER_STATUS: Record<Exclude<Filter, "all">, PlannedPost["status"][]> = {
  awaiting: ["awaiting_approval"],
  scheduled: ["scheduled", "publishing"],
  draft: ["draft"],
  published: ["published"],
  failed: ["failed"],
  closed: ["rejected", "canceled"],
};
const STATUS_TONE: Record<PlannedPost["status"], string> = {
  draft: "mute",
  awaiting_approval: "warn",
  rejected: "crit",
  scheduled: "info",
  publishing: "info",
  published: "ok",
  failed: "crit",
  canceled: "mute",
};
const STATUS_ICON: Record<PlannedPost["status"], string> = {
  draft: "doc",
  awaiting_approval: "lock",
  rejected: "x",
  scheduled: "clock",
  publishing: "play",
  published: "check",
  failed: "alert",
  canceled: "x",
};

export function StatusPill({ status, s }: { status: PlannedPost["status"]; s: SocialStrings }) {
  return (
    <span className={`pill ${STATUS_TONE[status]}`}>
      <Icon name={STATUS_ICON[status]} />
      {s[`ps_${status}`]}
    </span>
  );
}

export function summary(p: PlannedPost, s: SocialStrings, locale: SocialCtx["locale"]): string {
  const pl = p.payload;
  if (pl.op === "pin") return fmt(s.op_pin_label, { id: num(pl.messageId, locale) });
  if (pl.op === "edit") return `${fmt(s.op_edit_label, { id: num(pl.messageId, locale) })}: ${visibleText(pl.text)}`;
  return visibleText(pl.text);
}

export function SocialPlannerScreen({ ctx, s, c }: { ctx: SocialCtx; s: SocialStrings; c: CommonStrings }) {
  const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social`;
  const status = useLoad<SocialStatus>(base, ctx.locale);
  const list = useLoad<{ posts: PlannedPost[] }>(`${base}/planner`, ctx.locale);
  const [view, setView] = useState<"list" | "month" | "week">("list");
  const [filter, setFilter] = useState<Filter>("all");
  const [composer, setComposer] = useState<ComposerSeed | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "crit" | "info"; text: string } | null>(null);
  const tz = status.data?.account.settings.timezone ?? DEFAULT_TZ;
  const connected = status.data ? status.data.account.status !== "NOT_CONNECTED" : true;

  const posts = useMemo(() => [...(list.data?.posts ?? [])].sort((a, b) => (b.publishAt ?? b.createdAt).localeCompare(a.publishAt ?? a.createdAt)), [list.data]);
  const shown = filter === "all" ? posts : posts.filter((p) => FILTER_STATUS[filter].includes(p.status));
  const count = (f: Filter) => (f === "all" ? posts.length : posts.filter((p) => FILTER_STATUS[f].includes(p.status)).length);

  const replace = useCallback((post: PlannedPost) => list.setData((prev) => (prev ? { posts: prev.posts.some((p) => p.id === post.id) ? prev.posts.map((p) => (p.id === post.id ? post : p)) : [post, ...prev.posts] } : prev)), [list]);

  if (list.error && !list.data) return <ErrorNote message={list.error} onRetry={() => void list.reload()} c={c} />;
  if (!list.data || !status.data) return <Loading label={c.loading} rows={6} />;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <p className="desc" style={{ maxWidth: 720 }}>
          {fmt(s.pl_intro, { tz: tzLabel(tz, s) })}
        </p>
        <div className="row">
          <div className="seg" role="group" aria-label={s.view_list}>
            {(["list", "month", "week"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                <Icon name={v === "list" ? "list" : "calendar"} />
                {s[`view_${v}`]}
              </button>
            ))}
          </div>
          {ctx.can.write && (
            <button type="button" className="btn primary" onClick={() => setComposer({ post: null })}>
              <Icon name="plus" />
              {s.new_post}
            </button>
          )}
        </div>
      </div>
      {!connected && (
        <div className="note lock">
          <Icon name="plug" />
          <div>{s.not_connected_body}</div>
        </div>
      )}
      {!ctx.can.approve && <p className="hint">{s.approver_only}</p>}
      {note && <Flash tone={note.tone}>{note.text}</Flash>}

      {view === "list" ? (
        <>
          <Tabs
            label={s.view_list}
            locale={ctx.locale}
            value={filter}
            onChange={setFilter}
            tabs={(["all", "awaiting", "scheduled", "draft", "published", "failed", "closed"] as const).map((f) => ({ key: f, label: s[`f_${f}`], count: count(f) }))}
          />
          {shown.length === 0 ? (
            <section className="card">
              <div className="body">
                <div className="empty">
                  <Icon name="calendar" />
                  <div>{posts.length === 0 ? s.pl_empty_all : s.pl_empty}</div>
                </div>
              </div>
            </section>
          ) : (
            <div className="stack-sm">
              {shown.map((p) => (
                <PostCard key={p.id} post={p} ctx={ctx} s={s} c={c} tz={tz} onChange={replace} onNote={setNote} onEdit={(post, copy) => setComposer({ post, copy })} />
              ))}
            </div>
          )}
        </>
      ) : (
        <Calendar ctx={ctx} s={s} c={c} tz={tz} mode={view} posts={posts} onOpen={(p) => setComposer({ post: p, copy: !["draft", "awaiting_approval", "rejected"].includes(p.status) })} />
      )}

      {composer && (
        <Composer
          ctx={ctx}
          s={s}
          c={c}
          tz={tz}
          seed={composer}
          onClose={() => setComposer(null)}
          onSaved={(post, submitted) => {
            replace(post);
            setComposer(null);
            setNote({ tone: "ok", text: submitted ? s.c_submitted : s.c_saved });
          }}
        />
      )}
    </>
  );
}

function PostCard({
  post,
  ctx,
  s,
  c,
  tz,
  onChange,
  onNote,
  onEdit,
}: {
  post: PlannedPost;
  ctx: SocialCtx;
  s: SocialStrings;
  c: CommonStrings;
  tz: string;
  onChange: (p: PlannedPost) => void;
  onNote: (n: { tone: "ok" | "crit" | "info"; text: string } | null) => void;
  onEdit: (p: PlannedPost, copy: boolean) => void;
}) {
  const action = useAction(ctx.locale);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [waiting, setWaiting] = useState(false);
  const L = ctx.locale;
  const url = `/api/projects/${encodeURIComponent(ctx.projectId)}/social/planner/${encodeURIComponent(post.id)}`;
  const pl = post.payload;
  const unknown = post.status === "failed" && post.error === "outcome_unknown";
  const editable = ["draft", "awaiting_approval", "rejected"].includes(post.status);

  async function run(path: string, init: { method?: string; body?: unknown }, done: string) {
    onNote(null);
    const r = await action.run<{ post: PlannedPost }>(`${url}${path}`, init);
    if (!r) return null;
    onChange(r.post);
    onNote({ tone: "ok", text: done });
    return r.post;
  }

  /** After "publish now", follow the post until the publisher is done with it. */
  async function publishNow() {
    const started = await run("/publish-now", {}, s.m_publishing);
    if (!started) return;
    setWaiting(true);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await callApi<{ post: PlannedPost }>(url);
      if (!r.ok) continue;
      onChange(r.data.post);
      if (r.data.post.status === "published") {
        onNote({ tone: "ok", text: s.m_published });
        break;
      }
      if (r.data.post.status === "failed") {
        onNote({ tone: "crit", text: `${s.m_failed} ${reasonOf(ctx, s, r.data.post.error)}` });
        break;
      }
    }
    setWaiting(false);
  }

  const media = pl.op === "post" ? pl.media.length : 0;
  return (
    <article className="card planned">
      <div className="body stack-sm">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div className="row" style={{ gap: 8 }}>
            <StatusPill status={post.status} s={s} />
            <span className="pill mute">{pl.op === "post" ? s[`fmt_${pl.format}`] : pl.op === "edit" ? s.op_edit : s.op_pin}</span>
            {pl.op === "post" && pl.pin && (
              <span className="pill mute">
                <Icon name="pin" />
                {s.cap_pin}
              </span>
            )}
            {media > 0 && <span className="muted small">{fmt(s.c_preview_media, { n: num(media, L) })}</span>}
          </div>
          <span className="small muted">
            {post.status === "published"
              ? fmt(s.published_at, { when: whenIn(post.publishedAt, tz, L) })
              : post.publishAt
                ? fmt(s.publish_at, { when: whenIn(post.publishAt, tz, L) })
                : s.publish_asap}
          </span>
        </div>
        <p className="planned-text" dir="auto" translate="no">
          {summary(post, s, L) || <span className="muted">{s.no_caption}</span>}
        </p>
        <div className="row small muted" style={{ gap: 12 }}>
          {post.requestedAt && <span>{fmt(s.requested, { when: whenIn(post.requestedAt, tz, L) })}</span>}
          {post.decidedAt && <span>{fmt(s.decided, { when: whenIn(post.decidedAt, tz, L) })}</span>}
          {post.decisionReason && (
            <span>
              {fmt(s.decision_reason, { r: "" })}
              <UserText>{post.decisionReason}</UserText>
            </span>
          )}
          {post.attempts > 0 && <span>{fmt(s.attempts, { n: num(post.attempts, L) })}</span>}
        </div>
        {unknown ? (
          <div className="note crit" role="alert">
            <Icon name="alert" />
            <div>
              <b>{s.ou_title}</b>
              <div>{s.ou_body}</div>
            </div>
          </div>
        ) : (
          post.status === "failed" &&
          post.error && (
            <div className="note crit">
              <Icon name="alert" />
              <div>
                {s.fail_reason} {reasonOf(ctx, s, post.error)}
                <div className="hint">{s.retry_note}</div>
              </div>
            </div>
          )
        )}
        {post.status === "scheduled" && post.error && (
          <p className="hint">
            {s.fail_reason} {reasonOf(ctx, s, post.error)} — {s.retry_note}
          </p>
        )}
        {action.error && <Flash tone="crit">{action.error}</Flash>}
        {rejecting && (
          <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={s.a_reject_reason} aria-label={s.a_reject_reason} />
            <button
              type="button"
              className="btn danger sm"
              disabled={action.busy}
              onClick={() => void run("/decision", { body: { decision: "reject", ...(reason.trim() ? { reason: reason.trim() } : {}) } }, s.m_rejected).then(() => setRejecting(false))}
            >
              {s.a_reject_confirm}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setRejecting(false)}>
              {c.cancel}
            </button>
          </div>
        )}
        <div className="row" style={{ gap: 6 }}>
          {post.status === "awaiting_approval" && ctx.can.approve && !rejecting && (
            <>
              <button type="button" className="btn primary sm" disabled={action.busy} onClick={() => void run("/decision", { body: { decision: "approve" } }, s.m_approved)}>
                <Icon name="check" />
                {s.a_approve}
              </button>
              <button type="button" className="btn ghost sm" disabled={action.busy} onClick={() => setRejecting(true)}>
                <Icon name="x" />
                {s.a_reject}
              </button>
            </>
          )}
          {(post.status === "scheduled" || (post.status === "failed" && !unknown)) && ctx.can.approve && (
            <button type="button" className="btn primary sm" disabled={action.busy || waiting} onClick={() => void publishNow()}>
              {waiting ? <span className="spin" aria-hidden="true" /> : <Icon name="send" />}
              {post.status === "failed" ? s.a_retry : s.a_publish_now}
            </button>
          )}
          {editable && ctx.can.write && (
            <button type="button" className="btn ghost sm" onClick={() => onEdit(post, false)}>
              <Icon name="pen" />
              {s.a_edit}
            </button>
          )}
          {(post.status === "draft" || post.status === "rejected") && ctx.can.write && (
            <button type="button" className="btn ghost sm" disabled={action.busy} onClick={() => void run("/submit", {}, s.m_submitted)}>
              <Icon name="send" />
              {s.a_submit}
            </button>
          )}
          {(unknown || post.status === "canceled" || post.status === "published") && ctx.can.write && (
            <button type="button" className="btn ghost sm" onClick={() => onEdit(post, true)}>
              <Icon name="plus" />
              {s.a_copy}
            </button>
          )}
          {post.status === "published" && post.resultPermalink && (
            <a className="btn ghost sm" href={post.resultPermalink} target="_blank" rel="noreferrer noopener">
              <Icon name="external" />
              {s.a_open}
            </a>
          )}
          {["draft", "awaiting_approval", "rejected", "scheduled", "failed"].includes(post.status) && ctx.can.write && (
            <ConfirmButton label={s.a_cancel} confirmLabel={s.a_cancel_confirm} icon="x" disabled={action.busy} onConfirm={() => void run("", { method: "DELETE" }, s.m_canceled)} />
          )}
        </div>
      </div>
    </article>
  );
}

function Calendar({
  ctx,
  s,
  c,
  tz,
  mode,
  posts,
  onOpen,
}: {
  ctx: SocialCtx;
  s: SocialStrings;
  c: CommonStrings;
  tz: string;
  mode: "month" | "week";
  posts: PlannedPost[];
  onOpen: (p: PlannedPost) => void;
}) {
  const L = ctx.locale;
  const today = dayIn(Date.now(), tz);
  const [anchor, setAnchor] = useState(today);
  const grid = useMemo(
    () => (mode === "month" ? monthGrid(anchor, L).days : weekDays(anchor, L).map((day) => ({ day, inMonth: true }))),
    [mode, anchor, L],
  );
  const first = grid[0]!.day;
  const last = grid[grid.length - 1]!.day;
  const from = wallToIso(`${first}T00:00`, tz);
  const to = wallToIso(`${addDays(last, 1)}T00:00`, tz);
  const cal = useLoad<{ timeZone: string; days: Array<{ date: string; posts: PlannedPost[] }> }>(
    `/api/projects/${encodeURIComponent(ctx.projectId)}/social/planner/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    L,
  );
  // The list's copy is fresher after an action on this screen; the calendar decides which days they fall on.
  const fresh = new Map(posts.map((p) => [p.id, p]));
  const byDay = new Map((cal.data?.days ?? []).map((d) => [d.date, d.posts.map((p) => fresh.get(p.id) ?? p)]));
  const total = [...byDay.values()].reduce((n, d) => n + d.length, 0);
  const title = mode === "month" ? monthTitle(anchor, L) : `${dayLabel(first, L)} – ${dayLabel(last, L)}`;

  return (
    <section className="card">
      <header>
        <h3>{title}</h3>
        <span className="spacer" />
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn ghost sm" onClick={() => setAnchor(mode === "month" ? shiftMonth(anchor, -1, L) : addDays(anchor, -7))} aria-label={s.prev_period}>
            <Icon name={L === "fa" ? "right" : "left"} />
            {s.prev_period}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setAnchor(today)}>
            {s.today}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setAnchor(mode === "month" ? shiftMonth(anchor, 1, L) : addDays(anchor, 7))} aria-label={s.next_period}>
            {s.next_period}
            <Icon name={L === "fa" ? "left" : "right"} />
          </button>
        </div>
      </header>
      <div className="body">
        {cal.error && !cal.data ? (
          <ErrorNote message={cal.error} onRetry={() => void cal.reload()} c={c} />
        ) : !cal.data ? (
          <Loading label={c.loading} rows={4} />
        ) : (
          <>
            <div className={`cal ${mode}`} role="grid" aria-label={title}>
              {grid.slice(0, 7).map(({ day }) => (
                <div key={`h-${day}`} className="cal-h" role="columnheader">
                  {weekdayShort(day, L)}
                </div>
              ))}
              {grid.map(({ day, inMonth }) => {
                const items = byDay.get(day) ?? [];
                const max = mode === "month" ? 3 : 20;
                return (
                  <div key={day} role="gridcell" className={`cal-d${inMonth ? "" : " out"}${day === today ? " today" : ""}`}>
                    <span className="cal-n">{mode === "week" ? dayLabel(day, L) : dayNumber(day, L)}</span>
                    {items.slice(0, max).map((p) => (
                      <button key={p.id} type="button" className={`cal-item ${STATUS_TONE[p.status]}`} onClick={() => onOpen(p)} title={`${s[`ps_${p.status}`]} · ${summary(p, s, L).slice(0, 120)}`}>
                        <b>{whenIn(p.publishedAt ?? p.publishAt, tz, L, false)}</b>
                        <span dir="auto" translate="no">
                          {summary(p, s, L).slice(0, 60) || maybe(s, `ps_${p.status}`)}
                        </span>
                      </button>
                    ))}
                    {items.length > max && <span className="muted small">{fmt(s.cal_more, { n: num(items.length - max, L) })}</span>}
                  </div>
                );
              })}
            </div>
            {total === 0 && <p className="muted" style={{ marginTop: 10 }}>{s.cal_none}</p>}
            <p className="hint" style={{ marginTop: 8 }}>
              <Rich text={fmt(s.pl_intro, { tz: tzLabel(tz, s) })} />
            </p>
          </>
        )}
      </div>
    </section>
  );
}
