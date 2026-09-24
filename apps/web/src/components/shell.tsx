import { pageContext } from "../lib/page";
import { userOrgs } from "../lib/auth";
import { OrgSwitcher } from "./org-switcher";
import { Bell } from "./notifications";
import { NavLinks, NavStateProvider, NavSync, type NavCounts, type NavGroup } from "./nav";
import type { Locale, T } from "../lib/i18n";

export type { NavCounts } from "./nav";

const GROUPS: Array<{ group: string; items: Array<{ href: string; key: string; icon: string; count?: keyof NavCounts; orgWide?: boolean }> }> =
  [
    {
      group: "nav_overview",
      items: [
        { href: "/", key: "dashboard", icon: "dash" },
        { href: "/projects", key: "projects", icon: "folder", count: "projects", orgWide: true },
      ],
    },
    {
      group: "nav_health",
      items: [
        { href: "/audit", key: "audit", icon: "pulse" },
        { href: "/issues", key: "issues", icon: "alert", count: "issues" },
        { href: "/fixes", key: "fixes", icon: "wand", count: "fixes" },
        { href: "/approvals", key: "approvals", icon: "shield", count: "approvals" },
      ],
    },
    {
      group: "nav_growth",
      items: [
        { href: "/keywords", key: "keywords", icon: "trend" },
        { href: "/content", key: "content", icon: "pen" },
        { href: "/competitors", key: "competitors", icon: "users" },
        { href: "/pagespeed", key: "pagespeed", icon: "gauge" },
      ],
    },
    {
      group: "nav_technical",
      items: [
        { href: "/tools", key: "tools", icon: "code" },
        { href: "/browser", key: "browser", icon: "browser" },
      ],
    },
    {
      group: "nav_connect",
      items: [
        { href: "/connect", key: "connect_site", icon: "link" },
        { href: "/connectors", key: "connectors", icon: "plug" },
        { href: "/onboarding", key: "onboarding", icon: "rocket" },
      ],
    },
    {
      group: "nav_monitor",
      items: [
        { href: "/reports", key: "reports", icon: "doc" },
        { href: "/alerts", key: "alerts", icon: "bell" },
      ],
    },
    {
      group: "nav_system",
      items: [{ href: "/settings", key: "settings", icon: "gear", orgWide: true }],
    },
  ];

function groups(t: T): NavGroup[] {
  return GROUPS.map((g) => ({
    label: t(g.group as never),
    items: g.items.map((item) => ({
      href: item.href,
      label: t(item.key as never),
      icon: item.icon,
      ...(item.count ? { count: item.count } : {}),
      ...(item.orgWide ? { orgWide: true } : {}),
    })),
  }));
}

/**
 * The application frame. The sidebar's live parts are client components
 * (see nav.tsx) because this layout is not re-rendered when the router moves
 * between pages.
 */
export async function Shell({ children }: { children: React.ReactNode }) {
  const { t, locale, counts, requestedProjectId } = await pageContext();
  return (
    <NavStateProvider initial={{ counts, projectId: requestedProjectId }} locale={locale}>
      <div className="shell">
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
          <NavLinks groups={groups(t)} locale={locale} label={t("nav_label")} />
        </aside>
        <main>{children}</main>
      </div>
    </NavStateProvider>
  );
}

/** Query parameters that name something inside one organization. */
const ORG_SCOPED_PARAMS = ["project", "run", "issue", "new", "wp", "connect"];

export async function TopBar({ title, right }: { title: string; right?: React.ReactNode }) {
  const { t, locale, pathname, search, session, counts, requestedProjectId } = await pageContext();
  // Client navigations fetch the page with an internal `_rsc` cache-buster; it
  // must not end up in the address the language switch returns to.
  const hereParams = new URLSearchParams(search);
  hereParams.delete("_rsc");
  const here = `${pathname}${[...hereParams.keys()].length ? `?${hereParams.toString()}` : ""}`;
  const orgs = session.via === "session" ? await userOrgs(session.userId) : [];

  // After switching organization the old project/run ids mean nothing, so the
  // switch returns to the same screen without them.
  const orgNextParams = new URLSearchParams(hereParams);
  for (const p of ORG_SCOPED_PARAMS) orgNextParams.delete(p);
  const orgNext = `${pathname}${[...orgNextParams.keys()].length ? `?${orgNextParams.toString()}` : ""}`;

  return (
    <div className="topbar">
      {/* This page's project and counts, for the sidebar the layout rendered. */}
      <NavSync counts={counts} projectId={requestedProjectId} locale={locale} />
      <div className="crumb">
        {t("product")} <span style={{ opacity: 0.4 }}>/</span> <b>{title}</b>
      </div>
      <span className="spacer" />
      {right}
      {orgs.length > 1 && (
        <OrgSwitcher
          orgs={orgs.map((o) => ({ id: o.orgId, name: o.name }))}
          current={session.orgId}
          next={orgNext}
          label={t("organization")}
        />
      )}
      <Bell
        locale={locale}
        alertsHref={requestedProjectId ? `/alerts?project=${encodeURIComponent(requestedProjectId)}` : "/alerts"}
        s={{
          title: t("notifications"),
          markAll: t("bell_mark_all"),
          viewAll: t("bell_view_all"),
          empty: t("bell_empty"),
          markRead: t("bell_mark_read"),
          open: t("bell_open"),
          unread: t("bell_unread"),
        }}
      />
      <LanguageSwitch locale={locale} here={here} label={t("language")} />
      <form action="/api/auth/logout" method="post">
        <button className="btn ghost sm" type="submit">
          {t("signout")}
        </button>
      </form>
    </div>
  );
}

/**
 * Plain anchors: switching language changes <html lang/dir> and the sidebar,
 * which live in layouts only a full document load re-renders — so the whole
 * screen changes language at once, and the address (query included) is kept.
 */
export function LanguageSwitch({ locale, here, label, className }: { locale: Locale; here: string; label: string; className?: string }) {
  return (
    <div className={`seg langsw${className ? ` ${className}` : ""}`} role="group" aria-label={label}>
      <a href={`/api/locale?set=fa&next=${encodeURIComponent(here)}`} aria-current={locale === "fa"} lang="fa">
        فارسی
      </a>
      <a href={`/api/locale?set=en&next=${encodeURIComponent(here)}`} aria-current={locale === "en"} lang="en">
        EN
      </a>
    </div>
  );
}
