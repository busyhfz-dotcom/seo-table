"use client";

/**
 * Writing a planned post: the platform's formats, Telegram formatting or an
 * Instagram caption with its hashtag count, media addresses with alt text,
 * pin/silent/share options, a time in the profile's zone, a preview, and the
 * platform's own limits checked while typing. Saving keeps a draft or asks for
 * approval; nothing here publishes.
 */
import { useMemo, useRef, useState } from "react";
import { Icon } from "../../../../components/icons";
import { Rich } from "../../../../components/ui";
import { Flash, Sheet } from "../../../../components/kit";
import { apiErrorMessage, callApi } from "../../../../lib/errors-ui";
import { fmt } from "../../../../lib/dict";
import { num } from "../../../../lib/format";
import type { CommonStrings } from "../../../../lib/common-strings";
import type { SocialStrings } from "../strings";
import type { PlannedPayload, PlannedPost } from "../api-types";
import { maybe, tzLabel, type SocialCtx } from "../parts";
import { CaptionPreview, IG_CAPTION_MAX, IG_HASHTAGS_MAX, TG_CAPTION_MAX, TG_TEXT_MAX, TelegramPreview, hashtags, length, telegramHtmlProblems, visibleText } from "./text";
import { isoToWall, wallToIso, whenIn } from "./time";

type Format = "image" | "carousel" | "reel" | "text" | "photo" | "album" | "video";
type Media = { url: string; type: "image" | "video"; altText: string };

const IG_FORMATS: Format[] = ["image", "carousel", "reel"];
const TG_FORMATS: Format[] = ["text", "photo", "album", "video"];

/** A problem code from the server or the checks here ("caption_too_long:2200") in the reader's words. */
export function problemText(code: string, s: SocialStrings, locale: SocialCtx["locale"]): string {
  const [name = "", arg = ""] = code.split(":");
  const text = maybe(s, `pr_${name}`);
  if (!text) return fmt(s.pr_unknown, { code });
  return fmt(text, { n: /^\d+$/.test(arg) ? num(Number(arg), locale) : arg, tag: arg });
}

export type ComposerSeed = { post: PlannedPost | null; copy?: boolean };

export function Composer({
  ctx,
  s,
  c,
  tz,
  seed,
  onClose,
  onSaved,
}: {
  ctx: SocialCtx;
  s: SocialStrings;
  c: CommonStrings;
  tz: string;
  seed: ComposerSeed;
  onClose: () => void;
  onSaved: (post: PlannedPost, submitted: boolean) => void;
}) {
  const ig = ctx.platform === "INSTAGRAM";
  const initial = seed.post?.payload;
  const editing = seed.post && !seed.copy ? seed.post : null;
  const [op, setOp] = useState<PlannedPayload["op"]>(initial?.op ?? "post");
  const [format, setFormat] = useState<Format>(initial?.op === "post" ? initial.format : ig ? "image" : "text");
  const [text, setText] = useState(initial && initial.op !== "pin" ? initial.text : "");
  const [media, setMedia] = useState<Media[]>(
    initial?.op === "post" ? initial.media.map((m) => ({ url: m.url, type: m.type, altText: m.altText ?? "" })) : [],
  );
  const [pin, setPin] = useState(initial?.op === "post" ? Boolean(initial.pin) : false);
  const [silent, setSilent] = useState(initial && initial.op !== "edit" ? Boolean(initial.silent) : false);
  const [shareToFeed, setShareToFeed] = useState(initial?.op === "post" ? initial.shareToFeed !== false : true);
  const [messageId, setMessageId] = useState(initial && initial.op !== "post" ? String(initial.messageId) : "");
  const [target, setTarget] = useState<"text" | "caption">(initial?.op === "edit" ? initial.target : "text");
  const [when, setWhen] = useState<"asap" | "at">(editing?.publishAt ? "at" : "asap");
  const [wall, setWall] = useState(() => (editing?.publishAt ? isoToWall(editing.publishAt, tz) : isoToWall(new Date(Date.now() + 3_600_000).toISOString(), tz)));
  const [busy, setBusy] = useState<"draft" | "submit" | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("https://");
  const area = useRef<HTMLTextAreaElement>(null);

  const needsMedia = op === "post" && format !== "text";
  const maxMedia = format === "carousel" || format === "album" ? 10 : 1;
  const mediaKind: "image" | "video" | null = format === "reel" || format === "video" ? "video" : format === "image" || format === "photo" ? "image" : null;
  const visible = ig ? text : visibleText(text);
  const limit = ig ? IG_CAPTION_MAX : op === "edit" ? (target === "text" ? TG_TEXT_MAX : TG_CAPTION_MAX) : format === "text" ? TG_TEXT_MAX : TG_CAPTION_MAX;
  const tags = hashtags(text).length;

  const problems = useMemo(() => {
    const out: string[] = [];
    if (op === "pin") {
      if (!/^\d+$/.test(messageId.trim())) out.push("message_id");
      return out;
    }
    if (op === "edit" && !/^\d+$/.test(messageId.trim())) out.push("message_id");
    if (!ig) out.push(...telegramHtmlProblems(text));
    if (length(visible) > limit) out.push(`caption_too_long:${limit}`);
    if (ig && tags > IG_HASHTAGS_MAX) out.push(`too_many_hashtags:${IG_HASHTAGS_MAX}`);
    if ((op === "edit" || format === "text") && !visible.trim()) out.push("text_required");
    if (needsMedia) {
      media.forEach((m, i) => {
        if (!/^https:\/\/\S+$/i.test(m.url.trim())) out.push(`media_https:${i + 1}`);
      });
      if (format === "image" && (media.length !== 1 || media[0]!.type !== "image")) out.push("image_needs_one_image");
      if (format === "photo" && (media.length !== 1 || media[0]!.type !== "image")) out.push("photo_needs_one_image");
      if (format === "reel" && (media.length !== 1 || media[0]!.type !== "video")) out.push("reel_needs_one_video");
      if (format === "video" && (media.length !== 1 || media[0]!.type !== "video")) out.push("video_needs_one_video");
      if (format === "carousel" && (media.length < 2 || media.length > 10)) out.push("carousel_needs_2_to_10_items");
      if (format === "album" && (media.length < 2 || media.length > 10)) out.push("album_needs_2_to_10_items");
      if (ig && media.some((m) => m.type === "image" && m.url && !/\.jpe?g(\?|$)/i.test(m.url.trim()))) out.push("instagram_images_must_be_jpeg");
    }
    return [...new Set(out)];
  }, [op, messageId, ig, text, visible, limit, tags, format, needsMedia, media]);

  function chooseFormat(f: Format) {
    setFormat(f);
    const kind = f === "reel" || f === "video" ? "video" : f === "image" || f === "photo" ? "image" : null;
    if (f === "text") setMedia([]);
    else if (media.length === 0) setMedia([{ url: "", type: kind ?? "image", altText: "" }]);
    else if (kind) setMedia(media.slice(0, 1).map((m) => ({ ...m, type: kind })));
  }

  function wrap(open: string, close: string) {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const next = `${text.slice(0, a)}${open}${text.slice(a, b)}${close}${text.slice(b)}`;
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + open.length, b + open.length);
    });
  }

  function payload(): PlannedPayload {
    if (op === "pin") return { op: "pin", messageId: Number(messageId), silent };
    if (op === "edit") return { op: "edit", messageId: Number(messageId), text, target };
    return {
      op: "post",
      format,
      text,
      media: needsMedia ? media.map((m) => ({ url: m.url.trim(), type: m.type, ...(ig && m.type === "image" && m.altText.trim() ? { altText: m.altText.trim() } : {}) })) : [],
      ...(ig ? (format === "reel" ? { shareToFeed } : {}) : { pin, silent }),
    };
  }

  async function save(submit: boolean) {
    setTouched(true);
    setServerProblems([]);
    setError(null);
    if (problems.length) return;
    setBusy(submit ? "submit" : "draft");
    const body = { payload: payload(), publishAt: when === "at" ? wallToIso(wall, tz) : null, submit };
    const base = `/api/projects/${encodeURIComponent(ctx.projectId)}/social/planner`;
    const r = editing
      ? await callApi<{ post: PlannedPost }>(`${base}/${encodeURIComponent(editing.id)}`, { method: "PATCH", body })
      : await callApi<{ post: PlannedPost }>(base, { method: "POST", body });
    setBusy(null);
    if (!r.ok) {
      const list = r.failure.details?.problems;
      if (Array.isArray(list) && list.length) setServerProblems(list.map(String));
      else setError(apiErrorMessage(ctx.locale, r.failure));
      return;
    }
    onSaved(r.data.post, submit);
  }

  const past = when === "at" && Date.parse(wallToIso(wall, tz)) < Date.now();
  const shownProblems = [...new Set([...(touched ? problems : []), ...serverProblems])];

  return (
    <Sheet open onClose={onClose} title={editing ? s.c_edit : seed.copy ? s.c_copy : s.c_new} closeLabel={c.close}>
      <div className="composer">
        <div className="composer-form stack-sm">
          {editing && <p className="hint">{s.c_edit_note}</p>}
          {!ig && (
            <div className="field">
              <span>{s.op}</span>
              <div className="seg" role="group" aria-label={s.op}>
                {(["post", "edit", "pin"] as const).map((o) => (
                  <button key={o} type="button" aria-pressed={op === o} onClick={() => setOp(o)}>
                    {s[`op_${o}`]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {op === "post" && (
            <div className="field">
              <span>{s.format}</span>
              <div className="seg" role="group" aria-label={s.format}>
                {(ig ? IG_FORMATS : TG_FORMATS).map((f) => (
                  <button key={f} type="button" aria-pressed={format === f} onClick={() => chooseFormat(f)}>
                    {s[`fmt_${f}`]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {op !== "post" && (
            <div className="formgrid">
              <label className="field">
                <span>{s.c_message_id}</span>
                <input inputMode="numeric" dir="ltr" value={messageId} onChange={(e) => setMessageId(e.target.value.replace(/[^\d]/g, ""))} />
                <span className="hint">
                  <Rich text={s.c_message_id_help} />
                </span>
              </label>
              {op === "edit" && (
                <label className="field">
                  <span>{s.c_target}</span>
                  <select value={target} onChange={(e) => setTarget(e.target.value as "text" | "caption")}>
                    <option value="text">{s.target_text}</option>
                    <option value="caption">{s.target_caption}</option>
                  </select>
                </label>
              )}
            </div>
          )}
          {op !== "pin" && (
            <div className="field">
              <label htmlFor="composer-text">{op === "edit" ? s.c_new_text : ig ? s.c_caption : s.c_text_TG}</label>
              {!ig && (
                <div className="rich-tools" role="toolbar" aria-label={s.tb_label}>
                  <button type="button" className="btn ghost sm" onClick={() => wrap("<b>", "</b>")} title={s.tb_bold} aria-label={s.tb_bold}>
                    <Icon name="bold" />
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => wrap("<i>", "</i>")} title={s.tb_italic} aria-label={s.tb_italic}>
                    <Icon name="italic" />
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => wrap("<u>", "</u>")} title={s.tb_underline} aria-label={s.tb_underline}>
                    <u aria-hidden="true">U</u>
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => wrap("<s>", "</s>")} title={s.tb_strike} aria-label={s.tb_strike}>
                    <s aria-hidden="true">S</s>
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => setLinkOpen((v) => !v)} title={s.tb_link} aria-label={s.tb_link} aria-expanded={linkOpen}>
                    <Icon name="link" />
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => wrap("<code>", "</code>")} title={s.tb_code} aria-label={s.tb_code}>
                    <Icon name="code" />
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => wrap("<tg-spoiler>", "</tg-spoiler>")} title={s.tb_spoiler} aria-label={s.tb_spoiler}>
                    <Icon name="eye" />
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => wrap("<blockquote>", "</blockquote>")} title={s.tb_quote} aria-label={s.tb_quote}>
                    <Icon name="quote" />
                  </button>
                </div>
              )}
              {linkOpen && (
                <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <input dir="ltr" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} aria-label={s.link_prompt} />
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!/^https?:\/\/\S+\.\S+/.test(linkUrl)}
                    onClick={() => {
                      wrap(`<a href="${linkUrl.replace(/"/g, "%22")}">`, "</a>");
                      setLinkOpen(false);
                    }}
                  >
                    {s.link_insert}
                  </button>
                </div>
              )}
              <textarea id="composer-text" ref={area} rows={8} value={text} onChange={(e) => setText(e.target.value)} dir="auto" />
              <span className="row hint" style={{ justifyContent: "space-between" }}>
                <span>{ig ? s.c_caption_help : s.c_text_help_TG}</span>
                <span className={length(visible) > limit ? "over" : undefined}>
                  {fmt(s.c_counter, { n: num(length(visible), ctx.locale), max: num(limit, ctx.locale) })}
                  {ig && ` · ${fmt(s.c_hashtags, { n: num(tags, ctx.locale), max: num(IG_HASHTAGS_MAX, ctx.locale) })}`}
                </span>
              </span>
            </div>
          )}
          {needsMedia && (
            <fieldset className="field media-list">
              <legend>{s.c_media}</legend>
              <span className="hint">
                <Rich text={ig ? s.c_media_help_IG : s.c_media_help_TG} />
              </span>
              {media.map((m, i) => (
                <div key={i} className="media-row">
                  <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <input
                      dir="ltr"
                      value={m.url}
                      placeholder="https://…"
                      aria-label={fmt(s.c_media_url, { n: num(i + 1, ctx.locale) })}
                      onChange={(e) => setMedia(media.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                    />
                    {!mediaKind && (
                      <select aria-label={s.c_media_type} value={m.type} onChange={(e) => setMedia(media.map((x, j) => (j === i ? { ...x, type: e.target.value as "image" | "video" } : x)))}>
                        <option value="image">{s.media_image}</option>
                        <option value="video">{s.media_video}</option>
                      </select>
                    )}
                    {media.length > 1 && (
                      <button type="button" className="btn ghost sm" aria-label={fmt(s.c_remove_media, { n: num(i + 1, ctx.locale) })} onClick={() => setMedia(media.filter((_, j) => j !== i))}>
                        <Icon name="x" />
                      </button>
                    )}
                  </div>
                  {ig && m.type === "image" && (
                    <input
                      value={m.altText}
                      maxLength={1000}
                      placeholder={s.c_alt}
                      aria-label={`${s.c_alt} ${num(i + 1, ctx.locale)}`}
                      onChange={(e) => setMedia(media.map((x, j) => (j === i ? { ...x, altText: e.target.value } : x)))}
                      title={s.c_alt_help}
                    />
                  )}
                </div>
              ))}
              {media.length < maxMedia && (
                <div>
                  <button type="button" className="btn ghost sm" onClick={() => setMedia([...media, { url: "", type: mediaKind ?? "image", altText: "" }])}>
                    <Icon name="plus" />
                    {s.c_add_media}
                  </button>
                </div>
              )}
              {ig && <span className="hint">{s.c_alt_help}</span>}
            </fieldset>
          )}
          {op === "post" && !ig && (
            <div className="row">
              <label className="switch">
                <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
                <span>{s.c_pin}</span>
              </label>
              <label className="switch">
                <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} />
                <span>{s.c_silent}</span>
              </label>
            </div>
          )}
          {op === "pin" && (
            <label className="switch">
              <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} />
              <span>{s.c_silent}</span>
            </label>
          )}
          {op === "post" && ig && format === "reel" && (
            <label className="switch">
              <input type="checkbox" checked={shareToFeed} onChange={(e) => setShareToFeed(e.target.checked)} />
              <span>{s.c_share_feed}</span>
            </label>
          )}
          <fieldset className="field">
            <legend>{s.c_when}</legend>
            <div className="seg" role="group" aria-label={s.c_when}>
              <button type="button" aria-pressed={when === "asap"} onClick={() => setWhen("asap")}>
                {s.when_asap}
              </button>
              <button type="button" aria-pressed={when === "at"} onClick={() => setWhen("at")}>
                {s.when_at}
              </button>
            </div>
            {when === "at" && (
              <div className="row" style={{ gap: 8 }}>
                <input type="datetime-local" value={wall} onChange={(e) => setWall(e.target.value)} dir="ltr" aria-label={s.c_when} style={{ maxWidth: 240 }} />
                <span className="hint">
                  {/* The browser's own picker shows its calendar; the time as it will be published is repeated in the reader's. */}
                  {wall ? `${whenIn(wallToIso(wall, tz), tz, ctx.locale)} · ` : ""}
                  {fmt(s.c_when_tz, { tz: tzLabel(tz, s) })}
                </span>
              </div>
            )}
            {past && <span className="hint" style={{ color: "var(--warn)" }}>{s.c_when_past}</span>}
          </fieldset>
          {shownProblems.length > 0 && (
            <Flash tone="crit">
              <div>{s.c_problems}</div>
              <ul className="plain">
                {shownProblems.map((p) => (
                  <li key={p}>
                    <Rich text={problemText(p, s, ctx.locale)} />
                  </li>
                ))}
              </ul>
            </Flash>
          )}
          {error && <Flash tone="crit">{error}</Flash>}
          <div className="row">
            <button type="button" className="btn primary" onClick={() => void save(true)} disabled={busy !== null}>
              {busy === "submit" ? <span className="spin" aria-hidden="true" /> : <Icon name="send" />}
              {s.c_submit}
            </button>
            <button type="button" className="btn ghost" onClick={() => void save(false)} disabled={busy !== null}>
              {busy === "draft" ? <span className="spin" aria-hidden="true" /> : <Icon name="doc" />}
              {s.c_save_draft}
            </button>
          </div>
        </div>
        <aside className="composer-preview">
          <h4 className="sub-h">{s.c_preview}</h4>
          <div className={`post-preview ${ig ? "ig" : "tg"}`}>
            {needsMedia && (
              <div className="pp-media">
                <Icon name={mediaKind === "video" || media.some((m) => m.type === "video") ? "play" : "image"} />
                <span>{fmt(s.c_preview_media, { n: num(media.filter((m) => m.url.trim()).length, ctx.locale) })}</span>
              </div>
            )}
            {op === "pin" ? (
              <div className="pp-text muted">
                <Icon name="pin" /> {fmt(s.op_pin_label, { id: num(Number(messageId) || 0, ctx.locale) })}
              </div>
            ) : (
              <div className="pp-text" dir="auto" translate="no">
                {text.trim() ? ig ? <CaptionPreview text={text} /> : <TelegramPreview html={text} /> : <span className="muted">{s.c_preview_empty}</span>}
              </div>
            )}
          </div>
          <p className="hint">{s.c_preview_note}</p>
        </aside>
      </div>
    </Sheet>
  );
}
