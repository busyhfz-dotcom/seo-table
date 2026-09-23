/**
 * The content editor's analysis: a 0–100 score and the checklist behind it.
 *
 * Pure: everything that needs the database or Search Console arrives in
 * `AnalysisContext` (see context.ts), so the scoring is testable on its own and
 * says exactly which inputs it had. A check without the data it needs is "na"
 * and does not count — a missing Search Console connection never lowers a score.
 *
 * Score = Σ weight × (pass 1, warn ½, fail 0) / Σ weight of applicable checks.
 * Thresholds are editorial guidance, not Google rules (Google publishes none
 * for density or length); each check says what it measured.
 *
 * Readability:
 *   - English: Flesch reading ease, 206.835 − 1.015·(words/sentences) −
 *     84.6·(syllables/words), syllables by vowel groups. ≥ 60 is plain English.
 *   - Persian: there is no validated Flesch equivalent, so the panel reports
 *     what can be measured honestly — average sentence length (≤ 20 words reads
 *     easily, over 28 is hard), the share of sentences over 25 words, paragraph
 *     length, and a passive-voice heuristic: sentences built on the auxiliary
 *     «شدن» after a past participle («شده است», «می‌شود», «گردید»). The heuristic
 *     over-counts compound verbs with «شدن» (e.g. «خوشحال شد»), so it only warns.
 */
import { SERP, serpFit, type SerpFit } from "./serp-width.js";
import { structure, type ContentStructure } from "./html.js";
import {
  countPhrase,
  foldText,
  isStopword,
  sentences,
  stem,
  syllables,
  tokenize,
  tokenKey,
  topicTerms,
  type Lang,
} from "./text.js";

export type CheckStatus = "pass" | "warn" | "fail" | "na";
export type LocalizedText = { fa: string; en: string };

export type Check = {
  id: string;
  group: "keyword" | "structure" | "length" | "readability" | "links" | "media" | "meta" | "terms";
  status: CheckStatus;
  weight: number;
  message: LocalizedText;
  /** The measured facts, for the UI to show next to the message. */
  data?: Record<string, unknown>;
};

export type AnalysisInput = {
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  body: string;
  targetKeyword: string | null;
  locale: string;
  url: string | null;
};

export type BenchmarkPage = { url: string; words: number; source: "gsc" | "tracked" | "competitor"; domain?: string };

export type LinkTarget = {
  url: string;
  title: string | null;
  /** Phrases that name the page: its top Search Console queries, H1, title without the brand. */
  phrases: Array<{ text: string; source: "gsc" | "h1" | "title" }>;
  clicks: number | null;
};

export type RelatedQuery = { query: string; impressions: number; clicks: number };

export type AnalysisContext = {
  /** Our pages ranking for the keyword and competitor pages about it; empty = no benchmark. */
  benchmark: BenchmarkPage[];
  /** Search Console queries of the target page (or containing the keyword); null = no Search Console. */
  relatedQueries: RelatedQuery[] | null;
  relatedScope: "page" | "keyword" | null;
  linkTargets: LinkTarget[];
  /** Hosts that count as internal (the site and its www twin). */
  siteHosts: string[];
};

export const EMPTY_CONTEXT: AnalysisContext = { benchmark: [], relatedQueries: null, relatedScope: null, linkTargets: [], siteHosts: [] };

export type Analysis = {
  score: number;
  lang: Lang;
  analyzedAt: string;
  stats: {
    words: number;
    sentences: number;
    paragraphs: number;
    headings: Record<"h1" | "h2" | "h3" | "h4" | "h5" | "h6", number>;
    links: { internal: number; external: number };
    images: { total: number; missingAlt: number };
  };
  keyword: null | {
    phrase: string;
    exact: number;
    variants: number;
    /** Percent of words that belong to occurrences (variants included). */
    density: number;
    inMetaTitle: boolean;
    inTitle: boolean;
    inFirstParagraph: boolean;
    inUrl: boolean | null;
    inMetaDescription: boolean;
    inSubheadings: number;
  };
  serp: { title: SerpFit; description: SerpFit | null };
  readability: {
    lang: Lang;
    fleschReadingEase: number | null;
    avgSentenceWords: number;
    longSentencePct: number;
    avgParagraphWords: number;
    longParagraphs: number;
    passivePct: number;
  };
  length: { words: number; benchmarkMedian: number | null; sample: BenchmarkPage[] };
  checks: Check[];
  suggestions: {
    internalLinks: Array<{ url: string; title: string | null; anchor: string; source: "gsc" | "h1" | "title" }>;
    relatedTerms: Array<{ term: string; impressions: number; clicks: number; present: boolean }> | null;
  };
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

function langOf(locale: string): Lang {
  return locale.toLowerCase().startsWith("fa") ? "fa" : "en";
}

/** Words of a URL's last path segments, so a slug can be matched like text. */
function slugText(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    return path.replace(/[-_/.+]+/g, " ");
  } catch {
    return "";
  }
}

const FA_PASSIVE = /\S+ه\s+(?:شده|شد|شدند|شود|شوند|می‌شود|میشود|می\s+شود|می‌شوند|گردید|گردد|می‌گردد)(?=\s|$|[.،؛!؟])/u;
const EN_PASSIVE = /\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en|wn|lt|pt)\b/i;

function isInternal(href: string, hosts: string[]): boolean {
  if (/^(#|\/(?!\/)|\.\.?\/)/.test(href)) return !href.startsWith("#");
  try {
    const h = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    return hosts.some((x) => x.replace(/^www\./, "") === h);
  } catch {
    return !/^[a-z]+:/i.test(href);
  }
}

function sameUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => decodeURIComponent(u.pathname).replace(/\/+$/, "") || "/";
    return x.hostname.replace(/^www\./, "") === y.hostname.replace(/^www\./, "") && path(x) === path(y);
  } catch {
    return a === b;
  }
}

function t(fa: string, en: string): LocalizedText {
  return { fa, en };
}

export function analyzeContent(input: AnalysisInput, ctx: AnalysisContext = EMPTY_CONTEXT, now = new Date()): Analysis {
  const lang = langOf(input.locale);
  const doc: ContentStructure = structure(input.body);
  const tokens = tokenize(doc.text);
  const words = tokens.length;
  const sents = sentences(doc.text);
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // ---- headings
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  for (const h of doc.headings) headingCounts[`h${h.level}` as keyof typeof headingCounts]++;
  const subheadings = doc.headings.filter((h) => h.level >= 2 && h.level <= 3);

  // ---- links and images
  const internal = doc.links.filter((l) => isInternal(l.href, ctx.siteHosts));
  const external = doc.links.filter((l) => !isInternal(l.href, ctx.siteHosts) && /^https?:/i.test(l.href));
  const missingAlt = doc.images.filter((i) => !i.alt).length;

  // ---- keyword
  const phrase = input.targetKeyword?.trim() || null;
  const metaTitle = input.metaTitle?.trim() || null;
  const metaDescription = input.metaDescription?.trim() || null;
  let keyword: Analysis["keyword"] = null;
  if (phrase) {
    const count = countPhrase(tokens, phrase, lang);
    const phraseWords = tokenize(phrase).length;
    const has = (text: string | null) => Boolean(text) && countPhrase(tokenize(text!), phrase, lang).variants > 0;
    keyword = {
      phrase,
      exact: count.exact,
      variants: count.variants,
      density: words ? round1(((count.variants * phraseWords) / words) * 100) : 0,
      inMetaTitle: has(metaTitle ?? input.title),
      inTitle: has(input.title) || doc.headings.some((h) => h.level === 1 && has(h.text)),
      inFirstParagraph: has(doc.firstParagraph),
      inUrl: input.url ? has(slugText(input.url)) : null,
      inMetaDescription: has(metaDescription),
      inSubheadings: subheadings.filter((h) => has(h.text)).length,
    };
    add({
      id: "keyword_in_meta_title",
      group: "keyword",
      weight: 8,
      status: keyword.inMetaTitle ? "pass" : "fail",
      message: keyword.inMetaTitle
        ? t("کلمهٔ کلیدی در عنوان سئو آمده است.", "The keyword is in the SEO title.")
        : t("کلمهٔ کلیدی را در عنوان سئو (title) بیاورید، ترجیحاً در ابتدای آن.", "Put the keyword in the SEO title, ideally near the start."),
    });
    add({
      id: "keyword_in_title",
      group: "keyword",
      weight: 6,
      status: keyword.inTitle ? "pass" : "fail",
      message: keyword.inTitle
        ? t("کلمهٔ کلیدی در عنوان اصلی (H1) آمده است.", "The keyword is in the main heading (H1).")
        : t("کلمهٔ کلیدی را در عنوان اصلی (H1) بیاورید.", "Use the keyword in the main heading (H1)."),
    });
    add({
      id: "keyword_in_first_paragraph",
      group: "keyword",
      weight: 6,
      status: !doc.firstParagraph ? "fail" : keyword.inFirstParagraph ? "pass" : "fail",
      message: keyword.inFirstParagraph
        ? t("کلمهٔ کلیدی در پاراگراف اول آمده است.", "The keyword appears in the first paragraph.")
        : t("کلمهٔ کلیدی را در پاراگراف اول بیاورید تا موضوع از ابتدا روشن باشد.", "Mention the keyword in the first paragraph so the topic is clear from the start."),
    });
    add({
      id: "keyword_in_url",
      group: "keyword",
      weight: 4,
      status: keyword.inUrl === null ? "na" : keyword.inUrl ? "pass" : "warn",
      message:
        keyword.inUrl === null
          ? t("نشانی صفحه هنوز مشخص نیست.", "The page has no URL yet.")
          : keyword.inUrl
            ? t("کلمهٔ کلیدی در نشانی (URL) صفحه آمده است.", "The keyword is in the URL.")
            : t("نشانی صفحه کلمهٔ کلیدی را ندارد. تغییر نشانی صفحهٔ منتشرشده ریدایرکت لازم دارد؛ فقط برای صفحهٔ تازه توصیه می‌شود.", "The URL does not contain the keyword. Changing a published URL needs a redirect; only worth it for a new page."),
    });
    add({
      id: "keyword_in_meta_description",
      group: "keyword",
      weight: 5,
      status: !metaDescription ? "fail" : keyword.inMetaDescription ? "pass" : "warn",
      message: !metaDescription
        ? t("توضیحات متا (meta description) نوشته نشده است.", "There is no meta description.")
        : keyword.inMetaDescription
          ? t("کلمهٔ کلیدی در توضیحات متا آمده است؛ گوگل آن را در نتایج پررنگ می‌کند.", "The keyword is in the meta description; Google bolds it in results.")
          : t("کلمهٔ کلیدی را در توضیحات متا بیاورید.", "Use the keyword in the meta description."),
    });
    const d = keyword.density;
    add({
      id: "keyword_density",
      group: "keyword",
      weight: 6,
      status: count.variants === 0 ? "fail" : d >= 0.5 && d <= 2.5 ? "pass" : d >= 0.2 && d <= 4 ? "warn" : "fail",
      data: { density: d, exact: count.exact, variants: count.variants, words },
      message:
        count.variants === 0
          ? t("کلمهٔ کلیدی در متن نیامده است.", "The keyword does not appear in the text.")
          : d > 2.5
            ? t(`تکرار کلمهٔ کلیدی ${d}٪ است؛ بیش از ۲٫۵٪ متن را غیرطبیعی می‌کند.`, `Keyword density is ${d}%; above 2.5% reads as stuffing.`)
            : d < 0.5
              ? t(`تکرار کلمهٔ کلیدی ${d}٪ است؛ کمی بیشتر (۰٫۵ تا ۲٫۵٪) به کار ببرید.`, `Keyword density is ${d}%; use it a little more (0.5–2.5%).`)
              : t(`تکرار کلمهٔ کلیدی ${d}٪ است که در محدودهٔ مناسب است.`, `Keyword density is ${d}%, within the usual range.`),
    });
    add({
      id: "keyword_in_subheadings",
      group: "keyword",
      weight: 4,
      status: subheadings.length === 0 ? "warn" : keyword.inSubheadings > 0 ? "pass" : "warn",
      message:
        keyword.inSubheadings > 0
          ? t("کلمهٔ کلیدی یا شکل‌های آن در زیرعنوان‌ها آمده است.", "The keyword or a variant appears in a subheading.")
          : t("کلمهٔ کلیدی یا یکی از شکل‌های آن را در دست‌کم یک زیرعنوان (H2/H3) بیاورید.", "Use the keyword or a variant in at least one subheading (H2/H3)."),
    });
  } else {
    add({
      id: "keyword_set",
      group: "keyword",
      weight: 0,
      status: "na",
      message: t("کلمهٔ کلیدی هدف تعیین نشده است؛ بررسی‌های کلمهٔ کلیدی انجام نشد.", "No target keyword is set, so the keyword checks were skipped."),
    });
  }

  // ---- structure
  const skipped = doc.headings.some((h, i) => i > 0 && h.level > doc.headings[i - 1]!.level + 1);
  const needsSections = words > 300;
  add({
    id: "headings_structure",
    group: "structure",
    weight: 6,
    status: headingCounts.h1 > 0 ? "warn" : needsSections && headingCounts.h2 === 0 ? "fail" : skipped ? "warn" : "pass",
    data: { ...headingCounts, skippedLevel: skipped },
    message:
      headingCounts.h1 > 0
        ? t("متن H1 دارد؛ عنوان سند خودش H1 صفحه است، زیرعنوان‌ها را H2 کنید.", "The body contains an H1; the document title is the page's H1, so make these H2s.")
        : needsSections && headingCounts.h2 === 0
          ? t("متن طولانی زیرعنوان (H2) ندارد؛ آن را بخش‌بندی کنید.", "A long text with no H2 subheadings; break it into sections.")
          : skipped
            ? t("ترتیب سطح زیرعنوان‌ها رعایت نشده (مثلاً H2 به H4).", "Heading levels are skipped (e.g. H2 straight to H4).")
            : t("ساختار زیرعنوان‌ها مرتب است.", "The heading structure is in order."),
  });

  // ---- length
  const benchmarkMedian = median(ctx.benchmark.map((b) => b.words));
  if (benchmarkMedian) {
    const ratio = words / benchmarkMedian;
    add({
      id: "content_length",
      group: "length",
      weight: 8,
      status: ratio >= 0.8 ? "pass" : ratio >= 0.5 ? "warn" : "fail",
      data: { words, benchmarkMedian, sample: ctx.benchmark.length },
      message:
        ratio >= 0.8
          ? t(`${words} کلمه؛ هم‌اندازهٔ صفحه‌های برتر این موضوع (میانه ${benchmarkMedian}).`, `${words} words, in line with the leading pages on this topic (median ${benchmarkMedian}).`)
          : t(`${words} کلمه؛ صفحه‌های برتر این موضوع حدود ${benchmarkMedian} کلمه دارند. موضوع را کامل‌تر پوشش دهید.`, `${words} words; the leading pages on this topic have about ${benchmarkMedian}. Cover the topic more fully.`),
    });
  } else {
    add({
      id: "content_length",
      group: "length",
      weight: 8,
      status: words >= 300 ? "pass" : words >= 150 ? "warn" : "fail",
      data: { words, benchmarkMedian: null },
      message:
        words >= 300
          ? t(`${words} کلمه. برای مقایسه با صفحه‌های برتر، Search Console یا رقبا را وصل کنید.`, `${words} words. Connect Search Console or add competitors to compare with leading pages.`)
          : t(`${words} کلمه؛ کمتر از ۳۰۰ کلمه معمولاً برای پوشش موضوع کم است.`, `${words} words; under 300 is usually too little to cover a topic.`),
    });
  }

  // ---- readability
  const sentenceWords = sents.map((s) => tokenize(s).length);
  const avgSentenceWords = sentenceWords.length ? round1(sentenceWords.reduce((a, b) => a + b, 0) / sentenceWords.length) : 0;
  const longSentencePct = sentenceWords.length ? round1((sentenceWords.filter((n) => n > 25).length / sentenceWords.length) * 100) : 0;
  const paragraphWords = doc.paragraphs.map((p) => tokenize(p).length);
  const avgParagraphWords = paragraphWords.length ? round1(paragraphWords.reduce((a, b) => a + b, 0) / paragraphWords.length) : 0;
  const longParagraphs = paragraphWords.filter((n) => n > 150).length;
  const passive = sents.filter((s) => (lang === "fa" ? FA_PASSIVE : EN_PASSIVE).test(lang === "fa" ? foldText(s) : s)).length;
  const passivePct = sents.length ? round1((passive / sents.length) * 100) : 0;
  let flesch: number | null = null;
  if (lang === "en" && words > 0 && sents.length > 0) {
    const syl = tokens.reduce((sum, w) => sum + syllables(w), 0);
    flesch = round1(206.835 - 1.015 * (words / sents.length) - 84.6 * (syl / words));
  }
  if (words < 50) {
    add({
      id: "readability",
      group: "readability",
      weight: 8,
      status: "na",
      message: t("متن برای سنجش خوانایی کوتاه است.", "Too little text to judge readability."),
    });
  } else if (lang === "en") {
    add({
      id: "readability",
      group: "readability",
      weight: 8,
      status: flesch! >= 60 ? "pass" : flesch! >= 30 ? "warn" : "fail",
      data: { fleschReadingEase: flesch, avgSentenceWords },
      message:
        flesch! >= 60
          ? t(`خوانایی (Flesch) ${flesch}: روان.`, `Flesch reading ease ${flesch}: plain English.`)
          : t(`خوانایی (Flesch) ${flesch}: دشوار. جمله‌ها و واژه‌ها را کوتاه‌تر کنید.`, `Flesch reading ease ${flesch}: hard to read. Use shorter sentences and words.`),
    });
  } else {
    add({
      id: "readability",
      group: "readability",
      weight: 8,
      status: avgSentenceWords <= 20 && longSentencePct <= 25 ? "pass" : avgSentenceWords <= 28 ? "warn" : "fail",
      data: { avgSentenceWords, longSentencePct },
      message:
        avgSentenceWords <= 20 && longSentencePct <= 25
          ? t(`میانگین طول جمله ${avgSentenceWords} واژه است؛ متن روان است.`, `Average sentence length is ${avgSentenceWords} words; the text reads easily.`)
          : t(`میانگین طول جمله ${avgSentenceWords} واژه و ${longSentencePct}٪ جمله‌ها بلندتر از ۲۵ واژه‌اند؛ جمله‌ها را کوتاه‌تر کنید.`, `Sentences average ${avgSentenceWords} words and ${longSentencePct}% are over 25; shorten them.`),
    });
  }
  add({
    id: "paragraph_length",
    group: "readability",
    weight: 3,
    status: words < 50 ? "na" : longParagraphs === 0 ? "pass" : "warn",
    data: { avgParagraphWords, longParagraphs },
    message:
      longParagraphs === 0
        ? t("طول پاراگراف‌ها مناسب است.", "Paragraphs are a comfortable length.")
        : t(`${longParagraphs} پاراگراف بیش از ۱۵۰ واژه دارد؛ آن‌ها را بشکنید.`, `${longParagraphs} paragraphs run over 150 words; split them.`),
  });
  add({
    id: "passive_voice",
    group: "readability",
    weight: 2,
    status: sents.length < 5 ? "na" : passivePct <= (lang === "fa" ? 25 : 10) ? "pass" : "warn",
    data: { passivePct, heuristic: true },
    message:
      passivePct <= (lang === "fa" ? 25 : 10)
        ? t("استفاده از فعل مجهول کم است.", "Little passive voice.")
        : t(`حدود ${passivePct}٪ جمله‌ها مجهول به نظر می‌رسند (تخمینی)؛ جملهٔ معلوم روشن‌تر است.`, `About ${passivePct}% of sentences look passive (estimate); active voice is clearer.`),
  });

  // ---- links and media
  add({
    id: "internal_links",
    group: "links",
    weight: 5,
    status: internal.length >= 2 || (words < 300 && internal.length >= 1) ? "pass" : internal.length === 1 ? "warn" : "fail",
    data: { internal: internal.length },
    message:
      internal.length === 0
        ? t("هیچ لینک داخلی ندارد؛ به صفحه‌های مرتبط سایت لینک دهید.", "No internal links; link to related pages on the site.")
        : t(`${internal.length} لینک داخلی دارد.`, `${internal.length} internal links.`),
  });
  add({
    id: "external_links",
    group: "links",
    weight: 2,
    status: external.length > 0 ? "pass" : "warn",
    data: { external: external.length },
    message:
      external.length > 0
        ? t(`${external.length} لینک به منابع بیرونی دارد.`, `${external.length} links to outside sources.`)
        : t("به یک منبع معتبر بیرونی ارجاع دهید، جایی که ادعایی را پشتیبانی می‌کند.", "Cite a reputable outside source where it supports a claim."),
  });
  add({
    id: "image_alt",
    group: "media",
    weight: 5,
    status: doc.images.length === 0 ? "na" : missingAlt === 0 ? "pass" : missingAlt / doc.images.length <= 0.2 ? "warn" : "fail",
    data: { images: doc.images.length, missingAlt },
    message:
      doc.images.length === 0
        ? t("متن تصویری ندارد.", "The text has no images.")
        : missingAlt === 0
          ? t("همهٔ تصویرها متن جایگزین (alt) دارند.", "Every image has alt text.")
          : t(`${missingAlt} از ${doc.images.length} تصویر متن جایگزین (alt) ندارد.`, `${missingAlt} of ${doc.images.length} images have no alt text.`),
  });

  // ---- meta
  const titleText = metaTitle ?? input.title;
  const titleFit = serpFit(titleText, "title");
  add({
    id: "meta_title_length",
    group: "meta",
    weight: 6,
    status: !titleText.trim()
      ? "fail"
      : titleFit.truncated || titleFit.chars > SERP.title.maxChars
        ? "warn"
        : titleFit.chars < SERP.title.minChars
          ? "warn"
          : "pass",
    data: { chars: titleFit.chars, px: titleFit.px, maxPx: titleFit.maxPx, fromDocumentTitle: !metaTitle },
    message: titleFit.truncated
      ? t(`عنوان سئو ${titleFit.chars} نویسه و حدود ${titleFit.px} پیکسل است؛ گوگل بیش از ${titleFit.maxPx} پیکسل را کوتاه می‌کند.`, `The SEO title is ${titleFit.chars} characters, about ${titleFit.px}px; Google cuts it beyond ${titleFit.maxPx}px.`)
      : titleFit.chars < SERP.title.minChars
        ? t(`عنوان سئو ${titleFit.chars} نویسه است؛ عنوان کوتاه فرصت نمایش را هدر می‌دهد.`, `The SEO title is only ${titleFit.chars} characters; a short title wastes space.`)
        : t(`عنوان سئو ${titleFit.chars} نویسه (حدود ${titleFit.px} پیکسل) و کامل نمایش داده می‌شود.`, `The SEO title is ${titleFit.chars} characters (about ${titleFit.px}px) and fits.`),
  });
  const descFit = metaDescription ? serpFit(metaDescription, "description") : null;
  add({
    id: "meta_description_length",
    group: "meta",
    weight: 5,
    status: !descFit ? "fail" : descFit.truncated || descFit.chars < SERP.description.minChars ? "warn" : "pass",
    data: descFit ? { chars: descFit.chars, px: descFit.px, maxPx: descFit.maxPx } : { chars: 0 },
    message: !descFit
      ? t("توضیحات متا ندارد؛ گوگل خودش بخشی از متن را برمی‌دارد.", "No meta description; Google will pick a snippet itself.")
      : descFit.truncated
        ? t(`توضیحات متا حدود ${descFit.px} پیکسل است و بعد از ${descFit.maxPx} پیکسل بریده می‌شود.`, `The meta description is about ${descFit.px}px and is cut after ${descFit.maxPx}px.`)
        : descFit.chars < SERP.description.minChars
          ? t(`توضیحات متا ${descFit.chars} نویسه است؛ ۷۰ تا ۱۶۰ نویسه بنویسید.`, `The meta description is ${descFit.chars} characters; aim for 70–160.`)
          : t(`توضیحات متا ${descFit.chars} نویسه و کامل نمایش داده می‌شود.`, `The meta description is ${descFit.chars} characters and fits.`),
  });

  // ---- related terms (Search Console)
  const docTerms = topicTerms(`${input.title} ${metaTitle ?? ""} ${doc.text}`, lang);
  let relatedTerms: Analysis["suggestions"]["relatedTerms"] = null;
  if (ctx.relatedQueries) {
    const keywordStems = phrase ? topicTerms(phrase, lang) : new Set<string>();
    const agg = new Map<string, { term: string; impressions: number; clicks: number; forms: Map<string, number> }>();
    for (const q of ctx.relatedQueries) {
      for (const tok of new Set(tokenize(q.query))) {
        if (isStopword(tok, lang)) continue;
        const s = stem(tok, lang);
        if (keywordStems.has(s)) continue;
        const cur = agg.get(s) ?? { term: tok, impressions: 0, clicks: 0, forms: new Map() };
        cur.impressions += q.impressions;
        cur.clicks += q.clicks;
        cur.forms.set(tok, (cur.forms.get(tok) ?? 0) + q.impressions);
        agg.set(s, cur);
      }
    }
    relatedTerms = [...agg.entries()]
      .map(([s, v]) => ({
        term: [...v.forms.entries()].sort((a, b) => b[1] - a[1])[0]![0],
        impressions: v.impressions,
        clicks: v.clicks,
        present: docTerms.has(s),
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 20);
    const top = relatedTerms.slice(0, 10);
    const covered = top.filter((x) => x.present).length;
    const share = top.length ? covered / top.length : 1;
    add({
      id: "related_terms",
      group: "terms",
      weight: 5,
      status: top.length === 0 ? "na" : share >= 0.7 ? "pass" : share >= 0.4 ? "warn" : "fail",
      data: { covered, of: top.length, scope: ctx.relatedScope },
      message:
        top.length === 0
          ? t("Search Console برای این موضوع هنوز جست‌وجوی مرتبطی ثبت نکرده است.", "Search Console has no related searches for this topic yet.")
          : t(`${covered} از ${top.length} واژهٔ پرتکرار جست‌وجوهای مرتبط (Search Console) در متن آمده است.`, `${covered} of the ${top.length} most-searched related terms (Search Console) appear in the text.`),
    });
  } else {
    add({
      id: "related_terms",
      group: "terms",
      weight: 5,
      status: "na",
      message: t("برای پیشنهاد واژه‌های مرتبط، Search Console را وصل کنید.", "Connect Search Console to get related terms."),
    });
  }

  // ---- internal link suggestions
  const folded = tokenize(doc.text);
  const linkedAlready = new Set<string>();
  for (const l of internal) {
    for (const target of ctx.linkTargets) {
      let href: string;
      try {
        href = new URL(l.href, target.url).toString();
      } catch {
        continue;
      }
      if (sameUrl(href, target.url)) linkedAlready.add(target.url);
    }
  }
  const internalLinks: Analysis["suggestions"]["internalLinks"] = [];
  for (const target of [...ctx.linkTargets].sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1))) {
    if (internalLinks.length >= 10) break;
    if (linkedAlready.has(target.url) || (input.url && sameUrl(target.url, input.url))) continue;
    const match = target.phrases.find((p) => tokenize(p.text).length > 0 && tokenize(p.text).length <= 6 && countPhrase(folded, p.text, lang).variants > 0 && !(phrase && tokenKey(foldText(p.text)) === tokenKey(foldText(phrase))));
    if (match) internalLinks.push({ url: target.url, title: target.title, anchor: match.text, source: match.source });
  }

  // ---- score
  const applicable = checks.filter((c) => c.status !== "na" && c.weight > 0);
  const total = applicable.reduce((s, c) => s + c.weight, 0);
  const earned = applicable.reduce((s, c) => s + c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  const score = total ? Math.round((earned / total) * 100) : 0;

  return {
    score,
    lang,
    analyzedAt: now.toISOString(),
    stats: {
      words,
      sentences: sents.length,
      paragraphs: doc.paragraphs.length,
      headings: headingCounts,
      links: { internal: internal.length, external: external.length },
      images: { total: doc.images.length, missingAlt },
    },
    keyword,
    serp: { title: titleFit, description: descFit },
    readability: { lang, fleschReadingEase: flesch, avgSentenceWords, longSentencePct, avgParagraphWords, longParagraphs, passivePct },
    length: { words, benchmarkMedian, sample: ctx.benchmark.slice(0, 20) },
    checks,
    suggestions: { internalLinks, relatedTerms },
  };
}
