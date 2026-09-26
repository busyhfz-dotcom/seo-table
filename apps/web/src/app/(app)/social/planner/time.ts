/**
 * Wall-clock time in the profile's time zone, whatever zone the browser is in:
 * the planner schedules "Tuesday 20:00 in Tehran", and its calendar groups by
 * the profile's days (the API does the same), in the Jalali calendar for
 * Persian readers.
 */
import type { Locale } from "../../../../lib/i18n";

/** Local wall time minus UTC, in ms, of `tz` at instant `t`. */
function offset(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** "YYYY-MM-DDTHH:mm" read as wall time in `tz` → ISO instant. */
export function wallToIso(wall: string, tz: string): string {
  const [d = "", time = "00:00"] = wall.split("T");
  const [y, m, dd] = d.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, dd!, hh ?? 0, mm ?? 0);
  // Twice: the first guess can sit on the other side of a DST change.
  let t = guess - offset(guess, tz);
  t = guess - offset(t, tz);
  return new Date(t).toISOString();
}

/** An instant as the "YYYY-MM-DDTHH:mm" wall time in `tz` (for a datetime-local input). */
export function isoToWall(iso: string, tz: string): string {
  const t = Date.parse(iso);
  return new Date(t + offset(t, tz)).toISOString().slice(0, 16);
}

/** The civil day ("YYYY-MM-DD") an instant falls on in `tz`. */
export function dayIn(iso: string | number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** An instant shown in `tz`: Jalali in Persian. */
export function whenIn(iso: string | null, tz: string, locale: Locale, withDate = true): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale === "fa" ? "fa-IR-u-ca-persian" : "en-US", {
    timeZone: tz,
    ...(withDate ? { year: "numeric", month: "short", day: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------- civil days

function noon(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

export function addDays(day: string, n: number): string {
  return new Date(noon(day).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Year, month and day of a civil day in the reader's calendar (Jalali for Persian). */
function parts(day: string, locale: Locale): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat(locale === "fa" ? "en-US-u-ca-persian" : "en-US", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(noon(day));
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value.replace(/\D/g, "") ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Saturday starts the week in Persian, Sunday in English. */
function weekStart(day: string, locale: Locale): string {
  const wd = noon(day).getUTCDay();
  const first = locale === "fa" ? 6 : 0;
  return addDays(day, -((wd - first + 7) % 7));
}

export function weekDays(day: string, locale: Locale): string[] {
  const start = weekStart(day, locale);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The weeks covering the reader's calendar month that contains `day`; `inMonth` marks its own days. */
export function monthGrid(day: string, locale: Locale): { days: Array<{ day: string; inMonth: boolean }>; first: string; last: string } {
  const first = addDays(day, -(parts(day, locale).d - 1));
  const month = parts(first, locale).m;
  let last = first;
  while (parts(addDays(last, 1), locale).m === month) last = addDays(last, 1);
  const start = weekStart(first, locale);
  const days: Array<{ day: string; inMonth: boolean }> = [];
  for (let d = start; d <= last || days.length % 7 !== 0; d = addDays(d, 1)) days.push({ day: d, inMonth: d >= first && d <= last });
  return { days, first, last };
}

/** The month after or before the one containing `day`, as a day inside it. */
export function shiftMonth(day: string, by: number, locale: Locale): string {
  const { first, last } = monthGrid(day, locale);
  return by > 0 ? addDays(last, 1) : addDays(first, -1);
}

export function monthTitle(day: string, locale: Locale): string {
  return noon(day).toLocaleDateString(locale === "fa" ? "fa-IR-u-ca-persian" : "en-US", { timeZone: "UTC", month: "long", year: "numeric" });
}

export function dayNumber(day: string, locale: Locale): string {
  return noon(day).toLocaleDateString(locale === "fa" ? "fa-IR-u-ca-persian" : "en-US", { timeZone: "UTC", day: "numeric" });
}

export function dayLabel(day: string, locale: Locale): string {
  return noon(day).toLocaleDateString(locale === "fa" ? "fa-IR-u-ca-persian" : "en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export function weekdayShort(day: string, locale: Locale): string {
  return noon(day).toLocaleDateString(locale === "fa" ? "fa-IR" : "en-US", { timeZone: "UTC", weekday: "short" });
}
