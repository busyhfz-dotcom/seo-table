/**
 * Redis sliding-window rate limiter.
 *
 * A single Lua script does the increment and the TTL set, so two concurrent
 * requests cannot both see a fresh counter. If Redis is unavailable the limiter
 * fails open for read traffic and closed for scan starts — losing Redis should
 * degrade the product, not hand out unlimited crawls.
 */
import { redis } from "./redis.js";
import { env } from "./env.js";
import { RateLimited } from "./errors.js";
import { logger } from "./logger.js";

const SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

export type LimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
};

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  opts: { failClosed?: boolean } = {},
): Promise<LimitResult> {
  const redisKey = `rl:${key}`;
  try {
    const res = (await redis.eval(SCRIPT, 1, redisKey, String(windowMs))) as [number, number];
    const [current, ttl] = res;
    const allowed = current <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - current),
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, "rate limiter unavailable");
    if (opts.failClosed) {
      return { allowed: false, remaining: 0, limit, retryAfterSeconds: 30 };
    }
    return { allowed: true, remaining: limit, limit, retryAfterSeconds: 0 };
  }
}

export async function enforce(
  key: string,
  limit: number,
  windowMs: number,
  opts: { failClosed?: boolean } = {},
): Promise<LimitResult> {
  const res = await rateLimit(key, limit, windowMs, opts);
  if (!res.allowed) throw new RateLimited(res.retryAfterSeconds);
  return res;
}

/** Per-identity API limit. */
export function apiLimit(identity: string) {
  return enforce(`api:${identity}`, env().API_RATE_LIMIT_PER_MINUTE, 60_000);
}

/** Login attempts, per IP. Fails closed — brute force must not be free. */
export function authLimit(ip: string) {
  return enforce(`auth:${ip}`, env().AUTH_RATE_LIMIT_PER_MINUTE, 60_000, { failClosed: true });
}

/** Scan starts, per project. Fails closed — a crawl is expensive for the target site. */
export function scanLimit(projectId: string) {
  return enforce(`scan:${projectId}`, env().SCAN_RATE_LIMIT_PER_HOUR, 3_600_000, {
    failClosed: true,
  });
}

/**
 * Politeness gate used by the crawler: at most `perSecond` fetches per host.
 * This is a courtesy to the site being crawled, not a security control.
 */
export async function hostGate(host: string, perSecond: number): Promise<void> {
  const windowMs = 1000;
  for (let attempt = 0; attempt < 50; attempt++) {
    const res = await rateLimit(`host:${host}:${Math.floor(Date.now() / windowMs)}`, perSecond, windowMs);
    if (res.allowed) return;
    await new Promise((r) => setTimeout(r, 120));
  }
}
