import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { login, currentSession } from "../../lib/auth";
import { DEFAULT_LOCALE, dirOf, isLocale, translator } from "../../lib/i18n";
import { Note } from "../../components/ui";
import { safePath } from "../../lib/redirect";
import { isAppError } from "@seo/core";
import { LanguageSwitch } from "../../components/shell";

export const dynamic = "force-dynamic";

/**
 * A plain server-action form: it works with JavaScript disabled, and the password
 * never touches client state.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const cookie = (await cookies()).get("locale")?.value;
  const locale = isLocale(cookie) ? cookie : DEFAULT_LOCALE;
  const t = translator(locale);

  if (await currentSession()) redirect(safePath(params.next));

  async function submit(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const next = safePath(String(formData.get("next") ?? "/"));
    const back = (error: string) =>
      `/login?error=${error}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;
    let ok: boolean;
    try {
      ok = (await login(email, password)).ok;
    } catch (err) {
      if (isAppError(err) && err.status === 429) redirect(back("rate"));
      throw err;
    }
    redirect(ok ? next : back("1"));
  }

  // The switch returns to this same sign-in screen, its `next` included.
  const here = `/login${params.next ? `?next=${encodeURIComponent(safePath(params.next))}` : ""}`;

  return (
    <div className="auth" dir={dirOf(locale)}>
      <LanguageSwitch locale={locale} here={here} label={t("language")} className="solo" />
      <div className="card">
        <div className="body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="mark" aria-hidden="true" style={{
              width: 30, height: 30, borderRadius: 8,
              background: "linear-gradient(145deg,var(--acc),var(--acc-dim))",
              display: "grid", placeItems: "center", color: "var(--acc-ink)",
              fontWeight: 700, fontFamily: "var(--f-en)", fontSize: 13,
            }}>
              ST
            </div>
            <div>
              <b style={{ fontFamily: "var(--f-en)", fontSize: 15 }}>{t("product")}</b>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", letterSpacing: ".06em", textTransform: "uppercase" }}>
                {t("tagline")}
              </div>
            </div>
          </div>

          {params.error && (
            <Note tone="crit" icon="alert">{t(params.error === "rate" ? "err_rate" : "login_failed")}</Note>
          )}

          <form action={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <input type="hidden" name="next" value={safePath(params.next)} />
            <label className="field">
              <span>{t("email")}</span>
              <input id="email" name="email" type="email" autoComplete="username" required dir="ltr" />
            </label>
            <label className="field">
              <span>{t("password")}</span>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                dir="ltr"
              />
            </label>
            <button className="btn primary" type="submit" style={{ justifyContent: "center" }}>
              {t("signin")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
