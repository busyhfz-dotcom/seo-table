/**
 * Text analysis for the content editor, Persian and English.
 *
 * Persian normalisation (for matching, never for display):
 *   - Arabic Yeh/Alef Maksura → Persian Yeh, Arabic Kaf → Keheh (see normalizePhrase);
 *   - harakat (U+064B–U+065F), superscript alef (U+0670) and tatweel removed;
 *   - Hamza-carrying alefs (أ إ) → ا and Teh Marbuta (ة) → ه, as Persian search folds them;
 *   - Persian and Arabic-Indic digits → ASCII;
 *   - ZWNJ (U+200C) is a joiner inside a word: "می‌خواهم", "میخواهم" and
 *     "می خواهم" are one phrase, so phrase matching compares token windows with
 *     separators removed (see countPhrase).
 * English: lower case, and a light stemmer (plural, -ing, -ed, possessive) so
 * "running shoes" also finds "running shoe".
 *
 * Tokens are words of letters/digits; a word is what word counts and density use.
 */
import { normalizePhrase } from "../text.js";

const HARAKAT = /[\u064B-\u065F\u0670\u0640]/g;
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const ZWNJ = "\u200C";

export type Lang = "fa" | "en";

/** Matching form of a text: normalised script, no diacritics, ASCII digits, lower case. */
export function foldText(input: string): string {
  return normalizePhrase(input)
    .replace(HARAKAT, "")
    .replace(/[أإٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .toLowerCase();
}

/** Letters (any script), digits, ZWNJ inside a word, and an apostrophe inside an English word. */
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}\u200C]|'(?=\p{L}))*/gu;

export function tokenize(input: string): string[] {
  const folded = foldText(input);
  return (folded.match(WORD) ?? []).map((t) => t.replace(/\u200C+$/u, ""));
}

/** A token without its ZWNJ, the unit phrase comparison uses. */
export function tokenKey(token: string): string {
  return token.replaceAll(ZWNJ, "");
}

export function detectLang(input: string): Lang {
  const arabicScript = (input.match(/[\u0600-ۿ]/g) ?? []).length;
  const latin = (input.match(/[A-Za-z]/g) ?? []).length;
  return arabicScript >= latin ? "fa" : "en";
}

// ---------------------------------------------------------------- stemming

// -ان/-ات plurals are left out on purpose: stripping them breaks too many stems ("ایران", "اطلاعات").
const FA_SUFFIXES = ["\u200Cهایی", "\u200Cهای", "\u200Cها", "هایی", "های", "ها", "\u200Cترین", "ترین", "\u200Cتر", "\u200Cای", "\u200Cی"];

/**
 * Light stems: enough to see "کتاب‌ها" in "کتاب" and "shoes" in "shoe", not a
 * morphological analyser. Short words are left alone so "ران" does not become "ر".
 */
export function stem(token: string, lang: Lang): string {
  if (lang === "fa") {
    for (const suffix of FA_SUFFIXES) {
      if (token.endsWith(suffix) && [...token].length - [...suffix].length >= 3) {
        return tokenKey(token.slice(0, token.length - suffix.length));
      }
    }
    return tokenKey(token);
  }
  let t = token.replace(/'s$/, "");
  if (t.length <= 3) return t;
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(t)) return t;
  if (/(ches|shes|xes|zes|sses)$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s")) t = t.slice(0, -1);
  if (t.endsWith("ing") && t.length > 5) t = undouble(t.slice(0, -3));
  else if (t.endsWith("ed") && t.length > 4) t = undouble(t.slice(0, -2));
  return t;
}

function undouble(t: string): string {
  return /([bdgmnprt])\1$/.test(t) ? t.slice(0, -1) : t;
}

// ---------------------------------------------------------------- phrases

export type PhraseCount = { exact: number; variants: number };

/**
 * Occurrences of a phrase in a token list. `exact` compares tokens without
 * ZWNJ, and also accepts the phrase split or joined differently ("می خواهم" /
 * "می‌خواهم" / "میخواهم", "کتاب ها" / "کتابها"); `variants` additionally
 * accepts light stems ("کتاب‌ها" for "کتاب", "shoes" for "shoe").
 */
export function countPhrase(tokens: string[], phrase: string, lang: Lang): PhraseCount {
  const want = tokenize(phrase);
  if (!want.length || !tokens.length) return { exact: 0, variants: 0 };
  const joined = want.map(tokenKey).join("");
  const stems = want.map((t) => stem(t, lang)).join(" ");
  let exact = 0;
  let variants = 0;
  const n = want.length;
  for (let i = 0; i < tokens.length; i++) {
    let hit: "exact" | "variant" | null = null;
    let width = n;
    // Same token count first, then one more or one fewer (split or joined differently).
    for (const w of [n, n + 1, n - 1]) {
      if (w < 1 || i + w > tokens.length) continue;
      const window = tokens.slice(i, i + w);
      if (window.map(tokenKey).join("") === joined) {
        hit = "exact";
        width = w;
        break;
      }
      if (w === n && window.map((t) => stem(t, lang)).join(" ") === stems) {
        hit = "variant";
        width = w;
        break;
      }
    }
    if (hit === "exact") exact++;
    if (hit) {
      variants++;
      i += width - 1;
    }
  }
  return { exact, variants };
}

export function containsPhrase(text: string, phrase: string, lang: Lang): boolean {
  return countPhrase(tokenize(text), phrase, lang).variants > 0;
}

// ---------------------------------------------------------------- stopwords

const STOP_FA = new Set(
  "و در به از که این آن با را برای تا یا هم اما اگر چه چی چرا چگونه چطور است هست بود شد شود می نمی های ها یک هر بر پس نیز باید دارد دارند کند کنند کرد کردن شده خود ما شما او آنها ایشان همه دیگر بین روی زیر بالا چند کدام کجا چیست کی اینکه آیا ولی بی نه".split(
    " ",
  ),
);
const STOP_EN = new Set(
  "a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those what which who whom how why when where do does did not no yes you your we our they their he she his her i me my can will would should could may might than then so such into over under about up down out more most very just also vs best".split(
    " ",
  ),
);

export function isStopword(token: string, lang: Lang): boolean {
  return (lang === "fa" ? STOP_FA : STOP_EN).has(tokenKey(token)) || /^\d+$/.test(token) || [...token].length < 2;
}

/** Distinct meaningful stems of a text, for topic overlap. */
export function topicTerms(text: string, lang: Lang): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) if (!isStopword(t, lang)) out.add(stem(t, lang));
  return out;
}

// ---------------------------------------------------------------- sentences

/** Sentences split on . ! ? and their Persian forms (؟ ۔), plus line breaks. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?؟۔…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => tokenize(s).length > 0);
}

/** English syllables by vowel groups, the usual heuristic behind Flesch implementations. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}
