import Link from "next/link";
import { Icon } from "./icons";
import type { Locale, T } from "../lib/i18n";
import { num } from "../lib/format";

export type NavCounts = { projects?: number; issues?: number; fixes?: number; approvals?: number };

const GROUPS: Array<{ group: string; items: Array<{ href: string; key: string; icon: string; count?: keyof NavCounts }> }> = [
  { group: "nav_setup", items: [{ href: "/onboarding", key: "onboarding", icon: "rocket" }] },
  {
    group: "nav_analyze",
    items: [
      { href: "/", key: "dashboard", icon: "dash" },
      { href: "/projects", key: "projects", icon: "folder", count: "projects" },
      { href: "/audit", key: "audit", icon: "pulse" },
      { href: "/issues", key: "issues", icon: "alert", count: "issues" },
    ],
  },
  {
    group: "nav_act",
    items: [
      { href: "/fixes", key: "fixes", icon: "wand", count: "fixes" },
      { href: "/approvals", key: "approvals", icon: "shield", count: "approvals" },
      { href: "/content", key: "content", icon: "bulb" },
    ],
  },
  {
    group: "nav_system",
    items: [
      { href: "/connectors", key: "connectors", icon: "plug" },
      { href: "/reports", key: "reports", icon: "doc" },
      { href: "/settings", key: "settings", icon: "gear" },
    ],
  },
];

export function Nav({
  t,
  locale,
  pathname,
  counts,
}: {
  t: T;
  locale: Locale;
  pathname: string;
  counts: NavCounts;
}) {
  return (
    <aside className="nav">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          ST
        </div>
        <div>
          <b>{t("product")}</b>
          <span>{t("tagline")}</span>
        </div>
      </div>

      {GROUPS.map((group) => (
        <div key={group.group}>
          <div className="navgroup">{t(group.group as never)}</div>
          {group.items.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const count = item.count ? counts[item.count] : undefined;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="navbtn"
                {...(active ? { "aria-current": "page" as const } : {})}
              >
                <Icon name={item.icon} />
                <span>{t(item.key as never)}</span>
                {count !== undefined && count > 0 && <span className="tag">{num(count, locale)}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

export function TopBar({
  t,
  locale,
  pathname,
  title,
  right,
}: {
  t: T;
  locale: Locale;
  pathname: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="topbar">
      <div className="crumb">
        {t("product")} <span style={{ opacity: 0.4 }}>/</span> <b>{title}</b>
      </div>
      <span className="spacer" />
      {right}
      <div className="seg langsw" role="group" aria-label="Language">
        <Link
          href={`/api/locale?set=fa&next=${encodeURIComponent(pathname)}`}
          aria-current={locale === "fa"}
          prefetch={false}
        >
          فارسی
        </Link>
        <Link
          href={`/api/locale?set=en&next=${encodeURIComponent(pathname)}`}
          aria-current={locale === "en"}
          prefetch={false}
        >
          EN
        </Link>
      </div>
      <form action="/api/auth/logout" method="post">
        <button className="btn ghost sm" type="submit">
          {t("signout")}
        </button>
      </form>
    </div>
  );
}
