/**
 * Turns whatever an API call produced — a `{ error: { code } }` body, a bare HTTP
 * status, a non-JSON page from a proxy, or a network failure — into one sentence
 * in the reader's language. The server's English `message` is for logs and API
 * clients; the interface shows the code's translation instead. Safe to import
 * from client components (no server-only dependencies).
 */
import type { Locale } from "./i18n";
import { toPersianDigits } from "./format";

type Pair = { fa: string; en: string };

const CODES: Record<string, Pair> = {
  BAD_REQUEST: { fa: "ورودی درست نیست. فیلدها را بررسی کن.", en: "The input is not valid. Check the fields." },
  UNAUTHORIZED: { fa: "نشست شما تمام شده. دوباره وارد شو.", en: "Your session has ended. Sign in again." },
  INVALID_CREDENTIALS: { fa: "اعتبارنامه درست نیست.", en: "Those credentials are not valid." },
  FORBIDDEN: { fa: "نقش شما اجازه‌ی این کار را ندارد.", en: "Your role does not allow that." },
  NOT_FOUND: { fa: "پیدا نشد؛ ممکن است حذف شده باشد.", en: "Not found; it may have been removed." },
  CONFLICT: {
    fa: "این کار با وضعیت فعلی ممکن نیست. صفحه را بازآوری کن.",
    en: "That is not possible in the current state. Refresh the page.",
  },
  SCAN_ACTIVE: { fa: "یک اسکن برای این پروژه در حال اجراست.", en: "A scan is already running for this project." },
  RATE_LIMITED: { fa: "درخواست‌های بیش از حد. کمی بعد دوباره تلاش کن.", en: "Too many requests. Try again shortly." },
  POLICY_VIOLATION: { fa: "سیاست اجرای امن این کار را رد کرد.", en: "The execution safety policy refused this." },
  APPROVAL_REQUIRED: { fa: "این اصلاح بدون تأیید انسان اجرا نمی‌شود.", en: "This fix cannot run without human approval." },
  UPSTREAM_ERROR: { fa: "سرویس بیرونی پاسخ درستی نداد.", en: "The external service did not answer properly." },
  CONNECTOR_NOT_CONNECTED: { fa: "اتصال لازم برقرار نیست. ابتدا آن را وصل کن.", en: "The required connector is not connected yet." },
  BLOCKED_ADDRESS: {
    fa: "نشانی سایت به یک شبکه‌ی خصوصی یا داخلی اشاره می‌کند و قابل خزش نیست.",
    en: "The site address points to a private or internal network and cannot be crawled.",
  },
  UNSUPPORTED_MEDIA_TYPE: { fa: "قالب درخواست پذیرفته نیست.", en: "The request format is not accepted." },
  INTERNAL: { fa: "خطای داخلی سرور. دوباره تلاش کن.", en: "Internal server error. Try again." },
};

/** When a response carries no code (a proxy page, an empty body), its status decides. */
const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "POLICY_VIOLATION",
  429: "RATE_LIMITED",
  500: "INTERNAL",
  502: "UPSTREAM_ERROR",
};

const NETWORK: Pair = {
  fa: "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی کن.",
  en: "Could not reach the server. Check your connection.",
};
const UNREADABLE: Pair = { fa: "پاسخ سرور قابل خواندن نبود (کد {n}).", en: "The server's answer could not be read (HTTP {n})." };
const UNKNOWN: Pair = { fa: "درخواست ناموفق بود (کد {n}).", en: "The request failed (HTTP {n})." };

export type ApiFailure = {
  status: number;
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
  /** No parsable JSON body came back. */
  unreadable?: boolean;
  network?: boolean;
};

export function apiErrorMessage(
  locale: Locale,
  failure: ApiFailure,
  overrides?: Partial<Record<string, Pair>>,
): string {
  const n = locale === "fa" ? toPersianDigits(String(failure.status)) : String(failure.status);
  if (failure.network) return NETWORK[locale];
  const code =
    failure.code === "FORBIDDEN" && failure.details?.requiresApproval
      ? "APPROVAL_REQUIRED"
      : (failure.code ?? STATUS_CODES[failure.status]);
  const pair = (code && (overrides?.[code] ?? CODES[code])) || null;
  if (!pair) return (failure.unreadable ? UNREADABLE : UNKNOWN)[locale].replace("{n}", n);
  let text = pair[locale];
  const retry = Number(failure.details?.retryAfterSeconds);
  if (code === "RATE_LIMITED" && Number.isFinite(retry) && retry > 0) {
    const s = locale === "fa" ? toPersianDigits(String(Math.ceil(retry))) : String(Math.ceil(retry));
    text += locale === "fa" ? ` (${s} ثانیه‌ی دیگر)` : ` (in ${s}s)`;
  }
  return text;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; failure: ApiFailure };

/**
 * fetch + JSON parse that never throws. A JSON body is always sent with
 * `content-type: application/json`, which the API requires.
 */
export async function callApi<T = Record<string, unknown>>(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return { ok: false, failure: { status: 0, network: true } };
  }
  let data: unknown = null;
  let parsed = true;
  try {
    data = await res.json();
  } catch {
    parsed = false;
  }
  if (res.ok && parsed) return { ok: true, status: res.status, data: data as T };
  const error = (data as { error?: { code?: unknown; details?: unknown } } | null)?.error;
  return {
    ok: false,
    failure: {
      status: res.status,
      code: typeof error?.code === "string" ? error.code : undefined,
      details: error?.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : undefined,
      unreadable: !parsed,
    },
  };
}
