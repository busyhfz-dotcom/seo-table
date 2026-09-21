import IORedis, { type Redis } from "ioredis";
import { env } from "./env.js";

const globalForRedis = globalThis as unknown as { __seoRedis?: Redis };

function make(): Redis {
  const client = new IORedis(env().REDIS_URL, {
    // BullMQ requires this; it also stops a queue stall from throwing on every
    // command while Redis is briefly unreachable.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on("error", (err) => {
    // Logged at warn: ioredis reconnects on its own, so this is not fatal.
    // eslint-disable-next-line no-console
    console.warn("[redis]", err.message);
  });
  return client;
}

export const redis: Redis = globalForRedis.__seoRedis ?? make();
// Cached only for dev hot-reload; tests and production get a fresh client per module graph.
if (process.env.NODE_ENV === "development") globalForRedis.__seoRedis = redis;

export async function pingRedis(): Promise<boolean> {
  return (await redis.ping()) === "PONG";
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => redis.disconnect());
}

export type { Redis };
