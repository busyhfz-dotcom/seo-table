import { pageContext } from "../lib/page";
import { userOrgs } from "../lib/auth";
import { OrgSwitcher } from "./org-switcher";
import { ProjectSwitcher } from "./project-switcher";
import { projectChoices } from "../lib/queries";
import { Bell } from "./notifications";
import { NavLinks, NavStateProvider, NavSync, type NavCounts, type NavGroup } from "./nav";
import type { Locale, T } from "../lib/i18n";
import type { ProjectKind } from "@seo/db";

export type { NavCounts } from "./nav";

type Kind = ProjectKind;
const WEB: Kind[] = ["WEBSITE"];
const SOCIAL: Kind[] = ["INSTAGRAM", "TELEGRAM"];

/**
 * `kinds` limits an item to projects of those kinds: a website is crawled and
 * connected to its CMS or CDN, an Instagram page or Telegram channel is synced
 * through its platform, so each shows only the screens that mean something for
 * it. Fixes and approvals stay for Telegram, whose title and description
 * changes go through them.
 */
const GROUPS: Array<{
  group: string;
  items: Array<{ href: string; key: string; icon: string; count?: keyof NavCounts; orgWide?: boolean; kinds?: Kind[] }>;
}> = [
  {
    group: "nav_overview",
    items: [
      { href: "/", key: "dashboard", icon: "dash" },
      { href: "/projects", key: "projects", icon: "folder", count: "projects", orgWide: true },
    ],
  },
  {
    group: "nav_profile",
    items: [
      { href: "/social", key: "social", icon: "user", kinds: SOCIAL },
      { href: "/social/audit", key: "social_audit", icon: "pulse", kinds: SOCIAL },
      { href: "/social/analytics", key: "social_analytics", icon: "trend", kinds: SOCIAL },
      { href: "/social/posts", key: "social_posts", icon: "list", kinds: SOCIAL },
    ],
  },
  {
    group: "nav_health",
    items: [
      { href: "/audit", key: "audit", icon: "pulse", kinds: WEB },
      { href: "/issues", key: "issues", icon: "alert", count: "issues", kinds: WEB },
      { href: "/fixes", key: "fixes", icon: "wand", count: "fixes", kinds: ["WEBSITE", "TELEGRAM"] },
      { href: "/approvals", key: "approvals", icon: "shield", count: "approvals", kinds: ["WEBSITE", "TELEGRAM"] },
    ],
  },
  {
    group: "nav_publish",
    items: [
      { href: "/social/planner", key: "social_planner", icon: "calendar", kinds: SOCIAL },
      { href: "/social/competitors", key: "competitors", icon: "users", kinds: SOCIAL },
    ],
  },
  {
    group: "nav_growth",
    items: [
      { href: "/keywords", key: "keywords", icon: "trend", kinds: WEB },
      { href: "/content", key: "content", icon: "pen", kinds: WEB },
      { href: "/competitors", key: "competitors", icon: "users", kinds: WEB },
      { href: "/pagespeed", key: "pagespeed", icon: "gauge", kinds: WEB },
    ],
  },
  {
    group: "nav_technical",
    items: [
      { href: "/tools", key: "tools", icon: "code", kinds: WEB },
      { href: "/browser", key: "browser", icon: "browser", kinds: WEB },
    ],
  },
  {
    group: "nav_connect",
    items: [
      { href: "/connect", key: "connect_site", icon: "link", kinds: WEB },
      { href: "/connectors", key: "connectors", icon: "plug", kinds: WEB },
      { href: "/onboarding", key: "onboarding", icon: "rocket" },
    ],
  },
  {
    group: "nav_monitor",
    items: [
      { href: "/reports", key: "reports", icon: "doc", kinds: WEB },
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
      ...(item.kinds ? { kinds: item.kinds } : {}),
    })),
  }));
}

/**
 * The application frame. The sidebar's live parts are client components
 * (see nav.tsx) because this layout is not re-rendered when the router moves
 * between pages.
 */
export async function Shell({ children }: { children: React.ReactNode }) {
  const { t, locale, counts, requestedProjectId, project } = await pageContext();
  return (
    <NavStateProvider initial={{ counts, projectId: requestedProjectId, kind: project?.kind ?? null }} locale={locale}>
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
  const { t, locale, pathname, search, session, counts, requestedProjectId, project } = await pageContext();
  // Client navigations fetch the page with an internal `_rsc` cache-buster; it
  // must not end up in the address the language switch returns to.
  const hereParams = new URLSearchParams(search);
  hereParams.delete("_rsc");
  const here = `${pathname}${[...hereParams.keys()].length ? `?${hereParams.toString()}` : ""}`;
  const [orgs, choices] = await Promise.all([session.via === "session" ? userOrgs(session.userId) : Promise.resolve([]), projectChoices(session.orgId)]);

  // After switching organization the old project/run ids mean nothing, so the
  // switch returns to the same screen without them.
  const orgNextParams = new URLSearchParams(hereParams);
  for (const p of ORG_SCOPED_PARAMS) orgNextParams.delete(p);
  const orgNext = `${pathname}${[...orgNextParams.keys()].length ? `?${orgNextParams.toString()}` : ""}`;

  return (
    <div className="topbar">
      {/* This page's project and counts, for the sidebar the layout rendered. */}
      <NavSync counts={counts} projectId={requestedProjectId} kind={project?.kind ?? null} locale={locale} />
      <div className="crumb">
        {t("product")} <span style={{ opacity: 0.4 }}>/</span> <b>{title}</b>
      </div>
      <span className="spacer" />
      {right}
      <ProjectSwitcher
        projects={choices}
        current={project?.id ?? null}
        labels={{
          title: t("project_switch"),
          all: t("project_all"),
          kinds: { WEBSITE: t("kind_WEBSITE"), INSTAGRAM: t("kind_INSTAGRAM"), TELEGRAM: t("kind_TELEGRAM") },
        }}
      />
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
