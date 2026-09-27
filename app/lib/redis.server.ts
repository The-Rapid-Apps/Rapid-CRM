import Redis from "ioredis";
import { env } from "./env.server";

/**
 * Shared cache/coordination client for cluster mode. Modeled on
 * db.server.ts's singleton-on-globalThis pattern so Vite HMR in dev reuses
 * the same connection instead of leaking a new one per reload.
 *
 * enableOfflineQueue: false + maxRetriesPerRequest: 1 means a Redis outage
 * fails a command fast (single retry, then reject) instead of queuing
 * commands indefinitely — every call site is expected to catch and fall back
 * to its pre-Redis in-process behavior rather than let a request hang.
 */
const globalForRedis = globalThis as unknown as { redis?: Redis };

function createClient(): Redis {
  return new Redis(env.REDIS_URL, {
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    lazyConnect: false,
  });
}

export const redis: Redis = globalForRedis.redis ?? createClient();

if (env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

redis.on("error", (error) => {
  // ioredis emits this on every failed reconnect attempt too; call sites
  // don't need to hear about each one, just need isRedisAvailable() to
  // reflect reality. Swallow here so an unhandled 'error' event never
  // crashes the process.
  void error;
});

export function isRedisAvailable(): boolean {
  return redis.status === "ready";
}

export async function closeRedis(): Promise<void> {
  if (redis.status === "end") return;
  await redis.quit().catch(() => redis.disconnect());
}
