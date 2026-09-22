import IORedis, { type Redis, type RedisOptions } from "ioredis";
import { env } from "./env.js";

/**
 * Two connections with opposite failure modes:
 *
 * - `redis` is for BullMQ workers. BullMQ requires maxRetriesPerRequest:null, so
 *   while Redis is down its commands queue up and wait for the reconnect — right
 *   for a worker's blocking loop, wrong for anything serving a request.
 * - `redisCommand()` is for producers, the rate limiter and health checks. It
 *   fails fast: no offline queue, a command timeout and a bounded retry, so an
 *   outage turns into an error the caller handles instead of a hung request.
 */

const globalForRedis = globalThis as unknown as { __seoRedis?: Redis; __seoRedisCommand?: Redis };

const COMMAND_TIMEOUT_MS = 2_000;
const PING_TIMEOUT_MS = 2_500;

function make(name: string, options: RedisOptions): Redis {
  const client = new IORedis(env().REDIS_URL, {
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    // Resolve both A and AAAA records (e.g. a Railway private hostname is IPv6-only).
    family: 0,
    ...options,
  });
  client.on("error", (err) => {
    // Logged at warn: ioredis reconnects on its own, so this is not fatal.
    // eslint-disable-next-line no-console
    console.warn(`[redis:${name}]`, err.message);
  });
  return client;
}

export const redis: Redis =
  globalForRedis.__seoRedis ?? make("worker", { maxRetriesPerRequest: null });
// Cached only for dev hot-reload; tests and production get a fresh client per module graph.
if (process.env.NODE_ENV === "development") globalForRedis.__seoRedis = redis;

let commandClient: Redis | undefined = globalForRedis.__seoRedisCommand;

/** The fail-fast connection, created on first use. */
export function redisCommand(): Redis {
  if (!commandClient) {
    commandClient = make("command", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: COMMAND_TIMEOUT_MS,
    });
    if (process.env.NODE_ENV === "development") globalForRedis.__seoRedisCommand = commandClient;
  }
  return commandClient;
}

/**
 * Resolves once the fail-fast client can take commands. Without an offline queue
 * a command sent during the initial connect would be refused outright, so the
 * first request after a cold start waits (bounded) for the handshake instead.
 * A client that is reconnecting after an outage is not waited for.
 */
export async function commandReady(timeoutMs = COMMAND_TIMEOUT_MS): Promise<Redis> {
  const client = redisCommand();
  if (client.status !== "connecting" && client.status !== "connect") return client;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Redis connection not ready"));
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off("ready", onReady);
    };
    client.on("ready", onReady);
  });
  return client;
}

/** Never throws and never takes longer than ~2.5 s: a readiness probe must answer. */
export async function pingRedis(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
  });
  const ping = commandReady()
    .then((client) => client.ping())
    .then((res) => res === "PONG")
    .catch(() => false);
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeRedis(): Promise<void> {
  const clients = [redis, commandClient].filter((c): c is Redis => c !== undefined);
  commandClient = undefined;
  if (process.env.NODE_ENV === "development") globalForRedis.__seoRedisCommand = undefined;
  await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
}

export type { Redis };
