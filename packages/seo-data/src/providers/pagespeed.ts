/**
 * PageSpeed Insights API v5 — a Lighthouse lab run plus Chrome UX Report field
 * data, free. Keyless requests share a small quota; a key (org integration or
 * PAGESPEED_API_KEY) raises it. A run takes 10–40 s.
 *
 * 429 is retried here with backoff (honouring Retry-After); pacing across
 * workers is the caller's job (see services/pagespeed.ts).
 */
import type { CruxFieldData, CruxMetric, CwvCategory, PageSpeedOpportunity, PageSpeedStrategy } from "@seo/db";
import { fetchJson, ProviderError, sleep } from "../http.js";
import type { ProviderCheck } from "./types.js";

export const PAGESPEED_API = "https://www.googleapis.com/pagespeedonline/v5";

export type PageSpeedMeasurement = {
  url: string;
  strategy: PageSpeedStrategy;
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  tbtMs: number | null;
  fieldData: CruxFieldData | null;
  opportunities: PageSpeedOpportunity[];
};

type Audit = {
  id?: string;
  title?: string;
  score?: number | null;
  numericValue?: number;
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number };
  metricSavings?: Record<string, number>;
};

type CruxRaw = {
  id?: string;
  origin_fallback?: boolean;
  overall_category?: string;
  metrics?: Record<string, { percentile?: number; category?: string }>;
};

type PsiResponse = {
  id?: string;
  loadingExperience?: CruxRaw;
  originLoadingExperience?: CruxRaw;
  lighthouseResult?: {
    finalUrl?: string;
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, Audit>;
  };
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> };
};

const MAX_OPPORTUNITIES = 8;

function category(raw: string | undefined): CwvCategory | null {
  return raw === "FAST" || raw === "AVERAGE" || raw === "SLOW" ? raw : null;
}

function cruxMetric(raw: CruxRaw["metrics"], key: string, scale = 1): CruxMetric | undefined {
  const m = raw?.[key];
  if (!m || typeof m.percentile !== "number") return undefined;
  return { p75: m.percentile / scale, category: category(m.category) };
}

/** CrUX for the page when Google has it, otherwise for the origin; null when neither has data. */
export function fieldData(res: PsiResponse): CruxFieldData | null {
  const page = res.loadingExperience;
  const pageHasData = page?.metrics && Object.keys(page.metrics).length > 0 && !page.origin_fallback;
  const source = pageHasData ? page : res.originLoadingExperience;
  if (!source?.metrics || Object.keys(source.metrics).length === 0) return null;
  const out: CruxFieldData = { scope: pageHasData ? "url" : "origin", overall: category(source.overall_category) };
  const lcp = cruxMetric(source.metrics, "LARGEST_CONTENTFUL_PAINT_MS");
  // CrUX reports CLS multiplied by 100.
  const cls = cruxMetric(source.metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE", 100);
  const inp = cruxMetric(source.metrics, "INTERACTION_TO_NEXT_PAINT");
  const fcp = cruxMetric(source.metrics, "FIRST_CONTENTFUL_PAINT_MS");
  const ttfb = cruxMetric(source.metrics, "EXPERIMENTAL_TIME_TO_FIRST_BYTE");
  if (lcp) out.lcpMs = lcp;
  if (cls) out.cls = cls;
  if (inp) out.inpMs = inp;
  if (fcp) out.fcpMs = fcp;
  if (ttfb) out.ttfbMs = ttfb;
  return out;
}

/**
 * Lighthouse "opportunities": audits that failed and estimate a saving. Older
 * Lighthouse puts it in details.overallSavingsMs, v12+ in metricSavings.
 */
export function opportunities(audits: Record<string, Audit>): PageSpeedOpportunity[] {
  const out: PageSpeedOpportunity[] = [];
  for (const [id, a] of Object.entries(audits)) {
    if (typeof a.score === "number" && a.score >= 0.9) continue;
    const metricMs = a.metricSavings
      ? Math.max(0, ...Object.entries(a.metricSavings).filter(([k]) => k !== "CLS").map(([, v]) => v))
      : 0;
    const savingsMs = a.details?.overallSavingsMs ?? (metricMs > 0 ? metricMs : null);
    const savingsBytes = a.details?.overallSavingsBytes ?? null;
    const isOpportunity = a.details?.type === "opportunity" || (savingsMs !== null && savingsMs > 0);
    if (!isOpportunity || !(savingsMs || savingsBytes)) continue;
    out.push({ id, title: a.title ?? id, savingsMs: savingsMs ?? null, savingsBytes, score: a.score ?? null });
  }
  return out.sort((x, y) => (y.savingsMs ?? 0) - (x.savingsMs ?? 0) || (y.savingsBytes ?? 0) - (x.savingsBytes ?? 0)).slice(0, MAX_OPPORTUNITIES);
}

function num(audits: Record<string, Audit>, id: string): number | null {
  const v = audits[id]?.numericValue;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function psiFailure(status: number, body: PsiResponse | null, text: string): ProviderError {
  const message = body?.error?.message ?? text.slice(0, 200);
  let reason = "provider_error";
  if (status === 429) reason = "quota_exceeded";
  else if (/API key not valid|API_KEY_INVALID|keyInvalid/i.test(message) || body?.error?.errors?.some((e) => e.reason === "keyInvalid")) {
    reason = "invalid_credentials";
  } else if (status === 403) reason = "access_denied";
  else if (/Lighthouse returned error|FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|DNS_FAILURE/i.test(message)) {
    reason = "page_unreachable";
  }
  return new ProviderError(reason, `PageSpeed Insights (HTTP ${status}): ${message}`, { status });
}

export type PageSpeedClient = {
  run(url: string, strategy: PageSpeedStrategy): Promise<PageSpeedMeasurement>;
  check(): Promise<ProviderCheck>;
};

export function pageSpeedInsights(
  opts: { apiKey?: string | null; baseUrl?: string; retryDelaysMs?: number[] } = {},
): PageSpeedClient {
  const base = (opts.baseUrl ?? PAGESPEED_API).replace(/\/$/, "");
  const retryDelays = opts.retryDelaysMs ?? [10_000, 30_000, 90_000];

  async function run(url: string, strategy: PageSpeedStrategy): Promise<PageSpeedMeasurement> {
    const params = new URLSearchParams({ url, strategy: strategy.toUpperCase(), category: "PERFORMANCE" });
    if (opts.apiKey) params.set("key", opts.apiKey);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchJson<PsiResponse>(`${base}/runPagespeed?${params}`, { timeoutMs: 120_000 });
      if (res.status === 429 && attempt < retryDelays.length) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelays[attempt]!);
        continue;
      }
      if (res.status >= 400 || !res.data?.lighthouseResult) throw psiFailure(res.status, res.data, res.text);
      const lh = res.data.lighthouseResult;
      const audits = lh.audits ?? {};
      const field = fieldData(res.data);
      const score = lh.categories?.performance?.score;
      const round = (v: number | null) => (v === null ? null : Math.round(v));
      return {
        url,
        strategy,
        performanceScore: typeof score === "number" ? Math.round(score * 100) : null,
        lcpMs: round(num(audits, "largest-contentful-paint")),
        cls: num(audits, "cumulative-layout-shift"),
        // A lab run has no interactions, so INP can only come from the field.
        inpMs: field?.inpMs ? Math.round(field.inpMs.p75) : null,
        ttfbMs: round(num(audits, "server-response-time")),
        fcpMs: round(num(audits, "first-contentful-paint")),
        tbtMs: round(num(audits, "total-blocking-time")),
        fieldData: field,
        opportunities: opportunities(audits),
      };
    }
  }

  /** A real run against a stable public page: the only way PSI tells a bad key from a good one. */
  async function check(): Promise<ProviderCheck> {
    try {
      await run("https://www.google.com/", "desktop");
      return { ok: true, message: "PageSpeed Insights answered with this key." };
    } catch (err) {
      if (err instanceof ProviderError) return { ok: false, reason: err.reason, message: err.message };
      return { ok: false, reason: "network_error", message: (err as Error).message };
    }
  }

  return { run, check };
}

// ---------------------------------------------------------------- Core Web Vitals

/** Google's "good" / "poor" boundaries at the 75th percentile (web.dev/articles/vitals). */
export const CWV_THRESHOLDS = {
  lcpMs: { good: 2500, poor: 4000 },
  inpMs: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
} as const;

export type CwvRating = "good" | "needs_improvement" | "poor";

export function rate(metric: keyof typeof CWV_THRESHOLDS, value: number | null | undefined): CwvRating | null {
  if (value === null || value === undefined) return null;
  const t = CWV_THRESHOLDS[metric];
  return value <= t.good ? "good" : value <= t.poor ? "needs_improvement" : "poor";
}

export type CwvAssessment = {
  /** "field" = real-user CrUX data (what Google ranks on); "lab" = this Lighthouse run only. */
  basis: "field" | "lab";
  passed: boolean;
  lcp: CwvRating | null;
  inp: CwvRating | null;
  cls: CwvRating | null;
};

/**
 * Pass = every Core Web Vital with data is "good" at p75, as in Search
 * Console's report. Field data decides when Google has it. Without it, the lab
 * run is judged on LCP and CLS only — a lab run cannot measure INP — and is
 * labelled "lab" so it is never mistaken for Google's own assessment.
 */
export function assessCwv(m: Pick<PageSpeedMeasurement, "lcpMs" | "cls" | "fieldData">): CwvAssessment {
  const f = m.fieldData;
  if (f && (f.lcpMs || f.cls || f.inpMs)) {
    const lcp = rate("lcpMs", f.lcpMs?.p75);
    const inp = rate("inpMs", f.inpMs?.p75);
    const cls = rate("cls", f.cls?.p75);
    const rated = [lcp, inp, cls].filter((r) => r !== null);
    return { basis: "field", passed: rated.length > 0 && rated.every((r) => r === "good"), lcp, inp, cls };
  }
  const lcp = rate("lcpMs", m.lcpMs);
  const cls = rate("cls", m.cls);
  const rated = [lcp, cls].filter((r) => r !== null);
  return { basis: "lab", passed: rated.length > 0 && rated.every((r) => r === "good"), lcp, inp: null, cls };
}
