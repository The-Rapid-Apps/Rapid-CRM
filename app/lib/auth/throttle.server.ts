import { logger } from "../logger.server";
import { redis, isRedisAvailable } from "../redis.server";

const log = logger.scope("auth-throttle");

/**
 * Fixed-window attempt counter shared by sign-in surfaces (the dashboard's
 * forgot-password form).
 *
 * Redis-backed so the limit holds across cluster workers, with an in-process
 * fallback when Redis is unreachable: degraded limiting, never a new outage.
 * Returns the count INCLUDING this attempt.
 */
export async function bumpAttempts(key: string, windowMs: number): Promise<number> {
  if (isRedisAvailable()) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, windowMs);
      return count;
    } catch (err) {
      log.warn("throttle fell back to in-process", { err: String(err) });
    }
  }
  return countInProcess(key, windowMs);
}

const inProcessAttempts = new Map<string, { count: number; resetAt: number }>();

function countInProcess(key: string, windowMs: number): number {
  const now = Date.now();
  const entry = inProcessAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    inProcessAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/**
 * Who to throttle, when the app sits behind a proxy.
 *
 * `x-forwarded-for` is only trustworthy when a reverse proxy sets it in front
 * of this app. The LAST hop is the one the proxy added; taking the first would
 * let a client supply its own value and pick its own bucket.
 */
export function clientKeyFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}
