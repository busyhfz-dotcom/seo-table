import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { dirOf, isLocale, DEFAULT_LOCALE } from "../lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "SEO Table",
  description: "SEO audit, fix and approval console",
};

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
