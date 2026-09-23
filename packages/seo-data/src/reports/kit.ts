/**
 * The pieces report templates are built from: embedded fonts, locale
 * formatting (Persian digits and the Jalali calendar in fa), escaping, and
 * inline SVG charts. Everything is inline because the PDF is printed offline
 * (see @seo/browser pdf.ts) — no font, image or chart is fetched.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ReportBrand } from "@seo/db";

export type ReportLocale = "fa" | "en";

// ---------------------------------------------------------------- fonts

type Fonts = { regular: string; bold: string; digitsFa: string };
let fonts: Fonts | null = null;

/**
 * Vazirmatn (SIL Open Font License, from the `vazirmatn` package) covers
 * Persian and Latin, so one face serves both report languages. The "FD"
 * (Farsi digits) cut is used only in the page header/footer, where Chromium
 * fills in page numbers as ASCII digits that the template cannot localise.
 */
export function reportFonts(): Fonts {
  if (fonts) return fonts;
  const require = createRequire(import.meta.url);
  const dir = require.resolve("vazirmatn/package.json").replace(/package\.json$/, "");
  const b64 = (path: string) => readFileSync(`${dir}${path}`).toString("base64");
  fonts = {
    regular: b64("fonts/webfonts/Vazirmatn-Regular.woff2"),
    bold: b64("fonts/webfonts/Vazirmatn-Bold.woff2"),
    digitsFa: b64("misc/Farsi-Digits/fonts/webfonts/Vazirmatn-FD-Regular.woff2"),
  };
  return fonts;
}

export function fontFaces(): string {
  const f = reportFonts();
  return `@font-face{font-family:"Vazirmatn";font-weight:400;src:url(data:font/woff2;base64,${f.regular}) format("woff2")}
@font-face{font-family:"Vazirmatn";font-weight:700;src:url(data:font/woff2;base64,${f.bold}) format("woff2")}`;
}

// ---------------------------------------------------------------- formatting

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function num(n: number | null | undefined, locale: ReportLocale, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
}

export function pct(ratio: number | null | undefined, locale: ReportLocale, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${num(ratio * 100, locale, digits)}${locale === "fa" ? "٪" : "%"}`;
}

/** A signed change: "+3" / "−2", in the locale's digits. */
export function delta(n: number | null | undefined, locale: ReportLocale, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return n === 0 ? num(0, locale) : "—";
  return `${n > 0 ? "+" : "−"}${num(Math.abs(n), locale, digits)}`;
}

export function date(value: Date | string | null | undefined, locale: ReportLocale): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value.length === 10 ? `${value}T00:00:00Z` : value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR-u-ca-persian" : "en-GB", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(d);
}

export function shortDate(value: string, locale: ReportLocale): string {
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR-u-ca-persian" : "en-GB", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

// ---------------------------------------------------------------- brand

export const DEFAULT_COLOR = "#0e9a5c";

export function brandColor(brand: ReportBrand | null | undefined): string {
  return brand?.color && /^#[0-9a-fA-F]{6}$/.test(brand.color) ? brand.color : DEFAULT_COLOR;
}

/** Only an image data URL is embedded; anything else would be a network fetch the offline printer refuses. */
export function logoSrc(brand: ReportBrand | null | undefined): string | null {
  return brand?.logo && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(brand.logo) ? brand.logo : null;
}

// ---------------------------------------------------------------- charts

export type Point = { label: string; value: number | null };

/**
 * A line chart for a time series. `invert` puts smaller values at the top
 * (search position: 1 is best). Gaps (null) break the line rather than
 * pretending a value existed. Always drawn left to right in time, in both
 * languages — dates run forward the same way on a Persian chart.
 */
export function lineChart(
  points: Point[],
  opts: { width?: number; height?: number; color: string; locale: ReportLocale; invert?: boolean; digits?: number; min?: number; max?: number },
): string {
  const W = opts.width ?? 640;
  const H = opts.height ?? 200;
  const pad = { top: 16, right: 16, bottom: 28, left: 44 };
  const values = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length < 2) return "";
  let lo = opts.min ?? Math.min(...values);
  let hi = opts.max ?? Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const x = (i: number) => pad.left + (i * (W - pad.left - pad.right)) / Math.max(1, points.length - 1);
  const y = (v: number) => {
    const r = (v - lo) / (hi - lo);
    return opts.invert ? pad.top + r * (H - pad.top - pad.bottom) : H - pad.bottom - r * (H - pad.top - pad.bottom);
  };
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));
  const ticks = [lo, (lo + hi) / 2, hi];
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const grid = ticks
    .map((v) => `<line x1="${pad.left}" x2="${W - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e5e9e7"/>` +
      `<text x="${pad.left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#6b756f">${esc(num(v, opts.locale, opts.digits ?? 0))}</text>`)
    .join("");
  const labels = points
    .map((p, i) => (i % labelEvery === 0 || i === points.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6b756f">${esc(p.label)}</text>` : ""))
    .join("");
  const lines = segments.map((s) => `<polyline points="${s}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("");
  const last = [...points].reverse().find((p) => p.value !== null);
  const lastIdx = last ? points.lastIndexOf(last) : -1;
  const dot = last && last.value !== null ? `<circle cx="${x(lastIdx).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="3.5" fill="${opts.color}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" direction="ltr" font-family="Vazirmatn" role="img">${grid}${labels}${lines}${dot}</svg>`;
}

/** One horizontal bar, for a table cell: the share `value/max` in the brand or a severity colour. */
export function bar(value: number, max: number, color: string, width = 160): string {
  const w = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * width)) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10"><rect width="${width}" height="10" rx="3" fill="#eef1ef"/><rect width="${w}" height="10" rx="3" fill="${color}"/></svg>`;
}

/** A score dial (0–100). */
export function gauge(score: number | null, color: string, locale: ReportLocale): string {
  const s = score === null ? 0 : Math.max(0, Math.min(100, score));
  const r = 42;
  const c = 2 * Math.PI * r;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><circle cx="56" cy="56" r="${r}" fill="none" stroke="#eef1ef" stroke-width="10"/><circle cx="56" cy="56" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${((s / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 56 56)"/><text x="56" y="64" text-anchor="middle" font-family="Vazirmatn" font-weight="700" font-size="26" fill="#17201b">${esc(score === null ? "—" : num(score, locale))}</text></svg>`;
}

export const SEVERITY_COLORS = { CRITICAL: "#d9463e", SERIOUS: "#e07a2e", WARNING: "#c99a1a", INFO: "#3a8fd0" } as const;
