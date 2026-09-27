import type {
  App,
  ShopifyPartnerConnection,
} from "../../../generated/prisma/client";
import {
  cachedWithRedis,
  createRedisSwrCache,
  peekCache,
} from "../cache/redis-cache.server";
import { logger } from "../logger.server";
import { isRedisAvailable, redis } from "../redis.server";
import type {
  AnalyticsReports,
  RecurringPoint,
  RevenuePoint,
  UtcBucket,
} from "../reports/analytics.server";
import { buildUtcBuckets } from "../reports/analytics.server";
import {
  effectivePartnerCredentials,
  partnerGraphqlWithCredentials,
} from "./partner.server";

const log = logger.scope("partner-analytics");

const APP_SUBSCRIPTION_SALES_QUERY = `
  query AppSubscriptionSales(
    $appId: ID!
    $after: String
    $createdAtMin: DateTime!
    $createdAtMax: DateTime!
  ) {
    transactions(
      first: 100
      after: $after
      appId: $appId
      createdAtMin: $createdAtMin
      createdAtMax: $createdAtMax
      types: [APP_SUBSCRIPTION_SALE, APP_USAGE_SALE]
    ) {
      edges {
        cursor
        node {
          id
          createdAt
          __typename
          ... on AppSubscriptionSale {
            billingInterval
            chargeId
            grossAmount {
              amount
              currencyCode
            }
            netAmount {
              amount
              currencyCode
            }
            shopifyFee {
              amount
              currencyCode
            }
            shop {
              id
              myshopifyDomain
            }
          }
          ... on AppUsageSale {
            chargeId
            grossAmount {
              amount
              currencyCode
            }
            netAmount {
              amount
              currencyCode
            }
            shopifyFee {
              amount
              currencyCode
            }
            shop {
              id
              myshopifyDomain
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const ANNUAL_SUBSCRIPTION_SALES_QUERY = `
  query AnnualSubscriptionSales(
    $appId: ID!
    $after: String
    $createdAtMin: DateTime!
    $createdAtMax: DateTime!
  ) {
    transactions(
      first: 100
      after: $after
      appId: $appId
      createdAtMin: $createdAtMin
      createdAtMax: $createdAtMax
      types: [APP_SUBSCRIPTION_SALE]
    ) {
      edges {
        cursor
        node {
          ... on AppSubscriptionSale {
            billingInterval
            grossAmount {
              amount
              currencyCode
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const DAY_MS = 86_400_000;
const MAX_PAGES_PER_APP = 500;
const MEMORY_CACHE_MS = 5 * 60_000;
const MEMORY_STALE_MS = 60 * 60_000;
const ANNUAL_CACHE_MS = 6 * 60 * 60_000;
const FAST_MRR_WINDOW_DAYS = 3;

type AppForPartnerAnalytics = Pick<
  App,
  "id" | "name" | "shopifyAppId" | "partnerApiToken" | "partnerOrganizationId"
> & {
  partnerConnection: Pick<
    ShopifyPartnerConnection,
    "partnerOrganizationId" | "encryptedAccessToken"
  > | null;
};

interface TransactionNode {
  id: string;
  createdAt: string;
  __typename: "AppSubscriptionSale" | "AppUsageSale";
  billingInterval?: "EVERY_30_DAYS" | "ANNUAL" | null;
  chargeId: string | null;
  grossAmount: { amount: string; currencyCode: string } | null;
  netAmount: { amount: string; currencyCode: string };
  shopifyFee: { amount: string; currencyCode: string } | null;
  shop: { id: string; myshopifyDomain: string } | null;
}

interface TransactionsResponse {
  transactions: {
    edges: Array<{ cursor: string; node: TransactionNode }>;
    pageInfo: { hasNextPage: boolean };
  };
}

interface PartnerTransaction extends TransactionNode {
  appId: string;
  appName: string;
}

const transactionCache = createRedisSwrCache<PartnerTransaction[]>(
  "partner-transactions:",
);
// Shape A, not Shape B — unlike transactionCache above, this has no
// stale-while-revalidate window, just a plain TTL + value (see the Redis
// migration plan for why the two caches in this file take different shapes).
const ANNUAL_MRR_KEY_PREFIX = "annual-mrr:";

// Fallback only, used when Redis is unreachable — see cacheGeneration below.
// The real, cross-worker-shared counters live in Redis (`gen:global`,
// `gen:app:{appId}`) as of the cluster-mode migration: this pair used to be
// the actual source of truth, but an in-process counter only invalidates the
// worker it bumped in, leaving the other N-1 workers serving stale MRR until
// their TTLs expire — the exact defect `ecosystem.config.cjs`'s cluster-mode
// warning comment calls out.
let globalCacheGenerationFallback = 0;
const appCacheGenerationsFallback = new Map<string, number>();
let warnedGenerationRedisFallback = false;

async function cacheGeneration(appId: string): Promise<string> {
  if (isRedisAvailable()) {
    try {
      const [global, app] = await Promise.all([
        redis.get("gen:global"),
        redis.get(`gen:app:${appId}`),
      ]);
      return `${global ?? "0"}.${app ?? "0"}`;
    } catch (error) {
      if (!warnedGenerationRedisFallback) {
        warnedGenerationRedisFallback = true;
        log.warn(
          "cache generation: Redis read failed, falling back to in-process counters",
          { message: error instanceof Error ? error.message : String(error) },
        );
      }
    }
  }
  return `${globalCacheGenerationFallback}.${appCacheGenerationsFallback.get(appId) ?? 0}`;
}

interface AnnualTransactionsResponse {
  transactions: {
    edges: Array<{
      cursor: string;
      node: {
        billingInterval: "EVERY_30_DAYS" | "ANNUAL" | null;
        grossAmount: { amount: string; currencyCode: string } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
}

export interface PartnerAnalyticsResult<
  TReports extends Pick<AnalyticsReports, "portfolio" | "revenue"> = Pick<
    AnalyticsReports,
    "portfolio" | "revenue"
  >,
> {
  reports: TReports;
  errors: Array<{ appId: string; appName: string; message: string }>;
  transactionCount: number;
  annualHistoryComplete: boolean;
  recentHistoryComplete: boolean;
  historySampled: boolean;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator, 6) : 0;
}

function inRange(value: Date, start: Date, end: Date): boolean {
  return value >= start && value < end;
}

function transactionMrrAt(
  transactions: PartnerTransaction[],
  currency: string,
  at: Date,
) {
  let mrr = 0;
  let monthlySubscriptions = 0;
  let annualSubscriptions = 0;
  let usageCharges = 0;
  const charges = new Set<string>();
  const shops = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.grossAmount?.currencyCode !== currency) continue;
    const occurredAt = new Date(transaction.createdAt);
    const lookbackDays =
      transaction.__typename === "AppUsageSale"
        ? 30
        : transaction.billingInterval === "ANNUAL"
          ? 365
          : transaction.billingInterval === "EVERY_30_DAYS"
            ? 30
            : 0;
    if (
      lookbackDays === 0 ||
      occurredAt > at ||
      occurredAt <= new Date(at.getTime() - lookbackDays * DAY_MS)
    ) {
      continue;
    }
    const gross = Number(transaction.grossAmount.amount);
    if (transaction.__typename === "AppUsageSale") {
      usageCharges += gross;
    } else if (transaction.billingInterval === "ANNUAL") {
      annualSubscriptions += gross / 12;
    } else {
      monthlySubscriptions += gross;
    }
    mrr = monthlySubscriptions + annualSubscriptions + usageCharges;
    if (transaction.__typename === "AppSubscriptionSale") {
      charges.add(transaction.chargeId ?? transaction.id);
      if (transaction.shop?.id) shops.add(transaction.shop.id);
    }
  }
  return {
    mrr: round(mrr),
    monthlySubscriptions: round(monthlySubscriptions),
    annualSubscriptions: round(annualSubscriptions),
    usageCharges: round(usageCharges),
    activeSubscriptions: charges.size,
    activeCustomers: shops.size,
  };
}

function estimatedMrrFromFastWindow(
  transactions: PartnerTransaction[],
  currency: string,
) {
  const scale = 30 / FAST_MRR_WINDOW_DAYS;
  let monthlySubscriptions = 0;
  let annualSales = 0;
  let usageCharges = 0;
  const charges = new Set<string>();
  const shops = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.grossAmount?.currencyCode !== currency) continue;
    const gross = Number(transaction.grossAmount.amount);
    if (transaction.__typename === "AppUsageSale") {
      usageCharges += gross;
    } else if (transaction.billingInterval === "ANNUAL") {
      annualSales += gross;
    } else {
      monthlySubscriptions += gross;
    }
    if (transaction.__typename === "AppSubscriptionSale") {
      charges.add(transaction.chargeId ?? transaction.id);
      if (transaction.shop?.id) shops.add(transaction.shop.id);
    }
  }
  monthlySubscriptions = round(monthlySubscriptions * scale);
  // Annual sales collected during a representative slice are already annual
  // contract values. Scaling that flow to 30 days estimates their monthly
  // recurring contribution; dividing by 12 again would understate it.
  const annualSubscriptions = round(annualSales * scale);
  usageCharges = round(usageCharges * scale);
  return {
    mrr: round(monthlySubscriptions + annualSubscriptions + usageCharges),
    monthlySubscriptions,
    annualSubscriptions,
    usageCharges,
    activeSubscriptions: Math.round(charges.size * scale),
    activeCustomers: Math.round(shops.size * scale),
  };
}

async function transactionCacheKey(
  appId: string,
  createdAtMin: Date,
  createdAtMax: Date,
): Promise<string> {
  return [
    appId,
    await cacheGeneration(appId),
    createdAtMin.toISOString().slice(0, 10),
    createdAtMax.toISOString().slice(0, 10),
  ].join(":");
}

async function fetchAppTransactionsFromShopify(
  app: AppForPartnerAnalytics,
  createdAtMin: Date,
  createdAtMax: Date,
  signal?: AbortSignal,
): Promise<PartnerTransaction[]> {
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    throw new Error("Partner connection or Shopify App ID is missing.");
  }

  const transactions: PartnerTransaction[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES_PER_APP; page += 1) {
    if (signal?.aborted) {
      throw new DOMException("Partner history request canceled", "AbortError");
    }
    const data: TransactionsResponse =
      await partnerGraphqlWithCredentials<TransactionsResponse>(
        credentials,
        APP_SUBSCRIPTION_SALES_QUERY,
        {
          appId: app.shopifyAppId,
          after,
          createdAtMin: createdAtMin.toISOString(),
          createdAtMax: createdAtMax.toISOString(),
        },
      );
    const edges = data.transactions.edges;
    transactions.push(
      ...edges.map(({ node }) => ({
        ...node,
        appId: app.id,
        appName: app.name,
      })),
    );
    if (!data.transactions.pageInfo.hasNextPage) {
      return transactions;
    }
    const next = edges.at(-1)?.cursor;
    if (!next || next === after) {
      throw new Error("Shopify returned an invalid transaction cursor.");
    }
    after = next;
  }
  throw new Error("Shopify transaction history exceeded the safety limit.");
}

async function fetchAppTransactions(
  app: AppForPartnerAnalytics,
  createdAtMin: Date,
  createdAtMax: Date,
  signal?: AbortSignal,
): Promise<PartnerTransaction[]> {
  const cacheKey = await transactionCacheKey(app.id, createdAtMin, createdAtMax);
  const { value } = await transactionCache.fetchOrRefresh(
    cacheKey,
    MEMORY_CACHE_MS,
    MEMORY_STALE_MS,
    () => fetchAppTransactionsFromShopify(app, createdAtMin, createdAtMax, signal),
  );
  return value;
}

async function cachedAppTransactions(
  app: AppForPartnerAnalytics,
  createdAtMin: Date,
  createdAtMax: Date,
): Promise<PartnerTransaction[] | null> {
  const cacheKey = await transactionCacheKey(app.id, createdAtMin, createdAtMax);
  return transactionCache.peek(cacheKey);
}

async function fetchAnnualChunk(
  app: AppForPartnerAnalytics,
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const credentials = effectivePartnerCredentials(app);
  if (!credentials || !app.shopifyAppId) {
    throw new Error("Partner connection or Shopify App ID is missing.");
  }
  const currencies = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES_PER_APP; page += 1) {
    const data: AnnualTransactionsResponse =
      await partnerGraphqlWithCredentials<AnnualTransactionsResponse>(
        credentials,
        ANNUAL_SUBSCRIPTION_SALES_QUERY,
        {
          appId: app.shopifyAppId,
          after,
          createdAtMin: start.toISOString(),
          createdAtMax: end.toISOString(),
        },
      );
    for (const { node } of data.transactions.edges) {
      if (
        node.billingInterval !== "ANNUAL" ||
        !node.grossAmount?.currencyCode
      ) {
        continue;
      }
      const currency = node.grossAmount.currencyCode;
      currencies.set(
        currency,
        (currencies.get(currency) ?? 0) + Number(node.grossAmount.amount) / 12,
      );
    }
    if (!data.transactions.pageInfo.hasNextPage) return currencies;
    const next: string | undefined = data.transactions.edges.at(-1)?.cursor;
    if (!next || next === after) {
      throw new Error("Shopify returned an invalid annual-sales cursor.");
    }
    after = next;
  }
  throw new Error("Shopify annual history exceeded the safety limit.");
}

async function fetchAnnualMrrFromShopify(
  app: AppForPartnerAnalytics,
  end: Date,
): Promise<Map<string, number>> {
  const start = new Date(end.getTime() - 365 * DAY_MS);
  const chunks: Array<{ start: Date; end: Date }> = [];
  for (let cursor = start; cursor < end;) {
    const chunkEnd = new Date(
      Math.min(end.getTime(), cursor.getTime() + 30 * DAY_MS),
    );
    chunks.push({ start: new Date(cursor), end: chunkEnd });
    cursor = chunkEnd;
  }
  const currencies = new Map<string, number>();
  // Two time slices in flight keeps the cold load bounded without triggering
  // the Partner API's aggressive financial-query throttle.
  for (let index = 0; index < chunks.length; index += 2) {
    const results = await Promise.all(
      chunks
        .slice(index, index + 2)
        .map((chunk) => fetchAnnualChunk(app, chunk.start, chunk.end)),
    );
    for (const result of results) {
      for (const [currency, amount] of result) {
        currencies.set(currency, (currencies.get(currency) ?? 0) + amount);
      }
    }
  }
  return currencies;
}

async function annualMrrCacheKey(
  app: AppForPartnerAnalytics,
  end: Date,
): Promise<string> {
  return `${ANNUAL_MRR_KEY_PREFIX}${app.id}:${await cacheGeneration(app.id)}:${end.toISOString().slice(0, 10)}`;
}

async function fetchAnnualMrr(
  app: AppForPartnerAnalytics,
  end: Date,
): Promise<Map<string, number>> {
  const key = await annualMrrCacheKey(app, end);
  return cachedWithRedis(key, ANNUAL_CACHE_MS, () =>
    fetchAnnualMrrFromShopify(app, end),
  );
}

async function cachedAnnualMrr(
  app: AppForPartnerAnalytics,
  end: Date,
): Promise<Map<string, number> | null> {
  const key = await annualMrrCacheKey(app, end);
  return peekCache<Map<string, number>>(key);
}

/**
 * Drops only ephemeral Shopify analytics snapshots. The next metrics read
 * repopulates them from read-only Partner API queries; no database rows are
 * created or changed.
 *
 * Bumping the generation counter(s) is enough — `transactionCacheKey`/
 * `annualMrrCacheKey` both bake the current generation into the Redis key
 * they mint, so a bump makes every existing entry unreachable (a new read
 * mints a new key under the new generation) without needing to actively
 * delete the old ones; they simply age out via their own `PX` TTL, the same
 * way `recurring:*`'s `syncStamp`-keyed entries already do.
 */
export async function invalidateLivePartnerAnalyticsCache(
  appIds?: string[],
): Promise<void> {
  const selected = appIds ? new Set(appIds) : null;
  if (isRedisAvailable()) {
    try {
      if (selected) {
        await Promise.all(
          [...selected].map((appId) => redis.incr(`gen:app:${appId}`)),
        );
      } else {
        await redis.incr("gen:global");
      }
    } catch (error) {
      log.warn("cache generation: Redis INCR failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Always also bump the fallback counters: if Redis goes down *after* this
  // point, `cacheGeneration` still invalidates correctly (just per-process
  // again, not cross-worker) instead of serving this now-stale generation.
  if (selected) {
    for (const appId of selected) {
      appCacheGenerationsFallback.set(
        appId,
        (appCacheGenerationsFallback.get(appId) ?? 0) + 1,
      );
    }
  } else {
    globalCacheGenerationFallback += 1;
  }
}

/**
 * Fetch subscription sales directly from Shopify Partner API and overlay the
 * report values in memory. No transaction or calculated metric is persisted.
 *
 * MRR is the trailing 30-day gross value for EVERY_30_DAYS subscriptions and
 * usage charges, plus one twelfth of ANNUAL subscription transactions returned
 * by the live query. This matches Mantle's default includeAnnual/includeUsage.
 */
export async function applyLivePartnerAnalytics<
  TReports extends Pick<AnalyticsReports, "portfolio" | "revenue">,
>(
  reports: TReports,
  apps: AppForPartnerAnalytics[],
  options: {
    fastMrr?: boolean;
    sampledHistory?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<PartnerAnalyticsResult<TReports>> {
  const start = new Date(reports.portfolio.periodStart);
  const end = new Date(reports.portfolio.periodEnd);
  // A 30-day leading window is sufficient for the EVERY_30_DAYS stock
  // reconstruction and keeps the live request inside Partner API rate limits.
  // Annual transactions seen in the requested window are normalized, but an
  // annual contract billed before the leading window cannot be discovered
  // without persisting a mirror or querying every shop individually.
  const lookbackStart = new Date(start.getTime() - 30 * DAY_MS);
  const fastStart = new Date(end.getTime() - FAST_MRR_WINDOW_DAYS * DAY_MS);
  const settled = await Promise.all(
    apps.map(async (app) => {
      try {
        const cachedTransactions = options.fastMrr
          ? await cachedAppTransactions(app, lookbackStart, end)
          : null;
        if (cachedTransactions) {
          return {
            app,
            transactions: cachedTransactions,
            recentHistoryComplete: true,
            error: null,
          };
        }
        const transactions = await fetchAppTransactions(
          app,
          options.fastMrr ? fastStart : lookbackStart,
          end,
          options.signal,
        );
        return {
          app,
          transactions,
          recentHistoryComplete: !options.fastMrr,
          error: null,
        };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return {
          app,
          transactions: [] as PartnerTransaction[],
          recentHistoryComplete: false,
          error: {
            appId: app.id,
            appName: app.name,
            message:
              "Shopify financials could not be loaded. Grant View financials to this Partner API client.",
          },
        };
      }
    }),
  );
  const transactions = settled.flatMap((result) => result.transactions);
  const recentHistoryComplete = settled.every(
    (result) => !result.error && result.recentHistoryComplete,
  );
  const errors = settled.flatMap((result) =>
    result.error ? [result.error] : [],
  );
  const annualByCurrency = new Map<string, number>();
  let annualHistoryComplete = true;
  for (const result of settled) {
    if (result.error) {
      annualHistoryComplete = false;
      continue;
    }
    const appAnnual = await cachedAnnualMrr(result.app, end);
    if (appAnnual) {
      for (const [currency, amount] of appAnnual) {
        annualByCurrency.set(
          currency,
          (annualByCurrency.get(currency) ?? 0) + amount,
        );
      }
    } else {
      annualHistoryComplete = false;
      // Warm the expensive trailing-year scan without holding the HTTP response
      // open. Single-flight caching prevents refreshes from duplicating it.
      if (!options.fastMrr || result.recentHistoryComplete) {
        void fetchAnnualMrr(result.app, end).catch(() => undefined);
      }
    }
  }

  const localRecurringByCurrency = new Map(
    reports.portfolio.recurring.currencies.map((currency) => [
      currency.currency,
      currency,
    ]),
  );
  const localRecurringPoints = new Map(
    reports.portfolio.recurring.timeSeries.map((point) => [
      `${point.currency}:${point.periodStart}:${point.periodEnd}`,
      point,
    ]),
  );
  const buckets: UtcBucket[] = buildUtcBuckets({
    start,
    end,
    interval: reports.portfolio.interval,
  });
  const sampledTransactions = new Map<string, PartnerTransaction[]>();
  if (options.sampledHistory && buckets.length <= 12) {
    for (const bucket of buckets) {
      if (options.signal?.aborted) break;
      const sampleEnd = bucket.end;
      const sampleStart = new Date(
        sampleEnd.getTime() - FAST_MRR_WINDOW_DAYS * DAY_MS,
      );
      const rows = await Promise.all(
        apps.map(async (app) => {
          try {
            return await fetchAppTransactions(
              app,
              sampleStart,
              sampleEnd,
              options.signal,
            );
          } catch (error) {
            if (options.signal?.aborted) throw error;
            return [] as PartnerTransaction[];
          }
        }),
      );
      sampledTransactions.set(bucket.start.toISOString(), rows.flat());
    }
  }
  const currencies = [
    ...new Set([
      ...transactions.flatMap((transaction) =>
        transaction.grossAmount?.currencyCode
          ? [transaction.grossAmount.currencyCode]
          : [],
      ),
      ...[...sampledTransactions.values()].flatMap((rows) =>
        rows.flatMap((transaction) =>
          transaction.grossAmount?.currencyCode
            ? [transaction.grossAmount.currencyCode]
            : [],
        ),
      ),
      ...annualByCurrency.keys(),
      ...localRecurringByCurrency.keys(),
    ]),
  ].sort();
  if (currencies.length === 0) {
    return {
      reports,
      errors,
      transactionCount: 0,
      annualHistoryComplete,
      recentHistoryComplete,
      historySampled: sampledTransactions.size > 1,
    };
  }
  let recurringTimeSeries: RecurringPoint[] =
    recentHistoryComplete || sampledTransactions.size > 1
      ? buckets.flatMap((bucket) => {
          const at = new Date(bucket.end.getTime() - 1);
          const bucketTransactions =
            sampledTransactions.get(bucket.start.toISOString()) ?? transactions;
          return currencies.map((currency) => {
            const current = recentHistoryComplete
              ? transactionMrrAt(bucketTransactions, currency, at)
              : estimatedMrrFromFastWindow(bucketTransactions, currency);
            const localPoint = localRecurringPoints.get(
              `${currency}:${bucket.start.toISOString()}:${bucket.end.toISOString()}`,
            );
            return {
              periodStart: bucket.start.toISOString(),
              periodEnd: bucket.end.toISOString(),
              currency,
              monthlySubscriptions: current.monthlySubscriptions,
              annualSubscriptions: current.annualSubscriptions,
              usageCharges: current.usageCharges,
              trialSubscriptions: localPoint?.trialSubscriptions ?? 0,
              mrr: current.mrr,
              arr: round(current.mrr * 12),
              activeSubscriptions: current.activeSubscriptions,
              activeCustomers: current.activeCustomers,
              provisional: bucket.provisional,
            };
          });
        })
      : [];
  const currentAt = new Date(end.getTime() - 1);
  const recurringCurrencies = currencies.map((currency) => {
    const transactionCurrent = recentHistoryComplete
      ? transactionMrrAt(transactions, currency, currentAt)
      : estimatedMrrFromFastWindow(
          transactions.filter(
            (transaction) => new Date(transaction.createdAt) >= fastStart,
          ),
          currency,
        );
    const starting = recentHistoryComplete
      ? transactionMrrAt(transactions, currency, start)
      : transactionCurrent;
    const monthlySubscriptions = transactionCurrent.monthlySubscriptions;
    const localAnnual =
      localRecurringByCurrency.get(currency)?.annualSubscriptions ?? 0;
    const annualSubscriptions = annualHistoryComplete
      ? round(annualByCurrency.get(currency) ?? 0)
      : round(Math.max(localAnnual, transactionCurrent.annualSubscriptions));
    const usageCharges = transactionCurrent.usageCharges;
    const trialSubscriptions =
      localRecurringByCurrency.get(currency)?.trialSubscriptions ?? 0;
    const currentMrr = round(
      monthlySubscriptions + annualSubscriptions + usageCharges,
    );
    return {
      currency,
      mrr: currentMrr,
      arr: round(currentMrr * 12),
      monthlySubscriptions,
      annualSubscriptions,
      usageCharges,
      trialSubscriptions,
      startingMrr: starting.mrr,
      netMrrGrowth: round(currentMrr - starting.mrr),
      growthRate: rate(currentMrr - starting.mrr, starting.mrr),
      activeSubscriptions: transactionCurrent.activeSubscriptions,
      activeCustomers: transactionCurrent.activeCustomers,
    };
  });
  if (!recentHistoryComplete && sampledTransactions.size <= 1) {
    const latestBucket = buckets.at(-1);
    if (latestBucket) {
      recurringTimeSeries = recurringCurrencies.map((currency) => ({
        periodStart: latestBucket.start.toISOString(),
        periodEnd: latestBucket.end.toISOString(),
        currency: currency.currency,
        monthlySubscriptions: currency.monthlySubscriptions,
        annualSubscriptions: currency.annualSubscriptions,
        usageCharges: currency.usageCharges,
        trialSubscriptions: currency.trialSubscriptions,
        mrr: currency.mrr,
        arr: currency.arr,
        activeSubscriptions: currency.activeSubscriptions,
        activeCustomers: currency.activeCustomers,
        provisional: true,
      }));
    }
  }
  for (const currency of recurringCurrencies) {
    const latest = recurringTimeSeries
      .filter((point) => point.currency === currency.currency)
      .at(-1);
    if (latest) {
      latest.mrr = currency.mrr;
      latest.arr = currency.arr;
      latest.monthlySubscriptions = currency.monthlySubscriptions;
      latest.annualSubscriptions = currency.annualSubscriptions;
      latest.usageCharges = currency.usageCharges;
      latest.trialSubscriptions = currency.trialSubscriptions;
      latest.activeSubscriptions = currency.activeSubscriptions;
      latest.activeCustomers = currency.activeCustomers;
    }
  }

  const periodTransactions = transactions.filter((transaction) =>
    inRange(new Date(transaction.createdAt), start, end),
  );
  const revenueCurrencies = currencies.map((currency) => {
    const timeSeries = buckets.map((bucket): RevenuePoint => {
      const rows = periodTransactions.filter(
        (transaction) =>
          transaction.grossAmount?.currencyCode === currency &&
          inRange(new Date(transaction.createdAt), bucket.start, bucket.end),
      );
      const gross = rows.reduce(
        (sum, transaction) =>
          sum + Number(transaction.grossAmount?.amount ?? 0),
        0,
      );
      const net = rows.reduce(
        (sum, transaction) => sum + Number(transaction.netAmount.amount),
        0,
      );
      return {
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        gross: round(gross),
        credits: 0,
        net: round(net),
        provisional: bucket.provisional,
      };
    });
    return {
      currency,
      value: {
        gross: round(timeSeries.reduce((sum, point) => sum + point.gross, 0)),
        credits: 0,
        net: round(timeSeries.reduce((sum, point) => sum + point.net, 0)),
      },
      timeSeries,
    };
  });

  reports.portfolio.recurring = {
    currencies: recurringCurrencies,
    timeSeries: recurringTimeSeries,
  };
  reports.portfolio.forecast = recurringCurrencies.map((currency) => ({
    currency: currency.currency,
    monthlyRunRate: currency.mrr,
    annualRunRate: currency.arr,
  }));
  reports.portfolio.sourceCoverage.subscriptions = recurringCurrencies.reduce(
    (sum, currency) => sum + currency.activeSubscriptions,
    0,
  );
  reports.portfolio.sourceCoverage.successfulCharges =
    periodTransactions.length;
  reports.portfolio.sourceCoverage.notes = [
    "Recurring and revenue values are fetched live from Shopify Partner transactions and calculated in backend memory only.",
    annualHistoryComplete
      ? "Mantle-aligned MRR includes the cached trailing-365-day annual subscription history divided by 12."
      : "Recent monthly MRR is ready; trailing-365-day annual history is warming in the background and will appear on refresh.",
    recentHistoryComplete
      ? "The exact recent transaction window is loaded."
      : "A three-day run-rate estimate is shown immediately while the exact recent transaction window warms in the background.",
    ...reports.portfolio.sourceCoverage.notes.filter(
      (note) => !note.startsWith("MRR uses"),
    ),
  ];
  reports.revenue = {
    ...reports.revenue,
    currencies: revenueCurrencies,
  };

  return {
    reports,
    errors,
    transactionCount: transactions.length,
    annualHistoryComplete,
    recentHistoryComplete,
    historySampled: sampledTransactions.size > 1,
  };
}
