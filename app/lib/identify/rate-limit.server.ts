import { prisma } from "../db.server";

const WINDOW_MS = 60_000;

export class IdentifyRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests");
    this.name = "IdentifyRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Database-backed fixed-window rate limiting for the identify endpoint, keyed
 * by the app UUID. Mirrors enforceAppRateLimit (api-rate-limit.server.ts) but
 * against its own table, because an identify app id is a config value, not a
 * row in `apps`, so it can't carry that table's foreign key. The atomic upsert
 * works across every worker process — no in-memory counters.
 */
export async function enforceIdentifyRateLimit(params: {
  appId: string;
  routeKey: string;
  limit: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const windowStartMs = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  const windowStart = new Date(windowStartMs);
  const bucket = await prisma.identifyRateLimitBucket.upsert({
    where: {
      appId_routeKey_windowStart: {
        appId: params.appId,
        routeKey: params.routeKey,
        windowStart,
      },
    },
    create: {
      appId: params.appId,
      routeKey: params.routeKey,
      windowStart,
      requestCount: 1,
    },
    update: { requestCount: { increment: 1 } },
    select: { requestCount: true },
  });

  // Opportunistically prune stale buckets when a fresh window opens.
  if (bucket.requestCount === 1) {
    await prisma.identifyRateLimitBucket.deleteMany({
      where: {
        updatedAt: { lt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) },
      },
    });
  }

  if (bucket.requestCount > params.limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStartMs + WINDOW_MS - now.getTime()) / 1000),
    );
    throw new IdentifyRateLimitError(retryAfterSeconds);
  }
}
