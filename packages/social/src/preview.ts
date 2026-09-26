/**
 * Telegram's public preview, cached. The sync, the competitor snapshots and a
 * person pressing "refresh" can all ask for the same channel within minutes;
 * Telegram should see one request, not three.
 */
import { redisCommand } from "@seo/core";
import { fetchChannelPreview, type ChannelPreview } from "@seo/connectors";

const TTL_SECONDS = 10 * 60;
const MAX_PAGES = 10;

// Namespaced like the queues, so a local app and the test suite sharing one
// Redis never read each other's cached channels.
function cacheKey(username: string, pages: number): string {
  return `${process.env.QUEUE_PREFIX ?? "seo"}:social:tme:${username.toLowerCase()}:${pages}`;
}

export async function cachedPreview(username: string, pages = 3): Promise<ChannelPreview> {
  const key = cacheKey(username, pages);
  const redis = redisCommand();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as ChannelPreview;
  } catch {
    // The cache is an optimisation: with Redis away, fetch directly.
  }
  const fresh = await fetchChannelPreview(username, { pages });
  await redis.set(key, JSON.stringify(fresh), "EX", TTL_SECONDS).catch(() => undefined);
  return fresh;
}

export async function forgetPreview(username: string): Promise<void> {
  const redis = redisCommand();
  // Known page counts instead of KEYS, which scans the whole keyspace.
  const keys = Array.from({ length: MAX_PAGES }, (_, i) => cacheKey(username, i + 1));
  await redis.del(...keys).catch(() => undefined);
}
