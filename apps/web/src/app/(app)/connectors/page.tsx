import Link from "next/link";
import { TopBar } from "../../../components/shell";
import { Card, Empty, Note, Rich, Status } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext, withProject } from "../../../lib/page";
import { listConnectors } from "../../../lib/queries";
import { connectorLabel } from "../../../lib/labels";
import { can } from "@seo/core";
import { relative } from "../../../lib/format";
import { AWAITING_OAUTH_APP, CONNECTOR_KINDS } from "@seo/connectors";
import { connectStrings } from "../connect/keys";
import { storedErrorText } from "../connect/load";
import { GoogleConnectCard } from "./google";

export const dynamic = "force-dynamic";

const DESCRIPTIONS: Record<string, { fa: string; en: string }> = {
  WORDPRESS: {
    fa: "نوشتن عنوان، متا، متن جانشین تصویر، canonical و ریدایرکت روی وردپرس — از راه API خود وردپرس یا افزونه‌ی SEO Table.",
    en: "Writes titles, meta, image alt text, canonical and redirects to WordPress — through its own API or the SEO Table plugin.",
  },
  CLOUDFLARE: {
    fa: "اعمال اصلاح‌ها در لبه‌ی Cloudflare، بدون نصب هیچ چیزی روی سایت.",
    en: "Applies fixes at the Cloudflare edge, without installing anything on the site.",
  },
  SEARCH_CONSOLE: {
    fa: "عبارت‌های جستجو، نمایش، کلیک و میانگین رتبه برای فرصت‌های محتوا؛ به‌علاوه‌ی ثبت نقشه‌ی سایت و بازرسی نشانی.",
    en: "Queries, impressions, clicks and average position for Content Opportunities, plus sitemap submission and URL inspection.",
  },
  GA4: {
    fa: "فقط خواندن: نشست، تعامل و تبدیل به تفکیک صفحه‌ی ورود.",
    en: "Read-only: sessions, engagement and conversions per landing page.",
  },
  INSTAGRAM: {
    fa: "رابط، مدل داده و مدیریت توکن آماده است. تا ثبت یک برنامه‌ی OAuth واقعی، هیچ داده‌ای نمایش داده نمی‌شود.",
    en: "Interface, data model and token handling are ready. Until a real OAuth application exists, no data is shown.",
  },
  YOUTUBE: {
    fa: "رابط، مدل داده و مدیریت توکن آماده است. تا ثبت یک برنامه‌ی OAuth واقعی، هیچ داده‌ای نمایش داده نمی‌شود.",
    en: "Interface, data model and token handling are ready. Until a real OAuth application exists, no data is shown.",
  },
};

const ICONS: Record<string, string> = {
  WORDPRESS: "globe",
  CLOUDFLARE: "cloud",
  SEARCH_CONSOLE: "search",
  GA4: "pulse",
  INSTAGRAM: "user",
  YOUTUBE: "play",
};

/** Kinds that write to the site; they are set up on the Connect site screen. */
const SITE_KINDS = new Set(["WORDPRESS", "CLOUDFLARE"]);

export default async function ConnectorsPage() {
  const { t, locale, session, project, requestedProjectId } = await pageContext();

  if (!project) {
    return (
      <>
        <TopBar title={t("connectors")} />
        <div className="view">
          <Card title={t("connectors")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const rows = await listConnectors(project.id);
  const canWrite = can(session.role, "connector:write");
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const connectHref = withProject("/connect", requestedProjectId);
  const strings = connectStrings(t);

  return (
    <>
      <TopBar title={t("connectors")} />
      <div className="view">
        <Note tone="lock" icon="info">
          {t("conn_note")}
        </Note>

        <div className="grid g3">
          {CONNECTOR_KINDS.map((kind) => {
            const row = byKind.get(kind);
            const status = row?.status ?? "NOT_CONNECTED";
            const awaiting = AWAITING_OAUTH_APP.includes(kind);
            const error = status === "ERROR" ? storedErrorText(locale, row?.lastError) : null;
            return (
              <section className="card method" key={kind}>
                <header>
                  <span className="mico" aria-hidden="true">
                    <Icon name={ICONS[kind] ?? "plug"} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <h3>{connectorLabel(kind)}</h3>
                    <div className="small muted">
                      {row?.lastSyncAt ? `${t("last_sync")} · ${relative(row.lastSyncAt, locale)}` : "—"}
                    </div>
                  </div>
                  <span className="spacer" />
                  <Status value={awaiting ? "NOT_CONNECTED" : status} t={t} />
                </header>
                <div className="body">
                  <p className="desc">{locale === "fa" ? DESCRIPTIONS[kind]?.fa : DESCRIPTIONS[kind]?.en}</p>
                  {error && (
                    <Note tone="crit" icon="alert">
                      <Rich text={error} />
                    </Note>
                  )}
                  {SITE_KINDS.has(kind) || kind === "SEARCH_CONSOLE" ? (
                    <div className="row">
                      <Link className="btn ghost" href={kind === "SEARCH_CONSOLE" ? `${connectHref}#search-console` : `${connectHref}#method-${kind}`}>
                        <Icon name="link" />
                        {status === "CONNECTED" ? t("manage") : t("connect")} · {t("connect_site")}
                      </Link>
                    </div>
                  ) : awaiting ? (
                    <span className="pill mute">
                      <Icon name="lock" />
                      {locale === "fa" ? "در انتظار ثبت برنامه‌ی OAuth" : "Awaiting OAuth registration"}
                    </span>
                  ) : status !== "CONNECTED" ? (
                    <GoogleConnectCard
                      kind="GA4"
                      s={strings}
                      locale={locale}
                      projectId={project.id}
                      baseUrl={project.baseUrl}
                      canWrite={canWrite}
                      canRun={can(session.role, "scan:run")}
                    />
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
