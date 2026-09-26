import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { dirOf, isLocale, translator, DEFAULT_LOCALE, type MessageKey } from "../lib/i18n";
import "./globals.css";

/** The tab title names the screen, in the reader's language. */
const TITLES: Record<string, MessageKey> = {
  "": "dashboard",
  login: "signin",
  onboarding: "onboarding",
  connect: "connect_site",
  projects: "projects",
  audit: "audit",
  issues: "issues",
  browser: "browser",
  fixes: "fixes",
  approvals: "approvals",
  content: "content",
  connectors: "connectors",
  reports: "reports",
  settings: "settings",
};

export async function generateMetadata(): Promise<Metadata> {
  const cookie = (await cookies()).get("locale")?.value;
  const t = translator(isLocale(cookie) ? cookie : DEFAULT_LOCALE);
  const section = ((await headers()).get("x-pathname") ?? "/").split("/")[1] ?? "";
  const key = TITLES[section] ?? "not_found_title";
  return {
    title: `${t(key)} · ${t("product")}`,
    description: t("meta_description"),
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080b09",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookie = (await cookies()).get("locale")?.value;
  const locale = isLocale(cookie) ? cookie : DEFAULT_LOCALE;
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;600;700&family=Sora:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
