/**
 * Pure helpers that read facts about an incoming request from its headers.
 * Kept free of Next and database imports so they can be unit-tested directly.
 */
import { isIP } from "node:net";

type HeaderSource = { get(name: string): string | null };

/**
 * The client's IP address as the edge proxy saw it.
 *
 * Railway's edge sets `X-Real-IP` and *appends* the connecting address as the
 * last `X-Forwarded-For` entry; everything to its left was supplied by the
 * client and can be forged. So: X-Real-IP if it is a valid address, else the
 * rightmost valid X-Forwarded-For entry, else "unknown".
 */
export function clientIp(headers: HeaderSource): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real && isIP(real)) return real;
  const forwarded = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim());
  for (let i = forwarded.length - 1; i >= 0; i--) {
    if (isIP(forwarded[i]!)) return forwarded[i]!;
  }
  return "unknown";
}

/**
 * Cross-site request check for cookie-authenticated unsafe requests.
 *
 * Browsers send `Sec-Fetch-Site` and/or `Origin` on every POST/PUT/PATCH/DELETE.
 * A request carrying neither is not from a browser (curl, a server), and so
 * cannot be riding on a victim's cookie. The host is compared against the
 * forwarded host (what the browser used) as well as `Host`, because behind the
 * proxy the two differ.
 */
export function isCrossSite(headers: HeaderSource): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";

  const origin = headers.get("origin");
  if (!origin) return false;
  if (origin === "null") return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const first = (v: string | null) => v?.split(",")[0]?.trim().toLowerCase() || null;
  const hosts = [first(headers.get("x-forwarded-host")), first(headers.get("host"))].filter(Boolean);
  return !hosts.includes(originHost);
}

/** A JSON body is only accepted with a JSON content type (application/json or +json). */
export function isJsonContentType(value: string | null): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(type);
}

const MAX_PAGE = 1_000_000;

/** ?page=&perPage= as bounded integers: page 1..1e6, perPage 1..200. */
export function parsePagination(params: URLSearchParams, defaultPerPage = 50) {
  const int = (raw: string | null, fallback: number, max: number) => {
    const n = Number(raw ?? fallback);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(1, Math.trunc(n)));
  };
  const page = int(params.get("page"), 1, MAX_PAGE);
  const perPage = int(params.get("perPage"), defaultPerPage, 200);
  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}

/** Idempotency keys are visible ASCII only, 1–255 characters. */
export function isValidIdempotencyKey(key: string): boolean {
  return /^[\x21-\x7e]{1,255}$/.test(key);
}
