/**
 * Redis sliding-window rate limiter.
 *
 * Each key is a sorted set of admitted request timestamps (sliding log). One Lua
 * script drops entries older than the window, counts what is left and admits the
 * request only if that count is under the limit, so two concurrent requests
 * cannot both take the last slot and there is no burst of 2×limit across a fixed
 * window boundary. Refused requests are not recorded: a client that keeps
 * retrying is not locked out beyond the window. Timestamps come from the Redis
 * server clock, so app instances with skewed clocks agree.
 *
 * It uses the fail-fast connection. If Redis is unavailable the limiter fails
 * open for read traffic and closed for logins and scan starts — losing Redis
 * should degrade the product, not hand out unlimited crawls.
 */
import { commandReady } from "./redis.js";
import { env } from "./env.js";
import { RateLimited } from "./errors.js";
import { logger } from "./logger.js";
import { newToken } from "./crypto.js";

// KEYS[1] = key; ARGV = window ms, limit, unique member.
// Returns { admitted (0|1), count after the call, ms until a slot frees }.
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return { 1, count + 1, 0 }
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local wait = window
if oldest[2] then wait = tonumber(oldest[2]) + window - now end
return { 0, count, math.max(wait, 1) }
`;

export type LimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
  /** Milliseconds until a slot frees up; 0 when allowed. */
  retryAfterMs: number;
};

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  opts: { failClosed?: boolean } = {},
): Promise<LimitResult> {
  // Not "rl:": that prefix held the old fixed-window counters (strings), and
  // a sorted-set command on one of those would fail until it expired.
  const redisKey = `rls:${key}`;
  try {
    const client = await commandReady();
    const [admitted, count, waitMs] = (await client.eval(
      SCRIPT,
      1,
      redisKey,
      String(windowMs),
      String(limit),
      `${Date.now()}-${newToken(6)}`,
    )) as [number, number, number];
    const allowed = admitted === 1;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      limit,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(waitMs / 1000)),
      retryAfterMs: allowed ? 0 : waitMs,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, "rate limiter unavailable");
    if (opts.failClosed) {
      return { allowed: false, remaining: 0, limit, retryAfterSeconds: 30, retryAfterMs: 30_000 };
    }
    return { allowed: true, remaining: limit, limit, retryAfterSeconds: 0, retryAfterMs: 0 };
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
 * Politeness gate: resolves when a fetch to `host` fits within `perSecond`
 * across every worker sharing this Redis. It waits as long as it takes (sleeping
 * exactly until the next slot frees, never proceeding over the limit), and gives
 * up only when `signal` aborts, by throwing its reason. If Redis is unreachable
 * it lets the fetch through: this is a courtesy to the site, not a security
 * control, and the crawler keeps its own in-process pacing.
 */
export async function hostGate(host: string, perSecond: number, signal?: AbortSignal): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    const res = await rateLimit(`host:${host}`, perSecond, 1000);
    if (res.allowed) return;
    await sleep(res.retryAfterMs, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
