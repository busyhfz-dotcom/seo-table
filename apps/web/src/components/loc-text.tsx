import { localized, type Pair } from "../lib/seo-labels";
import type { Locale } from "../lib/i18n";

/** Names that stay as they are in Persian prose (brands, Google's metric names). */
const PLAIN = new Set([
  "Google", "Search Console", "PageSpeed Insights", "PageSpeed", "Core Web Vitals", "DataForSEO", "Cloudflare", "WordPress",
  "API", "HTML", "HTTP", "HTTPS", "URL", "JSON", "JSON-LD", "CSS", "DNS", "PDF", "LCP", "CLS", "INP", "TTFB", "CTR",
  "H1", "H2", "H3", "H4", "H5", "H6", "robots", "Googlebot", "Bingbot", "canonical", "noindex", "nofollow", "alt",
]);

/**
 * A server-worded {fa, en} message. Quoted «…» parts are the customer's own
 * words (a project name, a keyword) and are shown exactly as written, in their
 * own direction. In Persian, the rest is set in Persian digits, and a Latin run
 * that is not a plain name above is a technical token (a robots.txt directive,
 * a schema.org property, an address) shown as left-to-right code, so it reads
 * as code rather than as untranslated English.
 */
export function LocText({ pair, locale }: { pair: Pair | null | undefined; locale: Locale }) {
  if (!pair) return null;
  const raw = locale === "fa" ? pair.fa : pair.en;
  const segments = raw.split(/(«[^»]*»)/);
  return (
    <>
      {segments.map((seg, i) =>
        i % 2 === 1 ? (
          <span key={i}>
            «
            <span translate="no" dir="auto">
              {seg.slice(1, -1)}
            </span>
            »
          </span>
        ) : locale === "en" ? (
          seg
        ) : (
          <Persian key={i} text={seg} />
        ),
      )}
    </>
  );
}

function Persian({ text }: { text: string }) {
  const converted = localized({ fa: text, en: text }, "fa");
  const parts = converted.split(/((?:[A-Za-z@][\w@.:/+*=?&-]*)(?: [A-Za-z@][\w@.:/+*=?&-]*)*)/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && !PLAIN.has(part.replace(/[.:]+$/, "")) ? (
          <code key={i} dir="ltr" className="inline-code">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
