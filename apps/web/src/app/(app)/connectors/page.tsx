import { TopBar } from "../../../components/shell";
import { Card, Empty, Note, Status } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { pageContext } from "../../../lib/page";
import { defaultProject, getProject, listConnectors } from "../../../lib/queries";
import { relative } from "../../../lib/format";
import { AWAITING_OAUTH_APP, CONNECTOR_KINDS } from "@seo/connectors";
import { WordPressForm } from "./wordpress-form";
import { sessionCan } from "../../../lib/auth";

export const dynamic = "force-dynamic";

const DESCRIPTIONS: Record<string, { fa: string; en: string }> = {
  WORDPRESS: {
    fa: "خواندن و نوشتن عنوان، متا، متن جانشین تصویر، canonical و ریدایرکت — هر نوشتن تابع سیاست اجرای امن است.",
    en: "Reads and writes titles, meta, image alt text, canonical and redirects — every write obeys the execution safety policy.",
  },
  SEARCH_CONSOLE: {
    fa: "فقط خواندن: عبارت‌های جستجو، نمایش، کلیک و میانگین رتبه. منبع صفحه‌ی فرصت‌های محتوا.",
    en: "Read-only: queries, impressions, clicks and average position. The source for Content Opportunities.",
  },
  GA4: {
    fa: "فقط خواندن: نشست، تعامل و تبدیل به تفکیک صفحه‌ی ورود.",
    en: "Read-only: sessions, engagement and conversions per landing page.",
  },
  INSTAGRAM: {
    fa: "اینترفیس، مدل داده و مدیریت توکن آماده است. تا ثبت یک اپلیکیشن OAuth واقعی، هیچ داده‌ای نمایش داده نمی‌شود.",
    en: "Interface, data model and token handling are ready. Until a real OAuth application exists, no data is shown.",
  },
  YOUTUBE: {
    fa: "اینترفیس، مدل داده و مدیریت توکن آماده است. تا ثبت یک اپلیکیشن OAuth واقعی، هیچ داده‌ای نمایش داده نمی‌شود.",
    en: "Interface, data model and token handling are ready. Until a real OAuth application exists, no data is shown.",
  },
};

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const params = await searchParams;
  const { t, locale, pathname, session } = await pageContext();

  const project = params.project
    ? await getProject(session.orgId, params.project)
    : await defaultProject(session.orgId);

  if (!project) {
    return (
      <>
        <TopBar t={t} locale={locale} pathname={pathname} title={t("connectors")} />
        <div className="view">
          <Card title={t("connectors")}>
            <Empty icon="rocket">{t("no_runs_yet")}</Empty>
          </Card>
        </div>
      </>
    );
  }

  const [rows, canWrite] = await Promise.all([
    listConnectors(project.id),
    sessionCan("connector:write"),
  ]);
  const byKind = new Map(rows.map((r) => [r.kind, r]));

  return (
    <>
      <TopBar t={t} locale={locale} pathname={pathname} title={t("connectors")} />
      <div className="view">
        <Note tone="lock" icon="info">
          {t("conn_note")}
        </Note>

        <div className="grid g3">
          {CONNECTOR_KINDS.map((kind) => {
            const row = byKind.get(kind);
            const status = row?.status ?? "NOT_CONNECTED";
            const awaiting = AWAITING_OAUTH_APP.includes(kind);
            const notes = (row?.scopes as string[] | undefined) ?? [];
            return (
              <section className="card" key={kind}>
                <div className="body">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 9,
                        flex: "none",
                        display: "grid",
                        placeItems: "center",
                        background: "var(--surface-3)",
                        color: "var(--ink-2)",
                        fontFamily: "var(--f-en)",
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      {kind.slice(0, 2)}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{label(kind)}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        {row?.lastSyncAt ? `${t("last_sync")} · ${relative(row.lastSyncAt, locale)}` : "—"}
                      </div>
                    </div>
                    <span className="spacer" />
                    <Status value={awaiting ? "NOT_CONNECTED" : status} t={t} />
                  </div>

                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 10 }}>
                    {locale === "fa" ? DESCRIPTIONS[kind]?.fa : DESCRIPTIONS[kind]?.en}
                  </div>

                  {row?.lastError && (
                    <Note tone="crit" icon="alert">
                      {row.lastError}
                    </Note>
                  )}

                  {notes.length > 0 && (
                    <ul className="plain" style={{ marginBottom: 10 }}>
                      {notes.slice(0, 3).map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}

                  {kind === "WORDPRESS" && canWrite && (
                    <WordPressForm
                      projectId={project.id}
                      connected={status === "CONNECTED"}
                      labels={{
                        siteUrl: t("site_url"),
                        username: t("username"),
                        appPassword: t("app_password"),
                        test: t("test_connection"),
                        connect: t("connect"),
                        manage: t("manage"),
                      }}
                    />
                  )}

                  {kind !== "WORDPRESS" && (
                    <div style={{ marginTop: 4 }}>
                      {awaiting ? (
                        <span className="pill mute">
                          <Icon name="lock" />
                          {locale === "fa" ? "در انتظار ثبت OAuth" : "Awaiting OAuth registration"}
                        </span>
                      ) : (
                        <span className="pill mute">
                          <Icon name="key" />
                          {locale === "fa"
                            ? "اتصال از طریق API با اعتبارنامه‌ی گوگل"
                            : "Connect via the API with a Google credential"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <Card title={locale === "fa" ? "افزونه‌ی پل وردپرس" : "WordPress bridge plugin"}>
          <p style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.8 }}>
            {locale === "fa"
              ? "وردپرس در REST API استاندارد خود عنوان سئو، متا دیسکریپشن، canonical و ریدایرکت را قابل نوشتن نمی‌کند. افزونه‌ی همراه این محصول (packages/connectors/wordpress-plugin) همان چند فیلد را باز می‌کند. بدون آن، این محصول ادعا نمی‌کند که نوشته است — آن اصلاح‌ها با پیام «پشتیبانی نمی‌شود» رد می‌شوند."
              : "WordPress does not make the SEO title, meta description, canonical or redirects writable through its standard REST API. The companion plugin (packages/connectors/wordpress-plugin) opens exactly those fields. Without it this product does not pretend the write succeeded — those fixes fail with an unsupported-field message."}
          </p>
        </Card>
      </div>
    </>
  );
}

function label(kind: string): string {
  return (
    {
      WORDPRESS: "WordPress",
      SEARCH_CONSOLE: "Search Console",
      GA4: "GA4",
      INSTAGRAM: "Instagram",
      YOUTUBE: "YouTube",
    }[kind] ?? kind
  );
}
