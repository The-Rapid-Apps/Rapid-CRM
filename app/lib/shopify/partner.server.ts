import type {
  App,
  ShopifyPartnerConnection,
} from "../../../generated/prisma/client";
import { decryptCredential } from "../credential-encryption.server";
import { env } from "../env.server";
import { logger } from "../logger.server";
import { isRedisAvailable, redis } from "../redis.server";

const log = logger.scope("shopify-partner");

// Partner API version. Kept in step with the Admin API version.
const PARTNER_API_VERSION = "2026-07";

type PartnerConnectionFields = Pick<
  ShopifyPartnerConnection,
  "partnerOrganizationId" | "encryptedAccessToken"
>;

export type PartnerApp = Pick<
  App,
  | "id"
  | "partnerApiToken"
  | "partnerOrganizationId"
  | "shopifyAppId"
  | "disableDowngradeCredits"
> & {
  partnerConnection?: PartnerConnectionFields | null;
};

export interface PartnerCredentials {
  partnerApiToken: string;
  partnerOrganizationId: string;
}

/**
 * Resolve the reusable Partner connection first, with the old per-app fields
 * retained only as a rollout fallback. A corrupt encrypted token fails closed.
 */
export function effectivePartnerCredentials(
  app: Pick<PartnerApp, "partnerApiToken" | "partnerOrganizationId"> & {
    partnerConnection?: PartnerConnectionFields | null;
  },
): PartnerCredentials | null {
  if (app.partnerConnection) {
    try {
      const partnerApiToken = decryptCredential(
        app.partnerConnection.encryptedAccessToken,
      );
      if (partnerApiToken && app.partnerConnection.partnerOrganizationId) {
        return {
          partnerApiToken,
          partnerOrganizationId: app.partnerConnection.partnerOrganizationId,
        };
      }
    } catch {
      return null;
    }
  }

  if (app.partnerApiToken && app.partnerOrganizationId) {
    return {
      partnerApiToken: app.partnerApiToken,
      partnerOrganizationId: app.partnerOrganizationId,
    };
  }
  return null;
}

/** Credentials shared by every Partner API credit path. */
export function isPartnerApiConfigured(app: PartnerApp): boolean {
  return (
    env.FLEX_PARTNER_CREDITS_ENABLED &&
    Boolean(effectivePartnerCredentials(app)) &&
    Boolean(app.shopifyAppId)
  );
}

export function partnerApiConfigurationIssue(app: PartnerApp): string | null {
  if (!env.FLEX_PARTNER_CREDITS_ENABLED) {
    return "FLEX_PARTNER_CREDITS_ENABLED is false";
  }
  if (!effectivePartnerCredentials(app)) {
    return "a working Shopify Partner connection is missing";
  }
  if (!app.shopifyAppId) return "app.shopifyAppId is missing";
  return null;
}

/**
 * Downgrade-credit policy adds the per-app opt-out on top of the common
 * Partner API configuration. APP_CREDITS discounts use the common
 * configuration directly and are not disabled by this downgrade-only switch.
 */
export function isPartnerApiEnabled(app: PartnerApp): boolean {
  return isPartnerApiConfigured(app) && !app.disableDowngradeCredits;
}

/** Human-readable reason the Partner API is unavailable, or null if it's ready. */
export function partnerApiUnavailableReason(app: PartnerApp): string | null {
  const configurationIssue = partnerApiConfigurationIssue(app);
  if (configurationIssue) return configurationIssue;
  if (app.disableDowngradeCredits) return "app.disableDowngradeCredits is true";
  return null;
}

interface PartnerResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const MAX_RATE_LIMIT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 2000;
// Keep deliberate headroom below Shopify's four-per-second ceiling. Financial
// transaction queries are also throttled more aggressively in practice, and a
// second local dev process may briefly share the same client.
const PARTNER_REQUEST_INTERVAL_MS = 500;
// `fetch` has no built-in timeout — an outbound call that never resolves (a
// sustained rate-limit hold, a network hiccup) would otherwise hang the
// request forever with zero visible symptoms.
const REQUEST_TIMEOUT_MS = 20_000;

/** Accept either Shopify's numeric shop id or its Partner API GID. */
export function partnerShopGid(shopPlatformId: string): string {
  if (/^gid:\/\/partners\/Shop\/\d+$/.test(shopPlatformId)) {
    return shopPlatformId;
  }
  if (/^\d+$/.test(shopPlatformId)) {
    return `gid://partners/Shop/${shopPlatformId}`;
  }
  throw new Error("Partner shop id must be numeric or a partners Shop GID");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shopify allows four Partner API requests per second per API client. Apps in
// the same organization usually share one client, so app-level Promise.all
// calls — and, in PM2 cluster mode, every worker process — must coordinate
// instead of independently bursting into 429 responses. Cluster mode is why
// this can no longer be a plain in-process Map: each worker would pace itself
// to the full interval independently, letting N workers together burst to ~N x
// Shopify's actual per-client ceiling (see `instances` in
// ecosystem.config.cjs).
const nextPartnerRequestAt = new Map<string, number>();

// Read-then-write the reservation in one Lua round trip. A plain GET-then-SET
// from Node would race exactly like the in-process Map does across workers —
// two workers could both read the same "current" value before either writes
// their reservation back.
redis.defineCommand("reservePartnerRequestSlot", {
  numberOfKeys: 1,
  lua: `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local interval = tonumber(ARGV[2])
    local current = tonumber(redis.call("GET", key))
    local scheduled = now
    if current and current > now then
      scheduled = current
    end
    local nextSlot = scheduled + interval
    redis.call("SET", key, nextSlot, "PX", interval * 4)
    return scheduled
  `,
});

interface PartnerRateLimiterRedis {
  reservePartnerRequestSlot(
    key: string,
    now: number,
    interval: number,
  ): Promise<number>;
}

let warnedRedisRateLimiterFallback = false;

async function waitForPartnerRequestSlot(
  credentials: PartnerCredentials,
): Promise<void> {
  const key = credentials.partnerOrganizationId;
  const now = Date.now();

  if (isRedisAvailable()) {
    try {
      const scheduledAt = await (
        redis as unknown as PartnerRateLimiterRedis
      ).reservePartnerRequestSlot(
        `partner-rate:${key}`,
        now,
        PARTNER_REQUEST_INTERVAL_MS,
      );
      if (scheduledAt > now) await sleep(scheduledAt - now);
      return;
    } catch (error) {
      // Fall through to the in-process pacing below — a single worker pacing
      // itself to the full interval is the known, already-tolerated behavior
      // this whole migration exists to improve on, not a new failure mode.
      if (!warnedRedisRateLimiterFallback) {
        warnedRedisRateLimiterFallback = true;
        log.warn("Partner rate limiter: Redis reservation failed, falling back to in-process pacing", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const scheduledAt = Math.max(now, nextPartnerRequestAt.get(key) ?? now);
  nextPartnerRequestAt.set(key, scheduledAt + PARTNER_REQUEST_INTERVAL_MS);
  if (scheduledAt > now) await sleep(scheduledAt - now);
}

/**
 * Raw Partner API GraphQL call given credentials directly — no feature gate.
 * Used by both the (gated) downgrade-credit path below and other Partner API
 * consumers (e.g. the account-lifecycle events poller) that have their own,
 * independent readiness check.
 *
 * Retries on 429 with exponential backoff (honoring `Retry-After` when
 * present) — a first-time sync with no lower time bound can page through an
 * app's whole history in a tight loop, which is exactly the shape of request
 * that trips Shopify's Partner API rate limit.
 */
async function partnerGraphqlRaw<T>(
  credentials: PartnerCredentials,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const url = `https://partners.shopify.com/${credentials.partnerOrganizationId}/api/${PARTNER_API_VERSION}/graphql.json`;

  for (let attempt = 0; ; attempt++) {
    await waitForPartnerRequestSlot(credentials);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": credentials.partnerApiToken as string,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        log.error("Partner API request timed out", {
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        throw new Error(
          `Partner API request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
      log.warn("Partner API rate limited — backing off", {
        attempt: attempt + 1,
        retryAfterMs,
      });
      await sleep(retryAfterMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      log.error("Partner API HTTP error", { status: res.status, body });
      throw new Error(`Partner API HTTP ${res.status}`);
    }

    const json = (await res.json()) as PartnerResponse<T>;
    if (json.errors?.length) {
      log.error("Partner API returned errors", { errors: json.errors });
      throw new Error(
        `Partner API error: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return json.data as T;
  }
}

/**
 * Execute a Partner API GraphQL operation for the (gated) downgrade-credit
 * path. The Partner API is a distinct endpoint from the shop Admin API,
 * authenticated with a Partner access token.
 */
export async function partnerGraphql<T>(
  app: PartnerApp,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const reason = partnerApiConfigurationIssue(app);
  if (reason) {
    throw new Error(`Partner API not available: ${reason}`);
  }
  return partnerGraphqlRaw<T>(
    effectivePartnerCredentials(app) as PartnerCredentials,
    query,
    variables,
  );
}

/** Whether an app has Partner API credentials at all, independent of the
 * Flex-specific downgrade-credit gate above (used by the account-lifecycle
 * events poller, which has nothing to do with downgrade credits). */
export function hasPartnerApiCredentials(
  app: Partial<PartnerCredentials>,
): app is PartnerCredentials {
  return Boolean(app.partnerApiToken && app.partnerOrganizationId);
}

/** Raw Partner API GraphQL call gated only on credential presence. */
export async function partnerGraphqlWithCredentials<T>(
  app: PartnerCredentials,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!hasPartnerApiCredentials(app)) {
    throw new Error(
      "Partner API not available: missing token or organization id",
    );
  }
  return partnerGraphqlRaw<T>(app, query, variables);
}
