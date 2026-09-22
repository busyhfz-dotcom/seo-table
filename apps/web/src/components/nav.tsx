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
type NavState = { counts: NavCounts; projectId: string | null };

export type NavItem = { href: string; label: string; icon: string; count?: keyof NavCounts; orgWide?: boolean };
export type NavGroup = { label: string; items: NavItem[] };

const Ctx = createContext<{ state: NavState; set: (s: NavState) => void } | null>(null);

export function NavStateProvider({ initial, children }: { initial: NavState; children: ReactNode }) {
  const [state, set] = useState(initial);
  return <Ctx.Provider value={{ state, set }}>{children}</Ctx.Provider>;
}

/** Rendered by every page's TopBar: publishes that page's project and counts. */
export function NavSync({ counts, projectId }: NavState) {
  const ctx = useContext(Ctx);
  const set = ctx?.set;
  const key = JSON.stringify({ counts, projectId });
  useEffect(() => {
    set?.(JSON.parse(key) as NavState);
  }, [key, set]);
  return null;
}

export function NavLinks({ groups, locale, label }: { groups: NavGroup[]; locale: Locale; label: string }) {
  const pathname = usePathname();
  const state = useContext(Ctx)?.state ?? { counts: {}, projectId: null };
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
      {groups.map((group) => (
        <div key={group.label} className="navsec">
          <div className="navgroup">{group.label}</div>
          {group.items.map((item) => {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
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
