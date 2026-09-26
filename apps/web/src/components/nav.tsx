"use client";

/**
 * The sidebar's live parts.
 *
 * The (app) layout is not re-rendered on client-side navigation, so anything in
 * the sidebar that depends on the current page — the active item, the project
 * carried in links, the badge counts — cannot be decided by the layout's server
 * render. The active item comes from the router; the project and the counts are
 * handed over by each page's TopBar (a server render per navigation) through
 * `NavSync`.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { num } from "../lib/format";
import type { Locale } from "../lib/i18n";

export type NavCounts = { projects?: number; issues?: number; fixes?: number; approvals?: number };
/** kind: the project on screen (the default project when none is named); null before any exists. */
type NavState = { counts: NavCounts; projectId: string | null; kind: string | null };

export type NavItem = { href: string; label: string; icon: string; count?: keyof NavCounts; orgWide?: boolean; kinds?: string[] };
export type NavGroup = { label: string; items: NavItem[] };

const Ctx = createContext<{ state: NavState; set: (s: NavState) => void; locale: Locale } | null>(null);

function cookieLocale(): string | null {
  return document.cookie.match(/(?:^|;\s*)locale=(fa|en)\b/)?.[1] ?? null;
}

/**
 * `locale` is the language the layout — the sidebar — was rendered in. A page
 * whose own render arrives in another language (the language was switched in
 * another tab, or this document came back from the back/forward cache after a
 * switch) would leave the sidebar in the old one; the whole document is
 * reloaded instead, so the screen is never half in each language.
 */
export function NavStateProvider({ initial, locale, children }: { initial: NavState; locale: Locale; children: ReactNode }) {
  const [state, set] = useState(initial);
  useEffect(() => {
    const check = (event: PageTransitionEvent) => {
      const current = cookieLocale();
      if (event.persisted && current && current !== locale) window.location.reload();
    };
    window.addEventListener("pageshow", check);
    return () => window.removeEventListener("pageshow", check);
  }, [locale]);
  return <Ctx.Provider value={{ state, set, locale }}>{children}</Ctx.Provider>;
}

/** Rendered by every page's TopBar: publishes that page's project and counts. */
export function NavSync({ counts, projectId, kind, locale }: NavState & { locale: Locale }) {
  const ctx = useContext(Ctx);
  const set = ctx?.set;
  const layoutLocale = ctx?.locale;
  const key = JSON.stringify({ counts, projectId, kind });
  useEffect(() => {
    set?.(JSON.parse(key) as NavState);
  }, [key, set]);
  useEffect(() => {
    if (layoutLocale && layoutLocale !== locale) window.location.reload();
  }, [layoutLocale, locale]);
  return null;
}

export function NavLinks({ groups, locale, label }: { groups: NavGroup[]; locale: Locale; label: string }) {
  const pathname = usePathname();
  const state = useContext(Ctx)?.state ?? { counts: {}, projectId: null, kind: null };
  // Before any project exists the website screens are listed: onboarding starts there.
  const kind = state.kind ?? "WEBSITE";
  const shown = groups
    .map((g) => ({ ...g, items: g.items.filter((item) => !item.kinds || item.kinds.includes(kind)) }))
    .filter((g) => g.items.length > 0);
  // The most specific item wins: "/social" must not stay lit on "/social/audit",
  // and "/connect" must not light up on "/connectors".
  const matches = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const activeHref = shown
    .flatMap((g) => g.items.map((i) => i.href))
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  const active = useRef<HTMLAnchorElement | null>(null);

  // On a phone the sidebar is one horizontally scrolling strip; keep the page
  // you are on in view instead of leaving it somewhere off to the side.
  useEffect(() => {
    const el = active.current;
    const strip = el?.parentElement?.parentElement;
    if (el && strip && strip.scrollWidth > strip.clientWidth + 1) {
      el.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [pathname]);

  return (
    <nav className="navitems" aria-label={label}>
      {shown.map((group) => (
        <div key={group.label} className="navsec">
          <div className="navgroup">{group.label}</div>
          {group.items.map((item) => {
            const isActive = item.href === activeHref;
            const count = item.count ? state.counts[item.count] : undefined;
            const href =
              state.projectId && !item.orgWide
                ? `${item.href}?project=${encodeURIComponent(state.projectId)}`
                : item.href;
            return (
              <Link
                key={item.href}
                href={href}
                className="navbtn"
                {...(isActive ? { ref: active, "aria-current": "page" as const } : {})}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {count !== undefined && count > 0 && <span className="tag">{num(count, locale)}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
