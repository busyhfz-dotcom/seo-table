import type { Locale } from "./i18n";

/** Locale-aware digits: Persian numerals in fa, Latin in en. */
export function num(value: number | null | undefined, locale: Locale): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString(locale === "fa" ? "fa-IR" : "en-US");
}

export function pct(value: number | null | undefined, locale: Locale, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toLocaleString(locale === "fa" ? "fa-IR" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

export function decimal(value: number | null | undefined, locale: Locale, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(locale === "fa" ? "fa-IR" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Jalali calendar in Persian, Gregorian in English. */
export function dateTime(value: Date | string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(locale === "fa" ? "fa-IR-u-ca-persian" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relative(value: Date | string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = d.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale === "fa" ? "fa-IR" : "en-US", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "second") {
      return rtf.format(Math.round(diffMs / ms), unit);
    }
  }
  return "—";
}

/** mm:ss for a run duration. */
export function duration(
  from: Date | string | null | undefined,
  to: Date | string | null | undefined,
  locale: Locale,
): string {
  if (!from) return "—";
  const start = typeof from === "string" ? new Date(from) : from;
  const end = to ? (typeof to === "string" ? new Date(to) : to) : new Date();
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const text = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return locale === "fa" ? toPersianDigits(text) : text;
}

export function toPersianDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
}

/** Shorten a URL to its path, for tables where the host is a given. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}
