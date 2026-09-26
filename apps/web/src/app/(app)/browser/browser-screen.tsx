"use client";

/**
 * The remote browser, drawn on a canvas. Frames are polled (~350 ms) with the
 * last ETag, so an unchanged page costs an empty 304; polling stops while the
 * tab is hidden. Pointer, wheel and keyboard input is translated from the
 * canvas's on-screen size back to the remote viewport's CSS pixels and sent as
 * actions, one at a time and in order.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components/icons";
import { apiErrorMessage, callApi, type ApiFailure } from "../../../lib/errors-ui";
import type { Locale } from "../../../lib/i18n";
import { InspectPanel } from "./inspect-panel";
import type { BrowserStrings } from "./keys";
import styles from "./browser.module.css";

type Device = "desktop" | "mobile";
type PageState = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string };
type SessionInfo = PageState & { id: string; width: number; height: number; device: Device };
type Action =
  | { type: "navigate"; url: string }
  | { type: "click"; x: number; y: number; button?: "left" | "right"; clickCount?: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dx: number; dy: number; x?: number; y?: number }
  | { type: "back" | "forward" | "reload" };
type Phase = "idle" | "starting" | "live" | "ended";

const POLL_MS = 350;
const TYPE_FLUSH_MS = 60;
const WHEEL_FLUSH_MS = 70;
/** A frame endpoint failing this many times in a row means the session is not coming back. */
const MAX_FRAME_FAILURES = 8;
const SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Delete",
]);

function headerState(h: Headers): PageState {
  const decode = (v: string | null) => {
    try {
      return decodeURIComponent(v ?? "");
    } catch {
      return "";
    }
  };
  const error = h.get("x-browser-error");
  return {
    url: decode(h.get("x-browser-url")),
    title: decode(h.get("x-browser-title")),
    loading: h.get("x-browser-loading") === "1",
    canGoBack: h.get("x-browser-back") === "1",
    canGoForward: h.get("x-browser-forward") === "1",
    ...(error ? { error } : {}),
  };
}

function netErrorText(code: string, s: BrowserStrings): string {
  if (code === "ERR_NAME_NOT_RESOLVED") return s.br_err_name;
  if (code === "ERR_TUNNEL_CONNECTION_FAILED" || code === "ERR_EMPTY_RESPONSE") return s.br_err_unreachable;
  if (code === "ERR_CONNECTION_REFUSED") return s.br_err_refused;
  if (code === "ERR_TIMED_OUT" || code === "ERR_CONNECTION_TIMED_OUT") return s.br_err_timeout;
  if (code.startsWith("ERR_CERT") || code.startsWith("ERR_SSL")) return s.br_err_cert;
  if (code === "ERR_BLOCKED_BY_CLIENT") return s.br_blocked;
  return s.br_err_generic.replace("{code}", code);
}

/** Glyphs the shared icon set does not have; drawn with the same stroke style. */
function Glyph({ name }: { name: "back" | "forward" | "reload" | "desktop" | "mobile" | "close" }) {
  const paths = {
    back: <path d="M15 5l-7 7 7 7" />,
    forward: <path d="M9 5l7 7-7 7" />,
    reload: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
    desktop: <path d="M3 5h18v11H3zM8 20h8M12 16v4" />,
    mobile: <path d="M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function BrowserScreen({
  locale,
  strings: s,
  initialUrl,
  autoStart,
  projectId,
  canBrowse,
}: {
  locale: Locale;
  strings: BrowserStrings;
  initialUrl: string;
  autoStart: boolean;
  projectId: string | null;
  canBrowse: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [address, setAddress] = useState(initialUrl);
  const [device, setDevice] = useState<Device>("desktop");
  const [notice, setNotice] = useState<{ tone: "crit" | "acc" | "plain"; text: string } | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [focused, setFocused] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const etagRef = useRef<string | null>(null);
  const editingRef = useRef(false);
  const kickRef = useRef<() => void>(() => undefined);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const textRef = useRef({ text: "", timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const wheelRef = useRef({ dx: 0, dy: 0, x: 0, y: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const dragRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pasteRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startedRef = useRef(false);

  // The strings are already in the reader's language, so both slots carry the same text.
  const overrides = useMemo(
    () => ({
      BROWSER_UNAVAILABLE: { fa: s.br_unavailable, en: s.br_unavailable },
      BROWSER_BUSY: { fa: s.br_busy, en: s.br_busy },
      BLOCKED_ADDRESS: { fa: s.br_blocked, en: s.br_blocked },
    }),
    [s],
  );
  const failureText = useCallback(
    (failure: ApiFailure) => apiErrorMessage(locale, failure, overrides),
    [locale, overrides],
  );

  // Confirmations fade; errors stay until the next thing the reader does replaces them.
  useEffect(() => {
    if (!notice || notice.tone === "crit") return;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const applyState = useCallback((state: PageState) => {
    setPage(state);
    if (!editingRef.current && state.url) setAddress(state.url);
  }, []);

  const ended = useCallback(() => {
    sessionRef.current = null;
    setPhase("ended");
  }, []);

  // ---- actions ----------------------------------------------------------------

  const enqueue = useCallback(
    (action: Action) => {
      const current = sessionRef.current;
      if (!current) return;
      queueRef.current = queueRef.current.then(async () => {
        if (sessionRef.current?.id !== current.id) return;
        const res = await callApi<PageState & { copied?: string }>(`/api/browser/sessions/${current.id}/action`, {
          method: "POST",
          body: action,
        });
        if (res.ok) {
          applyState(res.data);
          if (action.type === "navigate") setNotice(null);
          if (res.data.copied) {
            await navigator.clipboard
              ?.writeText(res.data.copied)
              .then(() => setNotice({ tone: "acc", text: s.br_copied }))
              .catch(() => undefined);
          }
        } else if (res.failure.status === 404) {
          ended();
        } else {
          setNotice({ tone: "crit", text: failureText(res.failure) });
        }
        kickRef.current();
      }).catch(() => undefined);
    },
    [applyState, ended, failureText, s.br_copied],
  );

  const flushText = useCallback(() => {
    const t = textRef.current;
    clearTimeout(t.timer);
    if (!t.text) return;
    const text = t.text;
    t.text = "";
    enqueue({ type: "type", text });
  }, [enqueue]);

  /** Every non-text action first sends the characters typed before it. */
  const send = useCallback(
    (action: Action) => {
      flushText();
      enqueue(action);
    },
    [enqueue, flushText],
  );

  const queueText = useCallback(
    (text: string) => {
      const t = textRef.current;
      t.text += text;
      clearTimeout(t.timer);
      if (t.text.length >= 500) flushText();
      else t.timer = setTimeout(flushText, TYPE_FLUSH_MS);
    },
    [flushText],
  );

  // ---- sessions ---------------------------------------------------------------

  const start = useCallback(
    async (target: string, dev: Device) => {
      const url = target.trim();
      if (!url) return;
      setPhase("starting");
      setNotice(null);
      setHasFrame(false);
      etagRef.current = null;
      const res = await callApi<SessionInfo>("/api/browser/sessions", {
        method: "POST",
        body: { url, device: dev, ...(projectId ? { projectId } : {}) },
      });
      if (!res.ok) {
        sessionRef.current = null;
        setSession(null);
        setPhase("idle");
        setNotice({ tone: "crit", text: failureText(res.failure) });
        return;
      }
      sessionRef.current = res.data;
      setSession(res.data);
      setDevice(res.data.device);
      applyState(res.data);
      setPhase("live");
    },
    [applyState, failureText, projectId],
  );

  const close = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setPage(null);
    setHasFrame(false);
    setPhase("idle");
    if (current) {
      await callApi(`/api/browser/sessions/${current.id}`, { method: "DELETE" });
      setNotice({ tone: "plain", text: s.br_closed });
    }
  }, [s.br_closed]);

  useEffect(() => {
    if (autoStart && canBrowse && initialUrl && !startedRef.current) {
      startedRef.current = true;
      // On a phone a desktop-sized page would be drawn too small to use.
      const initial: Device = window.matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop";
      setDevice(initial);
      void start(initialUrl, initial);
    }
  }, [autoStart, canBrowse, initialUrl, start]);

  // Leaving the page frees the slot now instead of after the idle timeout.
  useEffect(() => {
    const release = () => {
      const current = sessionRef.current;
      if (!current) return;
      sessionRef.current = null;
      void fetch(`/api/browser/sessions/${current.id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, []);

  // ---- frames -----------------------------------------------------------------

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let inFlight = false;
    let again = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const draw = async (blob: Blob) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      setHasFrame(true);
    };

    const tick = async () => {
      if (stopped || document.hidden) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const res = await fetch(`/api/browser/sessions/${session.id}/frame`, {
          cache: "no-store",
          headers: etagRef.current ? { "if-none-match": etagRef.current } : {},
        });
        if (stopped) return;
        if (res.status === 200 || res.status === 304) {
          failures = 0;
          applyState(headerState(res.headers));
          if (res.status === 200) {
            etagRef.current = res.headers.get("etag");
            await draw(await res.blob());
          }
        } else if (res.status === 404 || res.status === 401) {
          stopped = true;
          ended();
          return;
        } else if (++failures >= MAX_FRAME_FAILURES) {
          stopped = true;
          ended();
          return;
        }
      } catch {
        if (++failures >= MAX_FRAME_FAILURES) {
          stopped = true;
          ended();
          return;
        }
      } finally {
        inFlight = false;
      }
      if (stopped) return;
      if (again) {
        again = false;
        void tick();
      } else {
        timer = setTimeout(() => void tick(), POLL_MS);
      }
    };

    kickRef.current = () => {
      if (stopped) return;
      if (inFlight) again = true;
      else void tick();
    };
    const onVisibility = () => {
      if (!document.hidden) kickRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      kickRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session, applyState, ended]);

  // ---- input --------------------------------------------------------------------

  /** Canvas pixels on screen → the remote viewport's CSS pixels. */
  const toRemote = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const current = sessionRef.current;
    if (!canvas || !current) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) * current.width) / rect.width;
    const y = ((clientY - rect.top) * current.height) / rect.height;
    return {
      x: Math.round(Math.min(Math.max(x, 0), current.width - 1)),
      y: Math.round(Math.min(Math.max(y, 0), current.height - 1)),
    };
  }, []);

  const flushWheel = useCallback(() => {
    const w = wheelRef.current;
    clearTimeout(w.timer);
    w.timer = undefined;
    if (w.dx === 0 && w.dy === 0) return;
    const clamp = (v: number) => Math.round(Math.max(-5000, Math.min(5000, v)));
    send({ type: "scroll", dx: clamp(w.dx), dy: clamp(w.dy), x: w.x, y: w.y });
    w.dx = 0;
    w.dy = 0;
  }, [send]);

  const addScroll = useCallback(
    (dx: number, dy: number, at: { x: number; y: number }) => {
      const w = wheelRef.current;
      w.dx += dx;
      w.dy += dy;
      w.x = at.x;
      w.y = at.y;
      w.timer ??= setTimeout(flushWheel, WHEEL_FLUSH_MS);
    },
    [flushWheel],
  );

  // React's wheel listener is passive, and the panel page must not scroll under the view.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!sessionRef.current) return;
      e.preventDefault();
      const at = toRemote(e.clientX, e.clientY);
      if (!at) return;
      const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      addScroll(e.deltaX * scale, e.deltaY * scale, at);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [session, toRemote, addScroll]);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    canvasRef.current?.focus();
    if (e.pointerType === "touch") dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  }

  // On a touch screen, dragging the view scrolls the remote page.
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = drag.x - e.clientX;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const canvas = canvasRef.current;
    const current = sessionRef.current;
    const at = toRemote(e.clientX, e.clientY);
    if (!canvas || !current || !at) return;
    const ratio = current.width / canvas.getBoundingClientRect().width;
    addScroll(dx * ratio, dy * ratio, at);
    drag.x = e.clientX;
    drag.y = e.clientY;
  }

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.moved) return;
    const at = toRemote(e.clientX, e.clientY);
    if (at) send({ type: "click", ...at, clickCount: Math.min(Math.max(e.detail, 1), 3) });
  }

  function onContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const at = toRemote(e.clientX, e.clientY);
    if (at) send({ type: "click", ...at, button: "right" });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!sessionRef.current || e.nativeEvent.isComposing) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "a" || k === "c") {
        e.preventDefault();
        send({ type: "key", key: `Control+${k.toUpperCase()}` });
      } else if (k === "v") {
        // The paste event carries the viewer's own clipboard; if none arrives,
        // paste what was last copied inside the remote page.
        clearTimeout(pasteRef.current);
        pasteRef.current = setTimeout(() => send({ type: "key", key: "Control+V" }), 150);
      }
      // Every other shortcut belongs to the viewer's own browser.
      return;
    }
    if (e.altKey) return;
    const special = e.key === "Tab" && e.shiftKey ? "Shift+Tab" : SPECIAL_KEYS.has(e.key) ? e.key : null;
    if (special) {
      e.preventDefault();
      send({ type: "key", key: special });
      return;
    }
    if ([...e.key].length === 1) {
      e.preventDefault();
      queueText(e.key);
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLCanvasElement>) {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    clearTimeout(pasteRef.current);
    queueText(text.slice(0, 2000));
    flushText();
  }

  // ---- toolbar ------------------------------------------------------------------

  function submitAddress(e: React.FormEvent) {
    e.preventDefault();
    editingRef.current = false;
    const target = address.trim();
    if (!target || !canBrowse) return;
    if (phase === "live" && sessionRef.current) {
      setNotice(null);
      send({ type: "navigate", url: target });
    } else {
      void start(target, device);
    }
  }

  function switchDevice(next: Device) {
    if (next === device) return;
    setDevice(next);
    // The viewport is fixed per session: a new device is a new session on the same page.
    if (phase === "live" || phase === "ended") void start(page?.url || address, next);
  }

  const live = phase === "live" && session !== null;
  const inspectTarget = (live && page?.url) || address.trim();
  const title = page?.title || (live ? s.br_untitled : "");

  return (
    <>
      <div className="note lock" role="note">
        <Icon name="lock" />
        <div>{s.br_privacy}</div>
      </div>

      <div className={styles.layout}>
        <section className={`card ${styles.browser}`}>
          <form className={styles.toolbar} onSubmit={submitAddress}>
            <div className={styles.navButtons}>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.flip}`}
                onClick={() => send({ type: "back" })}
                disabled={!live || !page?.canGoBack}
                aria-label={s.br_back}
                title={s.br_back}
              >
                <Glyph name="back" />
              </button>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.flip}`}
                onClick={() => send({ type: "forward" })}
                disabled={!live || !page?.canGoForward}
                aria-label={s.br_forward}
                title={s.br_forward}
              >
                <Glyph name="forward" />
              </button>
              <button
                type="button"
                className={`${styles.iconBtn} ${page?.loading ? styles.spinning : ""}`}
                onClick={() => send({ type: "reload" })}
                disabled={!live}
                aria-label={s.br_reload}
                title={s.br_reload}
              >
                <Glyph name="reload" />
              </button>
            </div>
            <label className={styles.address}>
              <span className="sr-only">{s.br_address}</span>
              <Icon name={page?.url.startsWith("https:") ? "lock" : "link"} />
              <input
                dir="ltr"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={address}
                placeholder={s.br_address_placeholder}
                onChange={(e) => setAddress(e.target.value)}
                onFocus={(e) => {
                  editingRef.current = true;
                  e.currentTarget.select();
                }}
                onBlur={() => {
                  editingRef.current = false;
                }}
              />
            </label>
            {canBrowse && (
              <button type="submit" className="btn primary sm" disabled={!address.trim() || phase === "starting"}>
                {s.br_go}
              </button>
            )}
            <div className="seg" role="group" aria-label={s.br_device}>
              <button
                type="button"
                aria-pressed={device === "desktop"}
                onClick={() => switchDevice("desktop")}
                disabled={phase === "starting"}
                title={s.br_desktop}
              >
                <span className={styles.segIcon}>
                  <Glyph name="desktop" />
                </span>
                {s.br_desktop}
              </button>
              <button
                type="button"
                aria-pressed={device === "mobile"}
                onClick={() => switchDevice("mobile")}
                disabled={phase === "starting"}
                title={s.br_mobile}
              >
                <span className={styles.segIcon}>
                  <Glyph name="mobile" />
                </span>
                {s.br_mobile}
              </button>
            </div>
            {live && (
              <button type="button" className={styles.iconBtn} onClick={() => void close()} aria-label={s.br_close} title={s.br_close}>
                <Glyph name="close" />
              </button>
            )}
          </form>
          <div className={styles.progress} data-active={page?.loading || phase === "starting" ? "true" : "false"} />

          <div className={styles.stage} data-device={session?.device ?? device} data-empty={hasFrame ? "false" : "true"}>
            {session && (
              <canvas
                ref={canvasRef}
                key={session.id}
                width={session.width}
                height={session.height}
                className={styles.canvas}
                data-ready={hasFrame ? "true" : "false"}
                tabIndex={0}
                role="application"
                aria-label={s.br_viewport}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onClick={onClick}
                onContextMenu={onContextMenu}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onFocus={() => setFocused(true)}
                onBlur={() => {
                  setFocused(false);
                  flushText();
                }}
              />
            )}

            {!canBrowse && (
              <div className={styles.overlay}>
                <div className={styles.overlayBox}>
                  <Icon name="lock" />
                  <p>{s.br_no_permission}</p>
                </div>
              </div>
            )}
            {canBrowse && phase === "idle" && (
              <div className={styles.overlay}>
                <div className={styles.overlayBox}>
                  <Glyph name={device} />
                  <p>{s.br_start_hint}</p>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!address.trim()}
                    onClick={() => void start(address, device)}
                  >
                    <Icon name="play" />
                    {s.br_open}
                  </button>
                </div>
              </div>
            )}
            {(phase === "starting" || (live && !hasFrame)) && (
              <div className={styles.overlay} role="status">
                <div className={styles.overlayBox}>
                  <span className={styles.spinner} aria-hidden="true" />
                  <p>{phase === "starting" ? s.br_starting : s.br_loading_page}</p>
                </div>
              </div>
            )}
            {phase === "ended" && (
              <div className={styles.overlay}>
                <div className={styles.overlayBox}>
                  <Icon name="clock" />
                  <p>{s.br_ended}</p>
                  <button type="button" className="btn primary" onClick={() => void start(page?.url || address, device)}>
                    <Glyph name="reload" />
                    {s.br_restart}
                  </button>
                </div>
              </div>
            )}
          </div>

          <footer className={styles.statusbar}>
            {notice ? (
              <span className={`pill ${notice.tone === "crit" ? "crit" : notice.tone === "acc" ? "ok" : "mute"}`} role="status">
                <Icon name={notice.tone === "crit" ? "alert" : "info"} />
                {notice.text}
              </span>
            ) : live && page?.error ? (
              <span className="pill warn" role="status">
                <Icon name="alert" />
                {netErrorText(page.error, s)}
              </span>
            ) : (
              <span className={styles.pageTitle} dir="auto">
                {title}
              </span>
            )}
            <span className="spacer" />
            {live && !focused && <span className={styles.hint}>{s.br_keyboard_hint}</span>}
          </footer>
        </section>

        <InspectPanel
          locale={locale}
          s={s}
          target={inspectTarget}
          device={session?.device ?? device}
          errorOverrides={overrides}
        />
      </div>
    </>
  );
}
