/**
 * How wide a title or description is in Google's results, in pixels, and
 * where Google would cut it.
 *
 * Google truncates by rendered width, not by characters. Desktop results set
 * titles in Arial 20px and descriptions in Arial 14px; the usable widths are
 * about 600px and 920px (two lines of ~460px). These are the widely used
 * measurements from SERP preview tools, not a figure Google publishes, and the
 * real cut also depends on the device and on the words Google bolds — so the
 * panel shows an estimate and says so.
 *
 * Latin widths are Arial's advance widths (the Helvetica/Arial AFM metrics,
 * units per 1000 em). Arabic-script widths are an approximation by letter
 * shape: Arial's Persian glyphs vary with joining form, which a per-character
 * table cannot know, so narrow letters (ا د ر و …), wide ones (س ش ص ض …) and
 * the rest get class averages — typically within ±10% for real titles.
 */

const LATIN: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333, "*": 389,
  "+": 584, ",": 278, "-": 333, ".": 278, "/": 278, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
  "@": 1015, "[": 278, "\\": 278, "]": 278, "^": 469, _: 556, "`": 333, "{": 334, "|": 260, "}": 334, "~": 584,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722,
  O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556,
  o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  "–": 556, "—": 1000, "…": 1000, "«": 556, "»": 556, "·": 278,
};
const DIGIT = 556;
const FA_NARROW = new Set([..."اآأإدذرزژوؤ"]);
const FA_WIDE = new Set([..."سشصض"]);
/** Arial Persian glyphs per 1000 em, by class (see header). */
const FA_WIDTH = { narrow: 260, wide: 760, other: 470, punctuation: 300 };

function charWidth(ch: string): number {
  const known = LATIN[ch];
  if (known !== undefined) return known;
  if (/[0-9۰-۹٠-٩]/.test(ch)) return DIGIT;
  if (ch === "\u200C" || ch === "\u200D" || /[\u064B-\u065F\u0670]/.test(ch)) return 0;
  if (/[\u0600-ۿﭐ-﷿ﹰ-\uFEFF]/.test(ch)) {
    if (FA_NARROW.has(ch)) return FA_WIDTH.narrow;
    if (FA_WIDE.has(ch)) return FA_WIDTH.wide;
    if (/[،؛؟]/.test(ch)) return FA_WIDTH.punctuation;
    return FA_WIDTH.other;
  }
  // Accented Latin and anything else: the width of an average lower-case letter.
  return /\p{Lu}/u.test(ch) ? 700 : 556;
}

export function textWidthPx(text: string, fontPx: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch);
  return Math.round((units * fontPx) / 1000);
}

export const SERP = {
  title: { fontPx: 20, maxPx: 600, minChars: 30, maxChars: 60 },
  description: { fontPx: 14, maxPx: 920, minChars: 70, maxChars: 160 },
} as const;

export type SerpFit = {
  chars: number;
  px: number;
  maxPx: number;
  truncated: boolean;
  /** What Google would likely show, with "…" when cut. */
  preview: string;
};

export function serpFit(text: string, kind: keyof typeof SERP): SerpFit {
  const spec = SERP[kind];
  const clean = text.replace(/\s+/g, " ").trim();
  const px = textWidthPx(clean, spec.fontPx);
  let preview = clean;
  if (px > spec.maxPx) {
    // Cut at a word boundary that leaves room for the ellipsis, as Google does.
    const room = spec.maxPx - textWidthPx(" …", spec.fontPx);
    let used = 0;
    let cut = 0;
    const chars = [...clean];
    for (let i = 0; i < chars.length; i++) {
      used += (charWidth(chars[i]!) * spec.fontPx) / 1000;
      if (used > room) break;
      cut = i + 1;
    }
    const head = chars.slice(0, cut).join("");
    const space = head.lastIndexOf(" ");
    preview = `${(space > head.length * 0.6 ? head.slice(0, space) : head).trimEnd()} …`;
  }
  return { chars: [...clean].length, px, maxPx: spec.maxPx, truncated: px > spec.maxPx, preview };
}
