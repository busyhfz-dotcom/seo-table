"use client";

/**
 * The top bar's project picker. Each project carries its kind's icon (website,
 * Instagram page, Telegram channel), since the screens behind a project depend
 * on its kind. Screens every kind has keep their place on a switch; a screen
 * only one kind has falls back to the dashboard.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, kindIcon } from "./icons";

const SHARED = ["/", "/alerts", "/onboarding"];
/** Websites and Telegram channels (whose title and description changes are fixes); not Instagram. */
const FIXES = ["/fixes", "/approvals"];
const ORG_WIDE = ["/projects", "/settings"];

export type ProjectChoice = { id: string; name: string; kind: string };

export function ProjectSwitcher({
  projects,
  current,
  labels,
}: {
  projects: ProjectChoice[];
  current: string | null;
  labels: { title: string; all: string; kinds: Record<string, string> };
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => setOpen(false), [pathname]);

  const here = projects.find((p) => p.id === current) ?? null;
  if (projects.length === 0) return null;
  const target = (p: ProjectChoice) => {
    const sameFamily = here !== null && (here.kind === "WEBSITE") === (p.kind === "WEBSITE");
    // A document belongs to one project; its list is the place to land in another.
    const path = pathname.startsWith("/content/") ? "/content" : pathname;
    const keep = SHARED.includes(path)
      ? true
      : FIXES.includes(path)
        ? p.kind !== "INSTAGRAM"
        : sameFamily && !ORG_WIDE.includes(path);
    return `${keep ? path : "/"}?project=${encodeURIComponent(p.id)}`;
  };

  return (
    <div className="projsw" ref={box}>
      <button type="button" className="btn ghost sm" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)} title={labels.title}>
        <Icon name={kindIcon(here?.kind)} />
        <span className="projsw-name" translate="no" dir="auto">
          {here?.name ?? labels.title}
        </span>
        <Icon name="down" />
      </button>
      {open && (
        <div className="bell-panel projsw-panel" role="menu" aria-label={labels.title}>
          <ul className="notes-list">
            {projects.map((p) => (
              <li key={p.id} className={p.id === here?.id ? "unread" : undefined}>
                <span className="ic">
                  <Icon name={kindIcon(p.kind)} />
                </span>
                <Link href={target(p)} role="menuitem" className="projsw-item" aria-current={p.id === here?.id ? "true" : undefined}>
                  <b translate="no" dir="auto">
                    {p.name}
                  </b>
                  <span className="muted small">{labels.kinds[p.kind] ?? p.kind}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)" }}>
            <Link href="/projects" className="btn ghost sm">
              <Icon name="folder" />
              {labels.all}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
