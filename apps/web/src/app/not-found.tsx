import Link from "next/link";
import { headers } from "next/headers";
import { Icon } from "../components/icons";
import { LanguageSwitch } from "../components/shell";
import { locale as currentLocale } from "../lib/page";
import { translator } from "../lib/i18n";

/**
 * Any address that matches no screen. It is rendered outside the app frame
 * (it may be reached signed out), so it carries its own language switch.
 */
export default async function NotFound() {
  const locale = await currentLocale();
  const t = translator(locale);
  const h = await headers();
  const here = `${h.get("x-pathname") ?? "/"}${h.get("x-search") ?? ""}`;
  return (
    <div className="auth">
      <LanguageSwitch locale={locale} here={here} label={t("language")} className="solo" />
      <div className="card">
        <div className="body" style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" }}>
          <span className="mico" aria-hidden="true">
            <Icon name="search" />
          </span>
          <h1 style={{ fontSize: 18 }}>{t("not_found_title")}</h1>
          <p className="desc">{t("not_found_body")}</p>
          <Link className="btn primary" href="/">
            <Icon name="dash" />
            {t("back_home")}
          </Link>
        </div>
      </div>
    </div>
  );
}
