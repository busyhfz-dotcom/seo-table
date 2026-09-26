import Link from "next/link";
import { notificationService, pagespeedService, rankService } from "@seo/seo-data";
import { Card, Empty } from "../../components/ui";
import { Icon } from "../../components/icons";
import { PosChange, ScoreRing } from "../../components/kit";
import { Bar } from "../../components/ui";
import { decimal, num, relative } from "../../lib/format";
import { LocText } from "../../components/loc-text";
import { pageContext } from "../../lib/page";

/**
 * The dashboard's search-growth row: keyword movers, Core Web Vitals, unread
 * alerts. Each reads stored data only (no third-party call), and a part that
 * fails to load is simply left out rather than taking the dashboard down.
 */
export async function GrowthCards({ projectId, orgId, href }: { projectId: string; orgId: string; href: (path: string) => string }) {
  const { t, locale } = await pageContext();
  const [movers, speed, alerts] = await Promise.all([
    rankService.movers(projectId, { days: 7, limit: 3 }).catch(() => null),
    pagespeedService.summary(projectId).catch(() => null),
    notificationService.listNotifications(orgId, { page: 1, perPage: 3, unreadOnly: true, projectId }).catch(() => null),
  ]);
  const moverRows = movers ? [...movers.gains, ...movers.losses].slice(0, 5) : [];

  return (
    <div className="grid g3">
      <Card
        title={t("dash_movers")}
        sub={t("dash_movers_sub")}
        right={
          <Link className="btn ghost sm" href={href("/keywords")}>
            {t("view")}
          </Link>
        }
      >
        {moverRows.length === 0 ? (
          <Empty icon="trend">{t("dash_movers_empty")}</Empty>
        ) : (
          <ul className="movers">
            {moverRows.map((m) => (
              <li key={m.keywordId}>
                <span className="ph">
                  <span translate="no" dir="auto">
                    {m.phrase}
                  </span>
                </span>
                <span className="pos">{m.position === null ? "—" : decimal(m.position, locale)}</span>
                <PosChange current={m.position} previous={m.previousPosition} locale={locale} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t("dash_cwv")}
        sub={speed?.lastRunAt ? relative(speed.lastRunAt, locale) : undefined}
        right={
          <Link className="btn ghost sm" href={href("/pagespeed")}>
            {t("view")}
          </Link>
        }
      >
        {!speed || speed.pages.length === 0 ? (
          <Empty icon="gauge">{t("dash_cwv_empty")}</Empty>
        ) : (
          <div className="stack">
            {(["mobile", "desktop"] as const).map((st) => {
              const x = speed.totals[st];
              if (!x.pages) return null;
              return (
                <div key={st} className="row" style={{ flexWrap: "nowrap" }}>
                  <ScoreRing score={x.averageScore} locale={locale} label={t("dash_cwv_avg", { s: num(x.averageScore, locale) })} size={42} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <b>{t(st)}</b>
                      <span className="small muted">{t("dash_cwv_pass", { p: num(x.passed, locale), n: num(x.pages, locale) })}</span>
                    </div>
                    <Bar value={x.passed} max={x.pages} tone={x.passed === x.pages ? "ok" : "warn"} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title={t("dash_alerts")}
        sub={alerts ? num(alerts.unread, locale) : undefined}
        right={
          <Link className="btn ghost sm" href={href("/alerts")}>
            {t("view")}
          </Link>
        }
      >
        {!alerts || alerts.items.length === 0 ? (
          <Empty icon="bell">{t("dash_alerts_empty")}</Empty>
        ) : (
          <ul className="feed">
            {alerts.items.map((n) => (
              <li key={n.id}>
                <span className="ic">
                  <Icon name={n.severity === "CRITICAL" || n.severity === "SERIOUS" ? "alert" : "bell"} />
                </span>
                {n.link ? (
                  <Link href={n.link} className="lnk-plain">
                    <LocText pair={n.title} locale={locale} />
                  </Link>
                ) : (
                  <span>
                    <LocText pair={n.title} locale={locale} />
                  </span>
                )}
                <time>{relative(n.createdAt, locale)}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
