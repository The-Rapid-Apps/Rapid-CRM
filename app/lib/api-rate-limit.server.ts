import { prisma } from "./db.server";

const WINDOW_MS = 60_000;

export class ApiRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests");
    this.name = "ApiRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Database-backed fixed-window rate limiting. The atomic upsert works across
 * every application server process; no in-memory counters or sticky sessions.
 */
export async function enforceAppRateLimit(params: {
  appId: string;
  routeKey: string;
  limit?: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const limit = params.limit ?? 120;
  const windowStartMs = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  const windowStart = new Date(windowStartMs);
  const bucket = await prisma.apiRateLimitBucket.upsert({
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

  if (bucket.requestCount === 1) {
    await prisma.apiRateLimitBucket.deleteMany({
      where: {
        updatedAt: { lt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) },
      },
    });
  }

  if (bucket.requestCount > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStartMs + WINDOW_MS - now.getTime()) / 1000),
    );
    throw new ApiRateLimitError(retryAfterSeconds);
  }
}
