import { Prisma } from "../db.server";
import { logger } from "../logger.server";
import { isRedisAvailable, redis } from "../redis.server";

const log = logger.scope("redis-cache");

/**
 * Cached values here are Prisma read results (or built directly from them),
 * so `Date`, `Prisma.Decimal`, and `bigint` (Prisma maps SQL `BIGINT`
 * aggregates like `COUNT(*)` to native `bigint`) are the non-JSON-native
 * types that actually show up in practice — tag them on the way out, restore
 * them on the way in. Anything else round-trips through plain
 * `JSON.stringify`/`parse`.
 *
 * Must read `this[key]` rather than trust the `value` parameter: both `Date`
 * and `Prisma.Decimal` define `toJSON()`, and `JSON.stringify` calls that
 * *before* invoking the replacer — so `value` already arrives as a plain
 * string by the time an `instanceof` check could see it. `this` inside a
 * replacer is bound to the object currently being stringified, which still
 * holds the original, untouched instance. (Must stay a `function`, not an
 * arrow function, for that `this` binding to exist.) `bigint` has no
 * `toJSON`, but `JSON.stringify` throws on a raw `bigint` before the replacer
 * even runs, so it needs the same tag-and-restore treatment regardless.
 */
function replacer(this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key];
  if (raw instanceof Date) return { __type: "Date", value: raw.toISOString() };
  if (raw instanceof Prisma.Decimal) {
    return { __type: "Decimal", value: raw.toString() };
  }
  if (raw instanceof Map) return { __type: "Map", value: [...raw.entries()] };
  if (typeof raw === "bigint") return { __type: "BigInt", value: raw.toString() };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__type" in value) {
    const tagged = value as { __type: string; value: unknown };
    if (tagged.__type === "Date") return new Date(tagged.value as string);
    if (tagged.__type === "Decimal") return new Prisma.Decimal(tagged.value as string);
    if (tagged.__type === "Map") {
      return new Map(tagged.value as Array<[unknown, unknown]>);
    }
    if (tagged.__type === "BigInt") return BigInt(tagged.value as string);
  }
  return value;
}

function serialize<T>(value: T): string {
  return JSON.stringify(value, replacer);
}

function deserialize<T>(raw: string): T {
  return JSON.parse(raw, reviver) as T;
}

// Per-process, not cross-worker: only dedups concurrent callers *in this
// worker* while a cold Redis miss is being computed, mirroring the benefit
// the original in-process `Map<string, Promise<T>>` caches gave. Cleared as
// soon as the compute settles (success or failure) — the resolved value's
// cross-worker lifetime lives in Redis's own TTL instead, via `redisKey`.
const localInFlight = new Map<string, Promise<unknown>>();

let warnedRedisCacheFallback = false;
function warnOnce(action: string, error: unknown): void {
  if (warnedRedisCacheFallback) return;
  warnedRedisCacheFallback = true;
  log.warn(`redis-cache: ${action} failed, falling back to per-process compute`, {
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Shape A — simple TTL cache. On a miss, only the first caller in this
 * process computes; concurrent same-process callers share that promise, and
 * once it resolves the value is written to Redis so other workers (and this
 * one, after the local promise is gone) hit Redis instead of recomputing.
 * Accepts a "stampede of up to N" (one redundant recompute per worker per TTL
 * boundary) rather than a cross-worker single-flight lock — see the Redis
 * migration plan for why that tradeoff was chosen.
 *
 * Never throws on a Redis outage: GET/SET failures fall back to computing
 * fresh every call, i.e. today's pre-Redis behavior for that one call.
 * `compute` failures are never cached, matching every cache in this codebase.
 */
export async function cachedWithRedis<T>(
  redisKey: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const existingLocal = localInFlight.get(redisKey);
  if (existingLocal) return existingLocal as Promise<T>;

  const pending = (async (): Promise<T> => {
    if (isRedisAvailable()) {
      try {
        const raw = await redis.get(redisKey);
        if (raw !== null) return deserialize<T>(raw);
      } catch (error) {
        warnOnce("GET", error);
      }
    }

    const value = await compute();

    if (isRedisAvailable()) {
      try {
        await redis.set(redisKey, serialize(value), "PX", ttlMs);
      } catch (error) {
        warnOnce("SET", error);
      }
    }
    return value;
  })();

  localInFlight.set(redisKey, pending);
  const clear = () => {
    if (localInFlight.get(redisKey) === pending) localInFlight.delete(redisKey);
  };
  pending.then(clear, clear);
  return pending;
}

/** Read-only lookup for a Shape A (`cachedWithRedis`) key — no compute triggered. */
export async function peekCache<T>(redisKey: string): Promise<T | null> {
  if (!isRedisAvailable()) return null;
  try {
    const raw = await redis.get(redisKey);
    return raw !== null ? deserialize<T>(raw) : null;
  } catch (error) {
    warnOnce("GET", error);
    return null;
  }
}

interface SwrEntry<T> {
  value: T;
  expiresAt: number;
  staleUntil: number;
}

/**
 * Shape B — stale-while-revalidate. Redis stores `{ value, expiresAt,
 * staleUntil }` as one blob per key. The in-flight map for the *background*
 * refresh is local, not Redis-backed — losing cross-worker dedup on a refresh
 * is low-risk (redundant refreshes are self-correcting, not compounding),
 * and keeping it local avoids a second round-trip primitive just for this.
 *
 * One instance of this per logical cache (call it once per cache, reuse the
 * returned functions) — the local in-flight map needs to be shared across
 * calls for the same cache, not recreated per call.
 */
export function createRedisSwrCache<T>(keyPrefix: string) {
  const requests = new Map<string, Promise<T>>();

  async function readEntry(key: string): Promise<SwrEntry<T> | null> {
    if (!isRedisAvailable()) return null;
    try {
      const raw = await redis.get(`${keyPrefix}${key}`);
      if (raw === null) return null;
      const entry = deserialize<SwrEntry<T>>(raw);
      return entry.staleUntil > Date.now() ? entry : null;
    } catch (error) {
      warnOnce("GET", error);
      return null;
    }
  }

  async function writeEntry(
    key: string,
    value: T,
    freshMs: number,
    staleMs: number,
  ): Promise<void> {
    if (!isRedisAvailable()) return;
    try {
      const now = Date.now();
      const entry: SwrEntry<T> = {
        value,
        expiresAt: now + freshMs,
        staleUntil: now + staleMs,
      };
      await redis.set(`${keyPrefix}${key}`, serialize(entry), "PX", staleMs);
    } catch (error) {
      warnOnce("SET", error);
    }
  }

  /**
   * Fresh hit: return immediately, no fetch. Stale-but-usable: kick off a
   * background `compute` (deduped per key against concurrent callers in this
   * process) and return the stale value right away. Cold: wait for `compute`.
   * `status` reports which of the three happened, for callers that surface
   * cache freshness to the user (e.g. a "last updated" / stale badge).
   */
  async function fetchOrRefresh(
    key: string,
    freshMs: number,
    staleMs: number,
    compute: () => Promise<T>,
  ): Promise<{ value: T; status: "fresh" | "stale" | "refreshed" }> {
    const entry = await readEntry(key);
    if (entry && entry.expiresAt > Date.now()) {
      return { value: entry.value, status: "fresh" };
    }

    const existing = requests.get(key);
    if (existing) {
      if (entry) return { value: entry.value, status: "stale" };
      return { value: await existing, status: "refreshed" };
    }

    const request = compute()
      .then(async (value) => {
        await writeEntry(key, value, freshMs, staleMs);
        return value;
      })
      .finally(() => requests.delete(key));
    requests.set(key, request);

    if (entry) {
      void request.catch(() => undefined);
      return { value: entry.value, status: "stale" };
    }
    return { value: await request, status: "refreshed" };
  }

  /** Read-only: usable (possibly stale) value with no fetch triggered, or null. */
  async function peek(key: string): Promise<T | null> {
    const entry = await readEntry(key);
    return entry ? entry.value : null;
  }

  /** Ignores any cached entry (fresh or stale) and always computes — still
   * deduped against a concurrent in-flight request for the same key. */
  function forceRefresh(
    key: string,
    freshMs: number,
    staleMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const existing = requests.get(key);
    if (existing) return existing;
    const request = compute()
      .then(async (value) => {
        await writeEntry(key, value, freshMs, staleMs);
        return value;
      })
      .finally(() => requests.delete(key));
    requests.set(key, request);
    return request;
  }

  return { fetchOrRefresh, peek, forceRefresh };
}

// Per-process fallback for `claimRedisThrottle` below, keyed by wall-clock
// time. Cuts the worst case to roughly N (once per cluster worker) rather
// than exactly 1 if Redis is unreachable — a known, already-tolerated
// degradation, not a new failure mode.
const inProcessThrottle = new Map<string, number>();

function claimInProcessThrottle(key: string, ttlMs: number): boolean {
  const lastRun = inProcessThrottle.get(key);
  if (lastRun && Date.now() - lastRun < ttlMs) return false;
  inProcessThrottle.set(key, Date.now());
  return true;
}

/**
 * Atomic "has this run within the last `ttlMs`?" claim, shared by every
 * throttled background writer in this codebase (the MRR and install daily
 * snapshots). `SET key "1" NX PX ttl` is atomic across cluster workers,
 * unlike a GET-then-SET — this is what actually cuts concurrent runs to
 * exactly 1 instead of up to N. Falls back to `claimInProcessThrottle` if
 * Redis is unreachable. Returns true if the caller should proceed.
 */
export async function claimRedisThrottle(
  key: string,
  ttlMs: number,
): Promise<boolean> {
  if (isRedisAvailable()) {
    try {
      const result = await redis.set(key, "1", "PX", ttlMs, "NX");
      return result === "OK";
    } catch (error) {
      warnOnce("throttle claim", error);
    }
  }
  return claimInProcessThrottle(key, ttlMs);
}

/** `SCAN`+`DEL` every key matching a glob pattern (`*` wildcards allowed
 * anywhere, not just a trailing prefix match — e.g. an activity cache keyed
 * by a sorted, joined multi-app string needs `*appId:*`, not `appId*`). */
export async function invalidateRedisCachePattern(pattern: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        200,
      );
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  } catch (error) {
    warnOnce("SCAN/DEL", error);
  }
}

/** `SCAN`+`DEL` every key under a prefix. Used by cache-invalidation paths that
 * today call `Map.clear()` on an in-process cache keyed by that same prefix. */
export function invalidateRedisCachePrefix(prefix: string): Promise<void> {
  return invalidateRedisCachePattern(`${prefix}*`);
}
