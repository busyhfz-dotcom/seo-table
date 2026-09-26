/**
 * Text helpers shared by the audit, analytics and planner: keyword matching
 * that treats Persian and Arabic spellings alike, hashtag and call-to-action
 * detection, and the Telegram HTML subset.
 */
import { extractHashtags } from "@seo/connectors";

export { extractHashtags };

/**
 * Lower-case, Arabic ي/ك/ة → Persian ی/ک/ه, no diacritics or tatweel, zero-width
 * joiners → space, Persian/Arabic digits → Latin, collapsed whitespace. A
 * keyword typed on one keyboard must match a bio typed on another.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[‌‍‎‏]/g, " ")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, " ")
    .trim();
}

export function containsKeyword(text: string | null | undefined, keyword: string): boolean {
  if (!text) return false;
  const k = normalize(keyword);
  return k.length > 0 && normalize(text).includes(k);
}

export function firstMissingKeyword(text: string | null | undefined, keywords: string[]): string | null {
  if (keywords.some((k) => containsKeyword(text, k))) return null;
  return keywords[0] ?? null;
}

export function charLength(text: string | null | undefined): number {
  return text ? [...text].length : 0;
}

/** Cut to `max` characters on a word boundary where one is close. */
export function fit(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) return text.trim();
  const cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s|،,:\-–—]+$/u, "");
}

/**
 * A call to action: an imperative to order, contact, message, join, visit or
 * follow a link, in Persian or English, or a pointing emoji. Heuristic by
 * nature; the audit words its finding as a suggestion.
 */
const CTA = [
  /\b(order|buy|shop|book|call|contact|dm|message|join|subscribe|visit|click|tap|download|sign ?up|register|whatsapp)\b/i,
  /(سفارش|خرید|تماس|دایرکت|پیام|عضو|عضویت|ثبت ?نام|رزرو|مشاوره|لینک|کلیک|دانلود|بزنید|بفرستید|واتساپ|تلگرام)/,
  /[👇⬇️👉📩☎️📞🛒]/u,
];
export function hasCallToAction(text: string | null | undefined): boolean {
  if (!text) return false;
  return CTA.some((re) => re.test(text));
}

const LINK = /(https?:\/\/\S+|\bt\.me\/\S+|(?:^|\s)@[A-Za-z][A-Za-z0-9_]{3,31}\b|\b[a-z0-9-]+\.(?:ir|com|net|org|shop|store|co|io|me)\b)/i;
export function hasLink(text: string | null | undefined): boolean {
  return Boolean(text && LINK.test(text));
}

/**
 * The subset of HTML Telegram accepts with parse_mode=HTML. Anything else makes
 * sendMessage fail, so the planner refuses it when the post is saved rather
 * than at publishing time.
 */
const TG_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "tg-spoiler", "span", "blockquote", "tg-emoji"]);
export function telegramHtmlProblems(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [whole, rawName, attrs] = m;
    const name = rawName!.toLowerCase();
    if (!TG_TAGS.has(name)) {
      problems.push(`tag_not_allowed:${name}`);
      continue;
    }
    if (name === "span" && !whole.startsWith("</") && !/class=["']tg-spoiler["']/.test(attrs ?? "")) {
      problems.push("span_needs_tg_spoiler");
    }
    if (name === "a" && !whole.startsWith("</") && !/href=["'](https?:\/\/|tg:\/\/)[^"']+["']/.test(attrs ?? "")) {
      problems.push("link_needs_href");
    }
    if (whole.startsWith("</")) {
      if (stack.pop() !== name) problems.push(`unbalanced:${name}`);
    } else {
      stack.push(name);
    }
  }
  if (stack.length) problems.push(`unclosed:${stack.join(",")}`);
  // A bare "<" or "&" that is not an entity also breaks Telegram's parser.
  if (/<(?![a-zA-Z/])/.test(html)) problems.push("bare_lt");
  if (/&(?!(lt|gt|amp|quot|#\d+|#x[0-9a-f]+);)/i.test(html)) problems.push("bare_ampersand");
  return [...new Set(problems)];
}

/** Visible text of Telegram HTML (for lengths: limits count the text, not the markup). */
export function telegramVisibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
