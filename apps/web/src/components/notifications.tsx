"use client";

/**
 * In-app notifications: the bell in the top bar (unread count, the latest few,
 * mark read) and the list the Alerts screen shows in full. Titles and bodies
 * arrive from the server in both languages.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { callApi } from "../lib/errors-ui";
import { num, relative } from "../lib/format";
import { LocText } from "./loc-text";
import type { Locale } from "../lib/i18n";

export type NotificationItem = {
  id: string;
  projectId: string | null;
  kind: string;
  severity: "CRITICAL" | "SERIOUS" | "WARNING" | "INFO";
  title: { fa: string; en: string };
  body: { fa: string; en: string };
  link: string | null;
  createdAt: string;
  readAt: string | null;
  deliveries?: Record<string, { status: string; error?: string | null }>;
};

const KIND_ICON: Record<string, string> = {
  score_drop: "pulse",
  new_critical: "alert",
  rank_drop: "trend",
  page_down: "alert",
  cwv_regression: "gauge",
  index_drop: "search",
  report_ready: "doc",
};
const TONE = { CRITICAL: "crit", SERIOUS: "crit", WARNING: "warn", INFO: "info" } as const;

export function NotificationRow({
  n,
  locale,
  onRead,
  labels,
  onNavigate,
}: {
  n: NotificationItem;
  locale: Locale;
  onRead?: (id: string) => void;
  labels: { markRead: string; open: string };
  onNavigate?: () => void;
}) {
  return (
    <li className={n.readAt ? undefined : "unread"}>
      <span className={`ic ${TONE[n.severity] ?? "info"}`}>
        <Icon name={KIND_ICON[n.kind] ?? "bell"} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <b>
          <LocText pair={n.title} locale={locale} />
        </b>
        <p>
          <LocText pair={n.body} locale={locale} />
        </p>
        <time dateTime={n.createdAt}>{relative(n.createdAt, locale)}</time>
        <div className="row" style={{ marginTop: 6, gap: 6 }}>
          {n.link && (
            <Link
              className="btn ghost sm"
              href={n.link}
              onClick={() => {
                if (!n.readAt) onRead?.(n.id);
                onNavigate?.();
              }}
            >
              {labels.open}
            </Link>
          )}
          {!n.readAt && onRead && (
            <button type="button" className="btn ghost sm" onClick={() => onRead(n.id)}>
              <Icon name="check" />
              {labels.markRead}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export type BellStrings = { title: string; markAll: string; viewAll: string; empty: string; markRead: string; open: string; unread: string };

/**
 * The bell: polls the unread count every minute (and when the tab comes back
 * into view), and opens a panel with the latest notifications.
 */
export function Bell({ s, locale, alertsHref }: { s: BellStrings; locale: Locale; alertsHref: string }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await callApi<{ unread: number; items: NotificationItem[] }>("/api/notifications?perPage=8");
    if (r.ok) {
      setUnread(r.data.unread);
      setItems(r.data.items);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    const vis = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function read(id: string) {
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null);
    setUnread((u) => Math.max(0, u - 1));
    await callApi("/api/notifications/read", { method: "POST", body: { ids: [id] } });
  }

  async function readAll() {
    await callApi("/api/notifications/read-all", { method: "POST", body: {} });
    await load();
  }

  return (
    <div className="bell" ref={box}>
      <button
        type="button"
        className="btn ghost sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread ? `${s.title} — ${s.unread.replace("{n}", num(unread, locale))}` : s.title}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void load();
        }}
      >
        <Icon name="bell" />
      </button>
      {unread > 0 && <span className="badge" aria-hidden="true">{num(Math.min(unread, 99), locale)}</span>}
      {open && (
        <div className="bell-panel" role="dialog" aria-label={s.title}>
          <header>
            <h3>{s.title}</h3>
            <span className="spacer" />
            {unread > 0 && (
              <button type="button" className="btn ghost sm" onClick={() => void readAll()}>
                <Icon name="check" />
                {s.markAll}
              </button>
            )}
          </header>
          {!items ? (
            <div className="loading">
              <i />
              <i />
            </div>
          ) : items.length === 0 ? (
            <div className="empty" style={{ padding: 28 }}>
              <Icon name="bell" />
              <div>{s.empty}</div>
            </div>
          ) : (
            <ul className="notes-list">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} locale={locale} onRead={read} labels={{ markRead: s.markRead, open: s.open }} onNavigate={() => setOpen(false)} />
              ))}
            </ul>
          )}
          <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
            <Link className="btn sm" href={alertsHref} onClick={() => setOpen(false)} style={{ width: "100%", justifyContent: "center" }}>
              {s.viewAll}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
