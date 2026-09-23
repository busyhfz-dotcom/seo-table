/**
 * Keyword text normalisation.
 *
 * Persian text typed on an Arabic keyboard layout uses Arabic Yeh/Kaf, which
 * look identical but are different code points; Google folds them, so the panel
 * must too or "كتاب" and "کتاب" would be two tracked keywords with split data.
 * ZWNJ (U+200C) is meaningful in Persian ("می‌خواهم") and is kept.
 */
export function normalizePhrase(input: string): string {
  return input
    .normalize("NFC")
    .replace(/[يى]/g, "ی") // Arabic Yeh, Alef Maksura → Persian Yeh
    .replace(/ك/g, "ک") // Arabic Kaf → Persian Keheh
    .replace(/ـ/g, "") // tatweel is decoration
    .replace(/[‎‏‪-‮]/g, "") // direction marks copied from other apps
    .replace(/‌{2,}/g, "‌")
    .replace(/\s+/g, " ")
    .trim();
}

/** The key two phrases are compared by (Search Console reports queries in lower case). */
export function phraseKey(input: string): string {
  return normalizePhrase(input).toLowerCase();
}

/** Escape text for an RE2 regular expression (Search Console's includingRegex). */
export function re2Escape(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/** YYYY-MM-DD in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number, from: Date = new Date()): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** Bare host of a domain or URL typed by a person: "https://www.Rival.example/x" → "www.rival.example". */
export function toDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // A host needs a dot (a TLD) unless it is an IP literal, which the SSRF guard judges later.
    if (!host.includes(".") && !host.includes(":")) return null;
    return host;
  } catch {
    return null;
  }
}
