import { BigQuery } from "@google-cloud/bigquery";
import { Prisma, type AccountLifecycleEventType } from "../../../generated/prisma/client";
import { cachedWithRedis } from "../cache/redis-cache.server";
import { prisma } from "../db.server";
import { env } from "../env.server";
import { redis } from "../redis.server";
import {
  buildChurnEvidenceIndex,
  buildFirstPaidContributionIndex,
  clockTransitionBillingOnWindows,
  contributionsAt,
  derivedFunnelEventsForShop,
  historiesFromFacts,
  loadLiveDiscountChecks,
  resolveOfferCadencePins,
  subscriptionChurnAt,
  type ChargeHistory,
  type DerivedFunnelKind,
} from "../shopify/partner-mrr.server";
import {
  buildUtcBuckets,
  type ResolvedAnalyticsRange,
} from "./analytics.server";
import {
  DEFAULT_FUNNEL_EVENTS,
  DEFAULT_PIVOT_DIMENSIONS,
  type FunnelEventKey,
  INSIGHT_DIMENSIONS,
  INSIGHT_UNSET_VALUES,
  type InsightDimensionKey,
  type InsightEventKey,
  type InsightMetricKey,
  PIVOT_DIMENSIONS,
  SHOPLESS_INSIGHT_EVENTS,
  type PivotDimensionKey,
  UNKNOWN_SHOP_DIMENSION_VALUE,
} from "./traffic-sources.shared";
import { resolveAllDimensions, resolveDimensionValue } from "./traffic-dimensions.local";
import {
  customerValue,
  summarizeMetric,
  type CustomerRevenue,
} from "./insight-metrics";

/** Revenue here comes from Partner subscription data,
 * which bills exclusively in USD (verified against live data 2026-08-04) — no
 * multi-currency normalization needed yet. Revisit if a second app/currency
 * is ever added. */
const MRR_CURRENCY = "USD";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * GA4 event mapping confirmed against live data (2026-07-25):
 * `view_item` fires on the apps.shopify.com listing page (page_location);
 * `shopify_app_install` carries a real shop_id/shop_url/shop_name and is the
 * genuine install signal. `installs` is a client-side listing-page event with
 * no shop identity — not a real install, but a real "Add app" click signal.
 */
const GA4_EVENT_BY_FUNNEL: Partial<Record<FunnelEventKey, string>> = {
  listing_view: "view_item",
  add_app_click: "installs",
  installed: "shopify_app_install",
};

/**
 * Uninstalled/Reinstalled aren't GA4 events — they come from our own
 * AccountLifecycleEvent table (the customer-events pipeline), joined back to
 * their acquisition traffic source by shop domain (AppInstall.shopDomain ==
 * GA4's shop_url param, both "acme.myshopify.com").
 */
const LIFECYCLE_TYPE_BY_FUNNEL: Partial<
  Record<FunnelEventKey, AccountLifecycleEventType>
> = {
  uninstalled: "UNINSTALLED",
  reinstalled: "REINSTALLED",
};

/**
 * Subscribed/Unsubscribed/Charge abandoned aren't GA4 events either — they
 * come from `PartnerSubscriptionEvent` (the same Partner API data already
 * powering MRR/CLV), joined back to traffic source the same way as lifecycle
 * events.
 *
 * Confirmed against live data (2026-08-07, re-confirmed 2026-09-10): the
 * Partner API only ever gives us
 * ACTIVATED/CANCELED/EXPIRED/FROZEN/DECLINED/UNFROZEN — no distinct trial
 * event and no signal for upgrade/downgrade direction. That is still true, but
 * it no longer makes those funnel events impossible: the MRR fold derives
 * exactly those transitions from how a charge's value changes over time, so
 * trial_started, trial_converted, upgraded, downgraded and resubscribed are
 * served from `DERIVED_FUNNEL_KINDS` below instead of from a feed event.
 */
const PARTNER_EVENT_TYPES_BY_FUNNEL: Partial<Record<FunnelEventKey, string[]>> =
  {
    subscribed: ["SUBSCRIPTION_CHARGE_ACTIVATED"],
    unsubscribed: ["SUBSCRIPTION_CHARGE_CANCELED", "SUBSCRIPTION_CHARGE_EXPIRED"],
    /* Shopify's DECLINED is a charge the merchant was shown and did not
       accept — an approval that went nowhere, which is what "Charge
       abandoned" counts. It is a real event in the feed,
       not a derivation. If Mantle turns out to also count charges that simply
       expired unapproved, that is a second type to add here, not a different
       mechanism. */
    charge_abandoned: ["SUBSCRIPTION_CHARGE_DECLINED"],
  };

/**
 * Funnel events with no Shopify event behind them at all — derived from how a
 * charge's value changes over time by `derivedFunnelEventsForShop`. The keys
 * match `DerivedFunnelKind` one-for-one, so this doubles as the "is this
 * funnel derived?" test.
 */
const DERIVED_FUNNEL_KINDS: Partial<Record<FunnelEventKey, DerivedFunnelKind>> = {
  trial_started: "trial_started",
  trial_converted: "trial_converted",
  upgraded: "upgraded",
  downgraded: "downgraded",
  resubscribed: "resubscribed",
};

/**
 * How far back to look for a shop's ORIGINAL acquisition event when
 * attributing an in-period uninstall/reinstall. A shop's install can predate
 * the report's own date range, so this is queried unbounded by the report
 * period — just capped here so the scan doesn't cover this GA4 property's
 * entire ~3-year history on every request.
 */
const SHOP_ATTRIBUTION_LOOKBACK_DAYS = 400;
/**
 * Lookback for `resolvePageViewOnlyDimensions`'s per-visitor `view_item`
 * join — deliberately much shorter than `SHOP_ATTRIBUTION_LOOKBACK_DAYS`.
 * That 400-day window is fine for lifecycle events (a small, bounded list of
 * uninstalls/reinstalls), but this join runs on every report request that
 * has the "Installed" funnel plus a page-view-only dimension active, and a
 * full 400-day `view_item` scan measured ~14s for just 2 visitors. Almost
 * every install follows its listing-page view within the same session or a
 * few days later (confirmed against live data 2026-08-07); a visitor whose
 * view falls outside this window still resolves to "(not set)", same as
 * before this fix existed, just for a narrower slice of cases.
 */
const INSTALL_ATTRIBUTION_LOOKBACK_DAYS = 60;

const DEFAULT_PAGE_SIZE = 15;

export interface TrendBucket {
  periodStart: string;
  periodEnd: string;
}

export interface TrafficSourceRow {
  dimensions: Record<PivotDimensionKey, string>;
  funnel: Partial<Record<FunnelEventKey, number>>;
  /**
   * Per-bucket counts aligned index-for-index with the report's
   * `trendBuckets` — one array per funnel event, scoped to just this row
   * (matches Mantle: each funnel-event chart plots one line per table row).
   */
  trend: Partial<Record<FunnelEventKey, number[]>>;
  /**
   * This row's funnel totals during the "Compare to" period, matched by the
   * same dimension-value combination. Only present when a compare period is
   * active; empty object (not undefined) when this row simply has no data in
   * the compare period.
   */
  compare?: Partial<Record<FunnelEventKey, number>>;
  /** Current MRR (sum of active-subscription contributions) for shops whose
   * install is attributed to this row. `null` while unavailable (BigQuery/DB
   * unreachable) — distinct from a real `0`. */
  mrr: number | null;
  /** ARPU(row) ÷ rolling 30-day paid-subscription churn(row); `null` when
   * churn is zero (guarded per the LTV formula — never shown as $0 or ∞). */
  clv: number | null;
}

/** Selected values per dimension, e.g. `{ source: ["shopify", "google"] }`. An
 * absent or empty array means "no filter" for that dimension. */
export type DimensionFilters = Partial<Record<PivotDimensionKey, string[]>>;

export interface TrafficSourcesReport {
  available: boolean;
  error?: string;
  periodStart: string;
  periodEnd: string;
  dimensions: PivotDimensionKey[];
  funnelEvents: FunnelEventKey[];
  filters: DimensionFilters;
  /**
   * Every distinct value seen for each active dimension, computed from the
   * FULL unfiltered result set (not just the current page) so the filter
   * picker always offers the complete option list, ranked by the same total
   * used to sort the table (busiest values first, matching Mantle).
   */
  availableValues: Partial<Record<PivotDimensionKey, string[]>>;
  rows: TrafficSourceRow[];
  totals: Partial<Record<FunnelEventKey, number>>;
  /**
   * Per-bucket counts aligned index-for-index with `trendBuckets`, summed
   * across EVERY filtered row (not just the current page) — the data
   * behind the one combined trend chart above the table. Computed from
   * `filteredRows`, the same full set `totals` sums, so it never
   * undercounts the way summing only `rows` (paginated) would.
   */
  totalsTrend: Partial<Record<FunnelEventKey, number[]>>;
  trendBuckets: TrendBucket[];
  page: number;
  totalPages: number;
  /** The resolved "Compare to" period, or null when no comparison is active. */
  compareRange: { start: string; end: string } | null;
  /**
   * Only set on the aggregated "All apps" report, and only when at least one
   * app's own report FAILED (a BigQuery error) while others succeeded. An app
   * that simply has no GA4 dataset configured is not an error and never lands
   * here — it has no data to contribute in the first place.
   *
   * The aggregate stays `available: true` in that case rather than failing
   * whole, because showing four apps' traffic beats showing none. But the
   * totals are then genuinely incomplete, so the panel says so instead of
   * presenting an understated number as the truth.
   */
  partialErrors?: string[];
}

interface RowAccumulator {
  dims: Record<PivotDimensionKey, string>;
  funnel: Partial<Record<FunnelEventKey, number>>;
  trend: Partial<Record<FunnelEventKey, number[]>>;
}

let client: BigQuery | undefined;
export function getClient(): BigQuery {
  client ??= new BigQuery({ projectId: env.GCP_PROJECT_ID });
  return client;
}

/**
 * Short-TTL cache for whole `getTrafficSourcesReport` responses, keyed by
 * every parameter that affects the result. A live BigQuery query here costs
 * ~6s even after the query-deduplication fix (2026-08-08) — two genuinely
 * sequential remote round-trips, not wasted work — so the only way to make a
 * *repeat* load of the same view fast is to not re-run it. GA4's own export
 * already lags real-time by minutes, so a few minutes of staleness here
 * costs nothing real. Redis-backed (Shape A, via `cachedWithRedis`) with a
 * same-worker in-flight promise on top, so two requests for the identical
 * view that land within milliseconds of each other (e.g. two people opening
 * the same report, on the same or different cluster workers) share one
 * BigQuery run instead of double-charging it. No manual entry cap needed —
 * unlike the old in-process Map, Redis's own `PX` TTL bounds memory
 * regardless of how many distinct (app, dimensions, funnels, filters, date
 * range, page) combinations accumulate.
 *
 * Widened from 2 to 5 minutes (2026-08-16, matching `partner-mrr.server.ts`'s
 * own cache TTL) — GA4's lag already exceeds 2 minutes in practice, so the
 * shorter window bought no real freshness, only more frequent cold hits (each
 * one a multi-second BigQuery round-trip a viewer sits through) every time
 * someone reopened a period they'd viewed 2-5 minutes earlier.
 */
const TRAFFIC_REPORT_CACHE_TTL_MS = 5 * 60_000;
// Bump the version suffix whenever TrafficSourcesReport's shape changes —
// otherwise a still-live Redis entry cached under the old shape (e.g.
// missing a newly added field) gets served as-is until its TTL expires,
// crashing any client code that assumes the new field exists.
const TRAFFIC_REPORT_CACHE_KEY_PREFIX = "traffic-report:v2:";

/**
 * How stale `trafficEventsSyncedAt` may be before the local `TrafficEventFact`
 * mirror is no longer trusted for reads and this falls back to the live
 * BigQuery path — see `localReadiness`'s doc comment in
 * `computeTrafficSourcesReport`. Generous on purpose: the only failure mode
 * this guards against is a genuinely stalled/broken sync, not routine
 * polling jitter between ticks (which run far more often than this in
 * practice).
 */
const TRAFFIC_LOCAL_STALENESS_TOLERANCE_MS = 20 * 60_000;

/**
 * Rounds a Date down to the cache's own TTL granularity for cache-KEY
 * purposes only (never used for the actual BigQuery query bounds). Relative
 * periods like "Last 30 days" resolve `end` to `new Date()` fresh on every
 * request — down to the millisecond — so keying on the exact timestamp
 * guaranteed a cache miss on literally every request (confirmed 2026-08-08:
 * two reloads seconds apart still took the full ~6s each). Flooring to the
 * TTL window means requests landing in the same window collapse onto one
 * cache entry; a fixed custom date range floors to the same value every
 * time regardless, so this is a no-op for that case.
 */
function cacheBucketKey(date: Date): number {
  return Math.floor(date.getTime() / TRAFFIC_REPORT_CACHE_TTL_MS);
}

/**
 * The `_TABLE_SUFFIX` predicate every GA4 query in this app shares: match the
 * finalized daily tables in range, AND every intraday table in range.
 *
 * Both halves are load-bearing.
 *
 * `BETWEEN @start AND @end` alone misses intraday tables entirely — their
 * suffix is the literal string `intraday_YYYYMMDD`, which sorts after any
 * plain `YYYYMMDD` and so never falls inside the range.
 *
 * The previous fix for that was `OR _TABLE_SUFFIX = CONCAT("intraday_", @end)`
 * — one intraday table, the one named by the range's end. That silently
 * assumed GA4 keeps exactly one, i.e. that yesterday is always finalized.
 * It is not: GA4's daily export lands roughly two days late, so there are
 * routinely TWO intraday tables, and the day before today was matched by
 * neither half. Measured on a production app 2026-09-11, when `events_20260909`
 * was the newest finalized table and 09-10/09-11 were both intraday: the old
 * predicate returned 16 listing views for 09-10 against a true 175, a 91%
 * undercount of an entire day, in every report that read it.
 *
 * Matching on the DATE PART of an intraday suffix covers however many of them
 * GA4 happens to be keeping. `SUBSTR(..., 10)` drops the 9-character
 * `intraday_` prefix.
 *
 * Callers must bind `@start`/`@end` as `tableSuffix()` strings.
 */
export const TABLE_SUFFIX_IN_RANGE = `(
        _TABLE_SUFFIX BETWEEN @start AND @end
        OR (
          STARTS_WITH(_TABLE_SUFFIX, "intraday_")
          AND SUBSTR(_TABLE_SUFFIX, 10) BETWEEN @start AND @end
        )
      )`;

export function tableSuffix(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function resolveDimensionColumns(dimensions: PivotDimensionKey[]) {
  return dimensions.map((key) => {
    const dimension = PIVOT_DIMENSIONS.find((d) => d.key === key);
    if (!dimension) throw new Error(`Unknown pivot dimension: ${key}`);
    return dimension;
  });
}

function dimensionRowKey(
  dimensions: PivotDimensionKey[],
  values: Record<string, string>,
): string {
  return dimensions.map((key) => values[key]).join("␟");
}

/** Parses GA4's `event_date` column ("YYYYMMDD") into a UTC midnight Date. */
export function parseEventDate(value: string): Date {
  return new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
    ),
  );
}

/**
 * Buckets are sorted, ascending, and contiguous (from buildUtcBuckets), so
 * the last bucket whose start is <= date is always the correct match —
 * including a date that lands exactly on the final bucket's end boundary.
 */
function findBucketIndex(
  buckets: Array<{ start: Date }>,
  date: Date,
): number {
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (date >= buckets[i].start) return i;
  }
  return -1;
}

function getRow(
  rowsByKey: Map<string, RowAccumulator>,
  dimensions: PivotDimensionKey[],
  rowDimensions: Record<PivotDimensionKey, string>,
): RowAccumulator {
  const key = dimensionRowKey(dimensions, rowDimensions);
  let row = rowsByKey.get(key);
  if (!row) {
    row = { dims: rowDimensions, funnel: {}, trend: {} };
    rowsByKey.set(key, row);
  }
  return row;
}

function addToTrend(
  row: RowAccumulator,
  funnelKey: FunnelEventKey,
  bucketIndex: number,
  bucketCount: number,
  amount: number,
): void {
  let series = row.trend[funnelKey];
  if (!series) {
    series = new Array(bucketCount).fill(0);
    row.trend[funnelKey] = series;
  }
  series[bucketIndex] += amount;
}

/**
 * Given each visitor's `view_item` history (sorted ascending, already
 * resolved to dimension values) and a batch of later events for that same
 * visitor, picks the latest view at-or-before each event — the core
 * visitor-lookback match shared by both the BigQuery and local
 * implementations of `resolvePageViewOnlyDimensions` below, extracted so the
 * matching logic can't silently diverge between the two paths.
 */
function matchLatestViewAtOrBefore(
  installs: Array<{ userPseudoId: string; eventTimestamp: number }>,
  viewsByUser: Map<string, Array<{ timestamp: number; dims: Record<PivotDimensionKey, string> }>>,
  fallback: Record<PivotDimensionKey, string>,
): Map<string, Record<PivotDimensionKey, string>> {
  const result = new Map<string, Record<PivotDimensionKey, string>>();
  for (const install of installs) {
    const key = `${install.userPseudoId}␟${install.eventTimestamp}`;
    const views = viewsByUser.get(install.userPseudoId);
    if (!views || views.length === 0) {
      result.set(key, fallback);
      continue;
    }
    // Views are sorted ascending; take the latest one at-or-before the
    // install, falling back to the earliest available view if the install
    // event's timestamp somehow precedes every recorded view.
    let resolved = views[0].dims;
    for (const view of views) {
      if (view.timestamp > install.eventTimestamp) break;
      resolved = view.dims;
    }
    result.set(key, resolved);
  }
  return result;
}

/**
 * Resolves page-view-only pivot dimensions (see `PIVOT_DIMENSIONS`'
 * `installEventNative` flag) for a batch of `shopify_app_install` events.
 * `page_location` — and everything derived from it (search term,
 * surface type/detail/position, campaign, referrer) — is null on 100% of
 * install events (confirmed against live data, 2026-08-07), so
 * reading those dimensions straight off the install event always produces
 * "(not set)" even when the visitor's own listing-page view carried a real
 * value. This looks up each visitor's (`user_pseudo_id`) most recent
 * `view_item` event at or before their install and uses THAT event's
 * dimension values instead. Best-effort: a visitor with no `view_item` in
 * the lookback window (e.g. direct/deep-linked install, or the view fell
 * outside GA4's retention) resolves to "(not set)" for these dimensions,
 * same as today.
 */
async function resolvePageViewOnlyDimensions(
  bigquery: BigQuery,
  projectId: string,
  datasetId: string,
  pageViewOnlyDimensions: PivotDimensionKey[],
  installs: Array<{ userPseudoId: string; eventTimestamp: number }>,
  lookbackStart: Date,
  rangeEnd: Date,
): Promise<Map<string, Record<PivotDimensionKey, string>>> {
  const fallback = Object.fromEntries(
    pageViewOnlyDimensions.map((key) => [key, "(not set)"]),
  ) as Record<PivotDimensionKey, string>;

  const userPseudoIds = [...new Set(installs.map((i) => i.userPseudoId))];
  if (pageViewOnlyDimensions.length === 0 || userPseudoIds.length === 0) {
    const result = new Map<string, Record<PivotDimensionKey, string>>();
    for (const install of installs) {
      result.set(`${install.userPseudoId}␟${install.eventTimestamp}`, fallback);
    }
    return result;
  }

  const dimensionColumns = resolveDimensionColumns(pageViewOnlyDimensions);
  const selectList = dimensionColumns
    .map((d) => `COALESCE(${d.column}, "(not set)") AS ${d.key}`)
    .join(",\n        ");

  const [rows] = await bigquery.query({
    query: `
      SELECT user_pseudo_id, event_timestamp, ${selectList}
      FROM \`${projectId}.${datasetId}.events_*\`
      WHERE ${TABLE_SUFFIX_IN_RANGE}
        AND event_name = "view_item"
        AND user_pseudo_id IN UNNEST(@userPseudoIds)
      ORDER BY user_pseudo_id, event_timestamp ASC
    `,
    params: {
      start: tableSuffix(lookbackStart),
      end: tableSuffix(rangeEnd),
      userPseudoIds,
    },
    types: { userPseudoIds: ["STRING"] },
  });

  const viewsByUser = new Map<
    string,
    Array<{ timestamp: number; dims: Record<PivotDimensionKey, string> }>
  >();
  for (const row of rows) {
    const userPseudoId = String(row.user_pseudo_id ?? "");
    if (!userPseudoId) continue;
    const dims = {} as Record<PivotDimensionKey, string>;
    for (const key of pageViewOnlyDimensions) dims[key] = String(row[key]);
    const list = viewsByUser.get(userPseudoId);
    const entry = { timestamp: Number(row.event_timestamp), dims };
    if (list) list.push(entry);
    else viewsByUser.set(userPseudoId, [entry]);
  }

  return matchLatestViewAtOrBefore(installs, viewsByUser, fallback);
}

/**
 * Local twin of `resolvePageViewOnlyDimensions` — same visitor-lookback join,
 * against the local `TrafficEventFact` mirror instead of BigQuery. Shares
 * `matchLatestViewAtOrBefore` with the BigQuery version so the actual
 * matching semantics can never silently diverge between the two paths.
 */
async function resolvePageViewOnlyDimensionsLocal(
  appId: string,
  pageViewOnlyDimensions: PivotDimensionKey[],
  installs: Array<{ userPseudoId: string; eventTimestamp: number }>,
  lookbackStart: Date,
  rangeEnd: Date,
): Promise<Map<string, Record<PivotDimensionKey, string>>> {
  const fallback = Object.fromEntries(
    pageViewOnlyDimensions.map((key) => [key, "(not set)"]),
  ) as Record<PivotDimensionKey, string>;

  const userPseudoIds = [...new Set(installs.map((i) => i.userPseudoId))];
  if (pageViewOnlyDimensions.length === 0 || userPseudoIds.length === 0) {
    const result = new Map<string, Record<PivotDimensionKey, string>>();
    for (const install of installs) {
      result.set(`${install.userPseudoId}␟${install.eventTimestamp}`, fallback);
    }
    return result;
  }

  const rows = await prisma.trafficEventFact.findMany({
    where: {
      appId,
      eventName: "view_item",
      userPseudoId: { in: userPseudoIds },
      eventTimestamp: { gte: lookbackStart, lt: rangeEnd },
    },
    select: {
      userPseudoId: true,
      eventTimestamp: true,
      pageLocation: true,
      pageReferrer: true,
      campaign: true,
      trafficSourceName: true,
      trafficSourceMedium: true,
      trafficSourceSource: true,
      language: true,
      country: true,
    },
    orderBy: [{ userPseudoId: "asc" }, { eventTimestamp: "asc" }],
  });

  const viewsByUser = new Map<
    string,
    Array<{ timestamp: number; dims: Record<PivotDimensionKey, string> }>
  >();
  for (const row of rows) {
    const dims = resolveAllDimensions(pageViewOnlyDimensions, row);
    const entry = { timestamp: row.eventTimestamp.getTime(), dims };
    const list = viewsByUser.get(row.userPseudoId);
    if (list) list.push(entry);
    else viewsByUser.set(row.userPseudoId, [entry]);
  }

  return matchLatestViewAtOrBefore(installs, viewsByUser, fallback);
}

/**
 * Maps each requested shop domain to the traffic dimensions of its most
 * recent shopify_app_install event within the lookback window. Best-effort:
 * shops that installed before the lookback window, or whose install event
 * fell outside GA4's export, won't resolve and get bucketed separately by
 * the caller rather than silently dropped.
 */
async function getShopAttributionMap(
  bigquery: BigQuery,
  projectId: string,
  datasetId: string,
  dimensions: PivotDimensionKey[],
  shopDomains: string[],
  periodEnd: Date,
): Promise<Map<string, Record<PivotDimensionKey, string>>> {
  const map = new Map<string, Record<PivotDimensionKey, string>>();
  if (shopDomains.length === 0) return map;

  const pageViewOnlyDimensions = dimensions.filter((key) => {
    const dimension = PIVOT_DIMENSIONS.find((d) => d.key === key);
    return dimension && !dimension.installEventNative;
  });
  const nativeDimensions = dimensions.filter(
    (key) => !pageViewOnlyDimensions.includes(key),
  );
  const nativeColumns = resolveDimensionColumns(nativeDimensions);
  const nativeSelectList = nativeColumns
    .map((d) => `COALESCE(${d.column}, "(not set)") AS ${d.key}`)
    .join(",\n          ");
  const lookbackStart = new Date(
    periodEnd.getTime() - SHOP_ATTRIBUTION_LOOKBACK_DAYS * 86_400_000,
  );

  const nativeColumnNames = nativeDimensions.join(", ");
  const [rows] = await bigquery.query({
    query: `
      SELECT shop_url, user_pseudo_id, event_timestamp
        ${nativeColumnNames ? `, ${nativeColumnNames}` : ""}
      FROM (
        SELECT
          user_pseudo_id,
          event_timestamp,
          (SELECT value.string_value FROM UNNEST(event_params) WHERE key = "shop_url") AS shop_url
          ${nativeSelectList ? `, ${nativeSelectList}` : ""}
        FROM \`${projectId}.${datasetId}.events_*\`
        WHERE ${TABLE_SUFFIX_IN_RANGE}
          AND event_name = "shopify_app_install"
      )
      WHERE shop_url IN UNNEST(@shopDomains)
      -- Found 2026-08-17 (production parity check against the new local
      -- mirror): this had NO ordering, despite the docstring's "most recent"
      -- promise — the "first wins" dedup below silently took whichever
      -- install BigQuery happened to return first, not the truly latest one.
      -- Harmless-looking but real: a shop with more than one install in the
      -- lookback window (reinstalls, tier-change replacement charges) could
      -- get attributed to a STALE source, and BigQuery's own row order isn't
      -- even guaranteed stable across runs. Explicit DESC makes "first wins"
      -- actually mean "most recent wins," and lets the local mirror (which
      -- now also orders DESC) agree with this path deterministically.
      ORDER BY event_timestamp DESC
    `,
    params: {
      start: tableSuffix(lookbackStart),
      end: tableSuffix(periodEnd),
      shopDomains,
    },
    types: { shopDomains: ["STRING"] },
  });

  const installs = rows
    .filter((row) => row.shop_url)
    .map((row) => ({
      shopUrl: String(row.shop_url),
      userPseudoId: String(row.user_pseudo_id ?? ""),
      eventTimestamp: Number(row.event_timestamp),
      nativeDims: Object.fromEntries(
        nativeDimensions.map((key) => [key, String(row[key])]),
      ) as Record<PivotDimensionKey, string>,
    }));

  const resolvedPageViewDims = await resolvePageViewOnlyDimensions(
    bigquery,
    projectId,
    datasetId,
    pageViewOnlyDimensions,
    installs,
    lookbackStart,
    periodEnd,
  );

  for (const install of installs) {
    if (map.has(install.shopUrl)) continue;
    const pageViewDims = resolvedPageViewDims.get(
      `${install.userPseudoId}␟${install.eventTimestamp}`,
    )!;
    map.set(install.shopUrl, { ...install.nativeDims, ...pageViewDims });
  }
  return map;
}

/** Local twin of `getShopAttributionMap`, against the `TrafficEventFact` mirror. */
async function getShopAttributionMapLocal(
  appId: string,
  dimensions: PivotDimensionKey[],
  shopDomains: string[],
  periodEnd: Date,
): Promise<Map<string, Record<PivotDimensionKey, string>>> {
  const map = new Map<string, Record<PivotDimensionKey, string>>();
  if (shopDomains.length === 0) return map;

  const pageViewOnlyDimensions = dimensions.filter((key) => {
    const dimension = PIVOT_DIMENSIONS.find((d) => d.key === key);
    return dimension && !dimension.installEventNative;
  });
  const nativeDimensions = dimensions.filter(
    (key) => !pageViewOnlyDimensions.includes(key),
  );
  const lookbackStart = new Date(
    periodEnd.getTime() - SHOP_ATTRIBUTION_LOOKBACK_DAYS * 86_400_000,
  );

  const rows = await prisma.trafficEventFact.findMany({
    where: {
      appId,
      eventName: "shopify_app_install",
      shopUrl: { in: shopDomains },
      eventTimestamp: { gte: lookbackStart, lt: periodEnd },
    },
    select: {
      shopUrl: true,
      userPseudoId: true,
      eventTimestamp: true,
      trafficSourceName: true,
      trafficSourceMedium: true,
      trafficSourceSource: true,
      language: true,
      country: true,
    },
    // Must match getShopAttributionMap's ORDER BY event_timestamp DESC —
    // the "first wins" dedup below needs the truly most-recent install per
    // shop, not whichever row the query happens to return first.
    orderBy: { eventTimestamp: "desc" },
  });

  const installs = rows
    .filter((row) => row.shopUrl)
    .map((row) => ({
      shopUrl: row.shopUrl!,
      userPseudoId: row.userPseudoId,
      eventTimestamp: row.eventTimestamp.getTime(),
      nativeDims: resolveAllDimensions(nativeDimensions, {
        pageLocation: null,
        pageReferrer: null,
        campaign: null,
        trafficSourceName: row.trafficSourceName,
        trafficSourceMedium: row.trafficSourceMedium,
        trafficSourceSource: row.trafficSourceSource,
        language: row.language,
        country: row.country,
      }),
    }));

  const resolvedPageViewDims = await resolvePageViewOnlyDimensionsLocal(
    appId,
    pageViewOnlyDimensions,
    installs,
    lookbackStart,
    periodEnd,
  );

  for (const install of installs) {
    if (map.has(install.shopUrl)) continue;
    const pageViewDims = resolvedPageViewDims.get(
      `${install.userPseudoId}␟${install.eventTimestamp}`,
    )!;
    map.set(install.shopUrl, { ...install.nativeDims, ...pageViewDims });
  }
  return map;
}

interface AttributedInstall {
  shopUrl: string;
  eventDate: string;
  dimensions: Record<PivotDimensionKey, string>;
}

/**
 * Per-request cache for `fetchAttributedInstalls`, keyed by range+dimensions.
 * `fetchAllRows` (main range) and `fetchInstalledShopDomainsByRow` (MRR/CLV,
 * always the main range) both need this exact same install list — without
 * this cache they'd each independently re-run the same BigQuery install
 * query AND the same visitor-lookback join, doubling ~8s of query time on
 * every single Traffic report request (measured 2026-08-08). Scoped to one
 * `getTrafficSourcesReport` call — a plain module-level `Map` would leak
 * across requests and serve stale data.
 */
type AttributedInstallsCache = Map<string, Promise<AttributedInstall[]>>;

/**
 * Every `shopify_app_install` event within `range`, with its full dimension
 * set already resolved (native fields read straight off the install event;
 * page-view-only fields re-attributed via `resolvePageViewOnlyDimensions`'s
 * visitor lookback). The shared source of truth for both "Installed" funnel
 * counting (`fetchAllRows`) and MRR/CLV shop-domain attribution
 * (`fetchInstalledShopDomainsByRow`) — see `AttributedInstallsCache` above
 * for why callers must go through the cache, not call this directly.
 */
async function fetchAttributedInstalls(
  bigquery: BigQuery,
  projectId: string,
  datasetId: string,
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  activeDimensions: PivotDimensionKey[],
): Promise<AttributedInstall[]> {
  const pageViewOnlyDimensions = activeDimensions.filter((key) => {
    const dimension = PIVOT_DIMENSIONS.find((d) => d.key === key);
    return dimension && !dimension.installEventNative;
  });
  const nativeDimensions = activeDimensions.filter(
    (key) => !pageViewOnlyDimensions.includes(key),
  );
  const nativeColumns = resolveDimensionColumns(nativeDimensions);
  const nativeSelectList = nativeColumns
    .map((d) => `COALESCE(${d.column}, "(not set)") AS ${d.key}`)
    .join(",\n          ");

  const [rows] = await bigquery.query({
    query: `
      SELECT
        user_pseudo_id,
        event_timestamp,
        event_date,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = "shop_url") AS shop_url
        ${nativeSelectList ? `, ${nativeSelectList}` : ""}
      FROM \`${projectId}.${datasetId}.events_*\`
      WHERE ${TABLE_SUFFIX_IN_RANGE}
        AND event_name = "shopify_app_install"
        AND TIMESTAMP_MICROS(event_timestamp) >= @preciseStart
        AND TIMESTAMP_MICROS(event_timestamp) < @preciseEnd
    `,
    params: {
      start: tableSuffix(range.start),
      end: tableSuffix(range.end),
      preciseStart: range.start,
      preciseEnd: range.end,
    },
  });

  const installs = rows
    .filter((row) => row.shop_url)
    .map((row) => ({
      shopUrl: String(row.shop_url),
      userPseudoId: String(row.user_pseudo_id ?? ""),
      eventTimestamp: Number(row.event_timestamp),
      eventDate: String(row.event_date),
      nativeDims: Object.fromEntries(
        nativeDimensions.map((key) => [key, String(row[key])]),
      ) as Record<PivotDimensionKey, string>,
    }));

  const lookbackStart = new Date(
    range.start.getTime() - INSTALL_ATTRIBUTION_LOOKBACK_DAYS * 86_400_000,
  );
  const resolvedPageViewDims = await resolvePageViewOnlyDimensions(
    bigquery,
    projectId,
    datasetId,
    pageViewOnlyDimensions,
    installs,
    lookbackStart,
    range.end,
  );

  return installs.map((install) => ({
    shopUrl: install.shopUrl,
    eventDate: install.eventDate,
    dimensions: {
      ...install.nativeDims,
      ...resolvedPageViewDims.get(`${install.userPseudoId}␟${install.eventTimestamp}`)!,
    } as Record<PivotDimensionKey, string>,
  }));
}

/** Local twin of `fetchAttributedInstalls`, against the `TrafficEventFact` mirror. */
async function fetchAttributedInstallsLocal(
  appId: string,
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  activeDimensions: PivotDimensionKey[],
): Promise<AttributedInstall[]> {
  const pageViewOnlyDimensions = activeDimensions.filter((key) => {
    const dimension = PIVOT_DIMENSIONS.find((d) => d.key === key);
    return dimension && !dimension.installEventNative;
  });
  const nativeDimensions = activeDimensions.filter(
    (key) => !pageViewOnlyDimensions.includes(key),
  );

  const rows = await prisma.trafficEventFact.findMany({
    where: {
      appId,
      eventName: "shopify_app_install",
      eventTimestamp: { gte: range.start, lt: range.end },
    },
    select: {
      shopUrl: true,
      userPseudoId: true,
      eventTimestamp: true,
      eventDate: true,
      trafficSourceName: true,
      trafficSourceMedium: true,
      trafficSourceSource: true,
      language: true,
      country: true,
    },
  });

  const installs = rows
    .filter((row) => row.shopUrl)
    .map((row) => ({
      shopUrl: row.shopUrl!,
      userPseudoId: row.userPseudoId,
      eventTimestamp: row.eventTimestamp.getTime(),
      eventDate: tableSuffix(row.eventDate),
      nativeDims: resolveAllDimensions(nativeDimensions, {
        pageLocation: null,
        pageReferrer: null,
        campaign: null,
        trafficSourceName: row.trafficSourceName,
        trafficSourceMedium: row.trafficSourceMedium,
        trafficSourceSource: row.trafficSourceSource,
        language: row.language,
        country: row.country,
      }),
    }));

  const lookbackStart = new Date(
    range.start.getTime() - INSTALL_ATTRIBUTION_LOOKBACK_DAYS * 86_400_000,
  );
  const resolvedPageViewDims = await resolvePageViewOnlyDimensionsLocal(
    appId,
    pageViewOnlyDimensions,
    installs,
    lookbackStart,
    range.end,
  );

  return installs.map((install) => ({
    shopUrl: install.shopUrl,
    eventDate: install.eventDate,
    dimensions: {
      ...install.nativeDims,
      ...resolvedPageViewDims.get(`${install.userPseudoId}␟${install.eventTimestamp}`)!,
    } as Record<PivotDimensionKey, string>,
  }));
}

/**
 * Abstracts "where do GA4-shaped traffic rows come from" — the live BigQuery
 * query layer, or the local `TrafficEventFact` mirror. `fetchAllRows` and its
 * helpers below are written against this interface and don't otherwise know
 * or care which one is behind it (see `createBigQueryTrafficSource`/
 * `createLocalTrafficSource`). Bound per-call to one `range`/`appId`, since a
 * single `getTrafficSourcesReport` invocation may build one of these per
 * range (main + optional compare) but never needs to mix sources within one.
 */
interface TrafficSource {
  fetchAttributedInstalls(
    range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
    activeDimensions: PivotDimensionKey[],
  ): Promise<AttributedInstall[]>;
  fetchShopAttribution(
    dimensions: PivotDimensionKey[],
    shopDomains: string[],
    periodEnd: Date,
  ): Promise<Map<string, Record<PivotDimensionKey, string>>>;
  fetchDirectFunnelRows(
    range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
    activeDimensions: PivotDimensionKey[],
    eventNames: string[],
  ): Promise<Array<Record<string, unknown>>>;
}

async function fetchDirectFunnelRowsBigQuery(
  bigquery: BigQuery,
  projectId: string,
  datasetId: string,
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  activeDimensions: PivotDimensionKey[],
  eventNames: string[],
): Promise<Array<Record<string, unknown>>> {
  const dimensionColumns = resolveDimensionColumns(activeDimensions);
  const selectList = dimensionColumns
    .map((d) => `COALESCE(${d.column}, "(not set)") AS ${d.key}`)
    .join(",\n          ");
  const groupByList = [...dimensionColumns.map((d) => d.key), "event_date", "event_name"].join(
    ", ",
  );

  const [rows] = await bigquery.query({
    query: `
      SELECT
        ${selectList},
        event_date,
        event_name,
        COUNT(*) AS cnt
      FROM \`${projectId}.${datasetId}.events_*\`
      WHERE ${TABLE_SUFFIX_IN_RANGE}
        AND event_name IN UNNEST(@eventNames)
        -- _TABLE_SUFFIX only prunes to whole days; this narrows to the exact
        -- instant so sub-day ranges (e.g. "Last 12 hours") are correct
        -- rather than rounding up to the whole day's table.
        AND TIMESTAMP_MICROS(event_timestamp) >= @preciseStart
        AND TIMESTAMP_MICROS(event_timestamp) < @preciseEnd
      GROUP BY ${groupByList}
    `,
    params: {
      start: tableSuffix(range.start),
      end: tableSuffix(range.end),
      eventNames,
      preciseStart: range.start,
      preciseEnd: range.end,
    },
    types: { eventNames: ["STRING"] },
  });
  return rows;
}

/**
 * Local twin of `fetchDirectFunnelRowsBigQuery` — reads raw per-event rows
 * from `TrafficEventFact` and groups them in JS instead of a SQL `GROUP BY`
 * (dimension values here are derived at read time via
 * `traffic-dimensions.local.ts`, not stored/queryable SQL columns), but
 * returns the identical `{ [dimensionKey]: string, event_date, event_name,
 * cnt }` shape `fetchAllRows` already knows how to consume.
 */
async function fetchDirectFunnelRowsLocal(
  appId: string,
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  activeDimensions: PivotDimensionKey[],
  eventNames: string[],
): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.trafficEventFact.findMany({
    where: {
      appId,
      eventName: { in: eventNames },
      eventTimestamp: { gte: range.start, lt: range.end },
    },
    select: {
      eventName: true,
      eventDate: true,
      pageLocation: true,
      pageReferrer: true,
      campaign: true,
      trafficSourceName: true,
      trafficSourceMedium: true,
      trafficSourceSource: true,
      language: true,
      country: true,
    },
  });

  const grouped = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const dims = resolveAllDimensions(activeDimensions, row);
    const eventDate = tableSuffix(row.eventDate);
    const key = `${row.eventName}␟${eventDate}␟${dimensionRowKey(activeDimensions, dims)}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.cnt = (existing.cnt as number) + 1;
    } else {
      grouped.set(key, { ...dims, event_date: eventDate, event_name: row.eventName, cnt: 1 });
    }
  }
  return [...grouped.values()];
}

function createBigQueryTrafficSource(
  bigquery: BigQuery,
  projectId: string,
  datasetId: string,
): TrafficSource {
  return {
    fetchAttributedInstalls: (range, activeDimensions) =>
      fetchAttributedInstalls(bigquery, projectId, datasetId, range, activeDimensions),
    fetchShopAttribution: (dimensions, shopDomains, periodEnd) =>
      getShopAttributionMap(bigquery, projectId, datasetId, dimensions, shopDomains, periodEnd),
    fetchDirectFunnelRows: (range, activeDimensions, eventNames) =>
      fetchDirectFunnelRowsBigQuery(bigquery, projectId, datasetId, range, activeDimensions, eventNames),
  };
}

function createLocalTrafficSource(appId: string): TrafficSource {
  return {
    fetchAttributedInstalls: (range, activeDimensions) =>
      fetchAttributedInstallsLocal(appId, range, activeDimensions),
    fetchShopAttribution: (dimensions, shopDomains, periodEnd) =>
      getShopAttributionMapLocal(appId, dimensions, shopDomains, periodEnd),
    fetchDirectFunnelRows: (range, activeDimensions, eventNames) =>
      fetchDirectFunnelRowsLocal(appId, range, activeDimensions, eventNames),
  };
}

function getAttributedInstalls(
  cache: AttributedInstallsCache,
  source: TrafficSource,
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  activeDimensions: PivotDimensionKey[],
): Promise<AttributedInstall[]> {
  const key = `${tableSuffix(range.start)}|${tableSuffix(range.end)}|${range.start.getTime()}|${range.end.getTime()}|${activeDimensions.join(",")}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = source.fetchAttributedInstalls(range, activeDimensions);
    cache.set(key, promise);
  }
  return promise;
}

/**
 * Every shop domain that installed within `range`, grouped by the same
 * dimension-value combination used elsewhere in the report — the join key
 * that lets MRR/CLV be attributed back to a traffic source.
 */
async function fetchInstalledShopDomainsByRow(
  cache: AttributedInstallsCache,
  source: TrafficSource,
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  activeDimensions: PivotDimensionKey[],
): Promise<Map<string, string[]>> {
  const installs = await getAttributedInstalls(cache, source, range, activeDimensions);

  const map = new Map<string, string[]>();
  for (const install of installs) {
    const key = dimensionRowKey(activeDimensions, install.dimensions);
    const list = map.get(key);
    if (list) list.push(install.shopUrl);
    else map.set(key, [install.shopUrl]);
  }
  return map;
}

/**
 * MRR = sum of each attributed shop's current active-subscription
 * contribution, INCLUDING trials — same definition as the headline MRR card
 * (`summarizeContributions.mrr` in partner-mrr.server.ts: monthly + annual +
 * trial). CLV = ARPU(row) ÷ rolling 30-day paid-subscription churn rate(row),
 * but ARPU's own MRR numerator EXCLUDES trials — matching
 * `buildLtvReportFromRecurring`'s comment exactly: "Trials are useful as a
 * separate forecast component, but ARPU/LTV use paid recurring revenue and
 * paid subscriptions only." Guarded to `null` (not `0` or `Infinity`) when
 * churn is zero, matching `docs/shopify-analytics.md`: "LTV uses paid ARPU
 * divided by rolling paid subscription churn and returns no value when churn
 * is zero."
 */
async function attachMrrAndClv(
  rows: TrafficSourceRow[],
  shopDomainsByRow: Map<string, string[]>,
  activeDimensions: PivotDimensionKey[],
  at: Date,
  appId: string,
): Promise<TrafficSourceRow[]> {
  const allShopDomains = [...new Set([...shopDomainsByRow.values()].flat())];
  if (allShopDomains.length === 0) {
    return rows.map((row) => ({ ...row, mrr: 0, clv: null }));
  }

  const [events, sales] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId, shopDomain: { in: allShopDomains } },
      select: {
        appId: true,
        type: true,
        occurredAt: true,
        shopDomain: true,
        chargePlatformId: true,
        chargeName: true,
        amount: true,
        currencyCode: true,
        billingOn: true,
        test: true,
      },
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId, shopDomain: { in: allShopDomains } },
      select: {
        appId: true,
        chargePlatformId: true,
        occurredAt: true,
        billingInterval: true,
        grossAmount: true,
        currencyCode: true,
      },
    }),
  ]);

  const offerPins = await resolveOfferCadencePins(events, sales);
  const histories = historiesFromFacts(events, sales, offerPins);
  const historiesByShop = new Map<string, ChargeHistory[]>();
  for (const history of histories) {
    const shopDomain = history.events[0]?.shopDomain;
    if (!shopDomain) continue;
    const list = historiesByShop.get(shopDomain);
    if (list) list.push(history);
    else historiesByShop.set(shopDomain, [history]);
  }

  return rows.map((row) => {
    const shopDomains = shopDomainsByRow.get(
      dimensionRowKey(activeDimensions, row.dimensions),
    );
    if (!shopDomains || shopDomains.length === 0) {
      return { ...row, mrr: 0, clv: null };
    }
    const rowHistories = shopDomains.flatMap(
      (shopDomain) => historiesByShop.get(shopDomain) ?? [],
    );
    const contributions = contributionsAt(rowHistories, at).filter(
      (contribution) => contribution.currency === MRR_CURRENCY,
    );
    const mrr = round2(contributions.reduce((sum, c) => sum + c.amount, 0));
    const paidContributions = contributions.filter((c) => c.kind !== "trial");
    const paidMrr = round2(
      paidContributions.reduce((sum, c) => sum + c.amount, 0),
    );
    const payingPopulation = paidContributions.length;
    const arpu = payingPopulation > 0 ? paidMrr / payingPopulation : 0;
    const churn = subscriptionChurnAt(rowHistories, MRR_CURRENCY, at);
    const clv = churn.rate > 0 ? round2(arpu / churn.rate) : null;
    return { ...row, mrr, clv };
  });
}

/**
 * The derived lifecycle events (trial started/converted, upgraded,
 * downgraded, resubscribed) that fall inside `range`, for one app.
 *
 * Two things make this more involved than the other funnel sources.
 *
 * **The fold is stateful per shop.** Whether an activation reads as an upgrade
 * depends on what the shop was already paying, and reactivation-vs-new depends
 * on whether it ever paid before. So a shop's charges cannot be loaded
 * partially — `historiesFromFacts` must see all of them, over all time, or the
 * classification changes rather than merely narrowing. (Charge-scoped loading
 * is exactly the bug that made `buildTodayRecurringTopUp` misclassify.)
 *
 * **But the whole app cannot be folded on every request** — one large app alone
 * is ~41k events. So the shops are narrowed first, then loaded completely:
 * only a shop with activity in the window can have a derived event in it. That
 * includes clock activity, not just feed activity — a trial converting emits
 * nothing, so the third query finds shops whose `billingOn` falls in one of
 * the windows a transition could be visible through
 * (`clockTransitionBillingOnWindows`, the same helper the daily snapshot's
 * live top-up uses for the same reason).
 *
 * Independent of `localReadiness`: this is our own Partner mirror either way,
 * never BigQuery.
 */
async function fetchDerivedFunnelEvents(
  appId: string,
  range: Pick<ResolvedAnalyticsRange, "start" | "end">,
  wanted: Set<DerivedFunnelKind>,
): Promise<Array<{ kind: DerivedFunnelKind; shopDomain: string; at: Date }>> {
  if (wanted.size === 0 || !appId) return [];

  const [eventShops, saleShops, clockShops] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId, occurredAt: { gte: range.start, lt: range.end }, test: false },
      select: { shopDomain: true },
      distinct: ["shopDomain"],
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId, occurredAt: { gte: range.start, lt: range.end } },
      select: { shopDomain: true },
      distinct: ["shopDomain"],
    }),
    prisma.partnerSubscriptionEvent.findMany({
      where: {
        appId,
        test: false,
        OR: clockTransitionBillingOnWindows(range.start, range.end).map(
          (window) => ({ billingOn: window }),
        ),
      },
      select: { shopDomain: true },
      distinct: ["shopDomain"],
    }),
  ]);

  const shops = [
    ...new Set(
      [...eventShops, ...saleShops, ...clockShops]
        .map((row) => row.shopDomain)
        .filter((domain): domain is string => Boolean(domain)),
    ),
  ];
  if (shops.length === 0) return [];

  const [events, sales] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId, shopDomain: { in: shops } },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId, shopDomain: { in: shops } },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
  ]);
  if (events.length === 0) return [];

  const histories = historiesFromFacts(
    events,
    sales,
    await resolveOfferCadencePins(events, sales),
    await loadLiveDiscountChecks([appId]),
  );
  const evidence = buildChurnEvidenceIndex(histories);
  const firstPaid = buildFirstPaidContributionIndex(histories);

  const byShop = new Map<string, ChargeHistory[]>();
  for (const history of histories) {
    const shop = history.events[0]?.shopDomain;
    if (!shop) continue;
    const group = byShop.get(shop);
    if (group) group.push(history);
    else byShop.set(shop, [history]);
  }

  const results: Array<{ kind: DerivedFunnelKind; shopDomain: string; at: Date }> =
    [];
  for (const group of byShop.values()) {
    for (const event of derivedFunnelEventsForShop(group, evidence, firstPaid)) {
      if (!wanted.has(event.kind)) continue;
      // The shops were widened to catch anything that COULD have moved in the
      // window; the events themselves still have to land inside it.
      if (event.at < range.start || event.at >= range.end) continue;
      results.push(event);
    }
  }
  return results;
}

/**
 * Runs the GA4 + lifecycle-events aggregation for one date range, returning
 * one row per distinct dimension-value combination (unfiltered, unpaged) —
 * shared between the main period and an optional "Compare to" period so both
 * go through the exact same query logic.
 */
async function fetchAllRows(
  cache: AttributedInstallsCache,
  source: TrafficSource,
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  activeDimensions: PivotDimensionKey[],
  activeFunnels: FunnelEventKey[],
  appId: string,
  /** Called once per counted event that has a shop, with the dimensions it
   * was attributed to — the per-customer view the insights revenue metrics
   * need. GA4-direct rows are pre-aggregated counts with no shop, so they
   * never reach it; that includes Installed when no page-view-only dimension
   * is active (the insights report always has some). */
  onShopEvent?: (
    shopDomain: string,
    dimensions: Record<PivotDimensionKey, string>,
  ) => void,
): Promise<{ allRows: TrafficSourceRow[]; buckets: ReturnType<typeof buildUtcBuckets> }> {
  const rowsByKey = new Map<string, RowAccumulator>();
  const buckets = buildUtcBuckets(range);

  const ga4Funnels = activeFunnels.filter((key) => key in GA4_EVENT_BY_FUNNEL);
  const pageViewOnlyDimensions = activeDimensions.filter((key) => {
    const dimension = PIVOT_DIMENSIONS.find((d) => d.key === key);
    return dimension && !dimension.installEventNative;
  });
  // "installed" is the only funnel mapped to shopify_app_install; only it
  // needs the visitor-level re-attribution join, and only when at least one
  // active dimension can't be read directly off the install event.
  const installFunnelNeedsJoin =
    ga4Funnels.includes("installed") && pageViewOnlyDimensions.length > 0;
  const directFunnels = installFunnelNeedsJoin
    ? ga4Funnels.filter((key) => key !== "installed")
    : ga4Funnels;

  // The direct GA4 event query and the install-attribution join are
  // completely independent (different event types, no shared data
  // dependency) — run them concurrently rather than one after another. Both
  // just populate the shared `rowsByKey` map with plain sync loops once
  // their own data has arrived, so there's no race to worry about.
  const directFunnelsPromise =
    directFunnels.length > 0
      ? source.fetchDirectFunnelRows(
          range,
          activeDimensions,
          directFunnels.map((key) => GA4_EVENT_BY_FUNNEL[key]!),
        )
      : Promise.resolve(null);

  const installsPromise = installFunnelNeedsJoin
    ? getAttributedInstalls(cache, source, range, activeDimensions)
    : Promise.resolve(null);

  const [directFunnelRows, installs] = await Promise.all([
    directFunnelsPromise,
    installsPromise,
  ]);

  if (directFunnelRows) {
    for (const row of directFunnelRows) {
      const funnelKey = directFunnels.find(
        (key) => GA4_EVENT_BY_FUNNEL[key] === row.event_name,
      );
      if (!funnelKey) continue;
      const bucketIndex = findBucketIndex(
        buckets,
        parseEventDate(String(row.event_date)),
      );
      if (bucketIndex === -1) continue;

      const rowDimensions = {} as Record<PivotDimensionKey, string>;
      for (const key of activeDimensions) rowDimensions[key] = String(row[key]);
      const rowAcc = getRow(rowsByKey, activeDimensions, rowDimensions);
      const count = Number(row.cnt ?? 0);
      rowAcc.funnel[funnelKey] = (rowAcc.funnel[funnelKey] ?? 0) + count;
      addToTrend(rowAcc, funnelKey, bucketIndex, buckets.length, count);
    }
  }

  if (installs) {
    for (const install of installs) {
      const bucketIndex = findBucketIndex(
        buckets,
        parseEventDate(install.eventDate),
      );
      if (bucketIndex === -1) continue;

      const rowAcc = getRow(rowsByKey, activeDimensions, install.dimensions);
      onShopEvent?.(install.shopUrl, install.dimensions);
      rowAcc.funnel.installed = (rowAcc.funnel.installed ?? 0) + 1;
      addToTrend(rowAcc, "installed", bucketIndex, buckets.length, 1);
    }
  }

  // Uninstalled/Reinstalled (our own lifecycle-event table),
  // Subscribed/Unsubscribed/Charge abandoned (Partner subscription events),
  // and the derived trial/upgrade/downgrade/resubscribe events all carry only
  // a shop identity, not GA4 dimensions — all three attribute back to traffic
  // source via the same shop-domain join, so they're resolved together in
  // one shopAttribution lookup.
  const lifecycleFunnels = activeFunnels.filter(
    (key) => key in LIFECYCLE_TYPE_BY_FUNNEL,
  );
  const partnerEventFunnels = activeFunnels.filter(
    (key) => key in PARTNER_EVENT_TYPES_BY_FUNNEL,
  );
  const derivedWanted = new Set<DerivedFunnelKind>(
    activeFunnels
      .map((key) => DERIVED_FUNNEL_KINDS[key])
      .filter((kind): kind is DerivedFunnelKind => Boolean(kind)),
  );

  if (
    lifecycleFunnels.length > 0 ||
    partnerEventFunnels.length > 0 ||
    derivedWanted.size > 0
  ) {
    const [lifecycleEvents, partnerEvents, derivedEvents] = await Promise.all([
      lifecycleFunnels.length > 0
        ? prisma.accountLifecycleEvent.findMany({
            where: {
              type: { in: lifecycleFunnels.map((key) => LIFECYCLE_TYPE_BY_FUNNEL[key]!) },
              occurredAt: { gte: range.start, lte: range.end },
              appInstall: { appId },
            },
            select: {
              type: true,
              occurredAt: true,
              appInstall: { select: { shopDomain: true } },
            },
          })
        : Promise.resolve([]),
      partnerEventFunnels.length > 0
        ? prisma.partnerSubscriptionEvent.findMany({
            where: {
              appId,
              type: {
                in: partnerEventFunnels.flatMap(
                  (key) => PARTNER_EVENT_TYPES_BY_FUNNEL[key]!,
                ),
              },
              occurredAt: { gte: range.start, lte: range.end },
              test: false,
            },
            select: { type: true, occurredAt: true, shopDomain: true },
          })
        : Promise.resolve([]),
      fetchDerivedFunnelEvents(appId, range, derivedWanted),
    ]);

    const shopDomains = [
      ...new Set([
        ...lifecycleEvents.map((e) => e.appInstall.shopDomain),
        ...partnerEvents.map((e) => e.shopDomain),
        ...derivedEvents.map((e) => e.shopDomain),
      ]),
    ];

    if (shopDomains.length > 0) {
      const shopAttribution = await source.fetchShopAttribution(
        activeDimensions,
        shopDomains,
        range.end,
      );
      const attributeRow = (shopDomain: string) =>
        shopAttribution.get(shopDomain) ??
        (Object.fromEntries(
          activeDimensions.map((key) => [key, UNKNOWN_SHOP_DIMENSION_VALUE]),
        ) as Record<PivotDimensionKey, string>);

      for (const event of lifecycleEvents) {
        const funnelKey = lifecycleFunnels.find(
          (fk) => LIFECYCLE_TYPE_BY_FUNNEL[fk] === event.type,
        );
        if (!funnelKey) continue;
        const bucketIndex = findBucketIndex(buckets, event.occurredAt);
        if (bucketIndex === -1) continue;

        const dimensions = attributeRow(event.appInstall.shopDomain);
        onShopEvent?.(event.appInstall.shopDomain, dimensions);
        const rowAcc = getRow(rowsByKey, activeDimensions, dimensions);
        rowAcc.funnel[funnelKey] = (rowAcc.funnel[funnelKey] ?? 0) + 1;
        addToTrend(rowAcc, funnelKey, bucketIndex, buckets.length, 1);
      }

      for (const event of partnerEvents) {
        const funnelKey = partnerEventFunnels.find((fk) =>
          PARTNER_EVENT_TYPES_BY_FUNNEL[fk]!.includes(event.type),
        );
        if (!funnelKey) continue;
        const bucketIndex = findBucketIndex(buckets, event.occurredAt);
        if (bucketIndex === -1) continue;

        const dimensions = attributeRow(event.shopDomain);
        onShopEvent?.(event.shopDomain, dimensions);
        const rowAcc = getRow(rowsByKey, activeDimensions, dimensions);
        rowAcc.funnel[funnelKey] = (rowAcc.funnel[funnelKey] ?? 0) + 1;
        addToTrend(rowAcc, funnelKey, bucketIndex, buckets.length, 1);
      }

      /* `DerivedFunnelKind` and its `FunnelEventKey` are the same strings, so
         the derived kind names its funnel column directly. */
      for (const event of derivedEvents) {
        const funnelKey = event.kind as FunnelEventKey;
        const bucketIndex = findBucketIndex(buckets, event.at);
        if (bucketIndex === -1) continue;

        const dimensions = attributeRow(event.shopDomain);
        onShopEvent?.(event.shopDomain, dimensions);
        const rowAcc = getRow(rowsByKey, activeDimensions, dimensions);
        rowAcc.funnel[funnelKey] = (rowAcc.funnel[funnelKey] ?? 0) + 1;
        addToTrend(rowAcc, funnelKey, bucketIndex, buckets.length, 1);
      }
    }
  }

  const allRows: TrafficSourceRow[] = [...rowsByKey.values()].map((row) => ({
    dimensions: row.dims,
    funnel: row.funnel,
    trend: row.trend,
    mrr: null,
    clv: null,
  }));
  const sortKey = activeFunnels[0];
  allRows.sort((a, b) => (b.funnel[sortKey] ?? 0) - (a.funnel[sortKey] ?? 0));
  return { allRows, buckets };
}

function filterRows(
  rows: TrafficSourceRow[],
  activeFilters: DimensionFilters,
): TrafficSourceRow[] {
  if (Object.keys(activeFilters).length === 0) return rows;
  return rows.filter((row) =>
    Object.entries(activeFilters).every(([key, selected]) =>
      selected!.includes(row.dimensions[key as PivotDimensionKey]),
    ),
  );
}

async function computeTrafficSourcesReport(
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  dimensions: PivotDimensionKey[] = DEFAULT_PIVOT_DIMENSIONS,
  funnelEvents: FunnelEventKey[] = DEFAULT_FUNNEL_EVENTS,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  filters: DimensionFilters = {},
  compareRange?: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  /** The selected app's BigQuery dataset (e.g. "analytics_123456789"), or
   * `null` when this app has no GA4 config yet. Deliberately no env-var
   * fallback here (unlike `projectId` below) — a dataset is inherently
   * per-app/property, so falling back to a shared default would silently
   * show one app's data under a different app's name the moment a second
   * app exists without its own dataset configured. Resolved by the caller
   * from `App.bigqueryDataset` only. */
  datasetId: string | null = null,
  /** The GCP project that owns `datasetId`. Defaults to the shared
   * `GCP_PROJECT_ID` env var — only differs when an app's export lives in a
   * separate GCP project (`App.gcpProjectId`), which requires the BigQuery
   * service account to have been separately granted cross-project access. */
  projectId: string | null = env.GCP_PROJECT_ID ?? null,
  /** Scopes lifecycle events, Partner subscription events, and MRR/CLV
   * lookups to this app — a shop can have multiple of your apps installed, and
   * those tables aren't otherwise scoped by shop domain alone. */
  appId: string = "",
  /** True when the local `TrafficEventFact` mirror fully covers `range` (and
   * `compareRange`, if given) for this app — see `getTrafficSourcesReport`
   * for how this is computed. When true, every fetch below runs against the
   * local mirror instead of BigQuery, skipping both remote round-trips
   * entirely. Deliberately all-or-nothing per request (unlike the MRR
   * snapshot's per-day gap patching) — a range not fully covered falls back
   * to the existing, unchanged live BigQuery path as a whole. */
  localReadiness = false,
): Promise<TrafficSourcesReport> {
  const activeDimensions =
    dimensions.length > 0 ? dimensions : DEFAULT_PIVOT_DIMENSIONS;
  const activeFunnels =
    funnelEvents.length > 0 ? funnelEvents : DEFAULT_FUNNEL_EVENTS;
  // Only keep filters for dimensions that are actually active/selected.
  const activeFilters: DimensionFilters = {};
  for (const key of activeDimensions) {
    const selected = filters[key];
    if (selected && selected.length > 0) activeFilters[key] = selected;
  }
  const periodStart = range.start.toISOString();
  const periodEnd = range.end.toISOString();
  const empty = {
    periodStart,
    periodEnd,
    dimensions: activeDimensions,
    funnelEvents: activeFunnels,
    filters: activeFilters,
    availableValues: {},
    rows: [],
    totals: {},
    totalsTrend: {},
    trendBuckets: [],
    page: 1,
    totalPages: 1,
    compareRange: null,
  };

  if (!localReadiness && (!projectId || !datasetId)) {
    return {
      ...empty,
      available: false,
      error: "GA4/BigQuery is not configured for this app.",
    };
  }

  try {
    const source = localReadiness
      ? createLocalTrafficSource(appId)
      : createBigQueryTrafficSource(getClient(), projectId!, datasetId!);
    const attributedInstallsCache: AttributedInstallsCache = new Map();

    // These three fetches are mutually independent (main range, the optional
    // compare range, and the MRR/CLV shop-domain join — the last of which
    // always runs, regardless of active funnels/dimensions, since MRR/CLV
    // are fixed trailing columns). On the BigQuery path they used to run one
    // after another — up to three sequential remote round-trips stacked into
    // one request. Firing them together doesn't change any result (they
    // don't read each other's output, only share `attributedInstallsCache`,
    // which safely dedupes an identical range+dimensions install query no
    // matter which caller reaches it first — see that cache's own docs) and
    // cuts wall-clock from the sum of all three down to the slowest one. On
    // the local path this matters less (no remote round-trip cost) but
    // there's no reason to serialize local queries either.
    const [{ allRows, buckets }, compareAllRows, shopDomainsByRow] =
      await Promise.all([
        fetchAllRows(attributedInstallsCache, source, range, activeDimensions, activeFunnels, appId),
        compareRange
          ? fetchAllRows(
              attributedInstallsCache,
              source,
              compareRange,
              activeDimensions,
              activeFunnels,
              appId,
            ).then((result) => result.allRows)
          : Promise.resolve(null),
        fetchInstalledShopDomainsByRow(attributedInstallsCache, source, range, activeDimensions),
      ]);

    // Computed from the full, unfiltered set (sorted by the same busiest-
    // first order as the table) so the filter picker always offers every
    // option regardless of what's currently selected elsewhere.
    const availableValues: Partial<Record<PivotDimensionKey, string[]>> = {};
    for (const key of activeDimensions) {
      const seen = new Set<string>();
      const values: string[] = [];
      for (const row of allRows) {
        const value = row.dimensions[key];
        if (!seen.has(value)) {
          seen.add(value);
          values.push(value);
        }
      }
      availableValues[key] = values;
    }

    const filteredRows = filterRows(allRows, activeFilters);

    const totals: Partial<Record<FunnelEventKey, number>> = {};
    for (const key of activeFunnels) {
      totals[key] = filteredRows.reduce(
        (sum, row) => sum + (row.funnel[key] ?? 0),
        0,
      );
    }

    const totalsTrend: Partial<Record<FunnelEventKey, number[]>> = {};
    for (const key of activeFunnels) {
      const summed = new Array(buckets.length).fill(0);
      for (const row of filteredRows) {
        const series = row.trend[key];
        if (!series) continue;
        for (let i = 0; i < summed.length; i++) summed[i] += series[i] ?? 0;
      }
      totalsTrend[key] = summed;
    }

    const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    const clampedPage = Number.isInteger(page)
      ? Math.min(Math.max(page, 1), totalPages)
      : 1;
    const pagedRows = filteredRows.slice(
      (clampedPage - 1) * pageSize,
      clampedPage * pageSize,
    );

    // Match each page row to its "Compare to" counterpart by the same
    // dimension-value combination, filtered by the same active filters so a
    // filtered view compares apples-to-apples.
    let compareByKey: Map<string, Partial<Record<FunnelEventKey, number>>> | null =
      null;
    if (compareRange && compareAllRows) {
      const compareFilteredRows = filterRows(compareAllRows, activeFilters);
      compareByKey = new Map();
      for (const row of compareFilteredRows) {
        compareByKey.set(
          dimensionRowKey(activeDimensions, row.dimensions),
          row.funnel,
        );
      }
    }
    const rowsWithCompare = compareByKey
      ? pagedRows.map((row) => ({
          ...row,
          compare:
            compareByKey!.get(dimensionRowKey(activeDimensions, row.dimensions)) ??
            {},
        }))
      : pagedRows;

    // MRR/CLV are shown as fixed trailing columns regardless of which funnel
    // events are selected (matches Mantle), so this always runs — only for
    // the current page's rows, not the full unfiltered set, to keep the
    // per-request DB read bounded.
    const now = new Date();
    const mrrAt = range.end > now ? now : range.end;
    const rowsWithMrrClv = await attachMrrAndClv(
      rowsWithCompare,
      shopDomainsByRow,
      activeDimensions,
      mrrAt,
      appId,
    );

    const trendBuckets: TrendBucket[] = buckets.map((bucket) => ({
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
    }));

    return {
      ...empty,
      available: true,
      availableValues,
      rows: rowsWithMrrClv,
      totals,
      totalsTrend,
      trendBuckets,
      page: clampedPage,
      totalPages,
      compareRange: compareRange
        ? {
            start: compareRange.start.toISOString(),
            end: compareRange.end.toISOString(),
          }
        : null,
    };
  } catch (error) {
    return {
      ...empty,
      available: false,
      error: error instanceof Error ? error.message : "Unknown BigQuery error",
    };
  }
}

/**
 * Cached entrypoint — see `trafficReportCache`'s docs above for why. Same
 * signature/defaults as `computeTrafficSourcesReport`; every parameter that
 * affects the result goes into the cache key, normalized the same way
 * `computeTrafficSourcesReport` normalizes them internally (empty arrays ->
 * defaults) so a call with `dimensions=[]` and one with
 * `dimensions=DEFAULT_PIVOT_DIMENSIONS` share a cache entry instead of
 * needlessly duplicating the same query.
 */
/**
 * Whether this app's local mirror may serve a request instead of BigQuery.
 *
 * One definition shared by every report that reads traffic events, so the
 * pivot table and the insights pies can never disagree about which path a
 * given app is on. See `getTrafficSourcesReport`'s comment above for why this
 * is gated on the sync being alive rather than on `range.end`.
 */
function resolveLocalReadiness(
  trafficEventsBackfillCompletedAt: Date | null,
  trafficEventsSyncedAt: Date | null,
): boolean {
  const isSyncFreshEnough =
    Boolean(trafficEventsSyncedAt) &&
    Date.now() - trafficEventsSyncedAt!.getTime() <=
      TRAFFIC_LOCAL_STALENESS_TOLERANCE_MS;
  return (
    env.TRAFFIC_LOCAL_READ_PATH_ENABLED &&
    Boolean(trafficEventsBackfillCompletedAt) &&
    isSyncFreshEnough
  );
}

export async function getTrafficSourcesReport(
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  dimensions: PivotDimensionKey[] = DEFAULT_PIVOT_DIMENSIONS,
  funnelEvents: FunnelEventKey[] = DEFAULT_FUNNEL_EVENTS,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  filters: DimensionFilters = {},
  compareRange?: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  datasetId: string | null = null,
  projectId: string | null = env.GCP_PROJECT_ID ?? null,
  appId: string = "",
  /** This app's local TrafficEventFact sync state, resolved by the caller
   * from the same `apps` row it already loaded (mirrors how `datasetId`/
   * `projectId` above are threaded through rather than re-queried here). See
   * `computeTrafficSourcesReport`'s `localReadiness` doc for the coverage
   * rule this decides. */
  trafficEventsBackfillCompletedAt: Date | null = null,
  trafficEventsSyncedAt: Date | null = null,
): Promise<TrafficSourcesReport> {
  const activeDimensions =
    dimensions.length > 0 ? dimensions : DEFAULT_PIVOT_DIMENSIONS;
  const activeFunnels =
    funnelEvents.length > 0 ? funnelEvents : DEFAULT_FUNNEL_EVENTS;
  const activeFilters: DimensionFilters = {};
  for (const key of activeDimensions) {
    const selected = filters[key];
    if (selected && selected.length > 0) activeFilters[key] = selected;
  }

  // Local-serving is available for the whole of an app's history once
  // trafficEventsBackfillCompletedAt is set — the backfill only ever
  // completes once it's walked all the way back to the account's earliest
  // data (see traffic-events-sync.server.ts), so there's no separate
  // start-of-range check the way the day-by-day MRR snapshot needs.
  //
  // Deliberately NOT gated on `range.end <= trafficEventsSyncedAt` (removed
  // 2026-08-17) — every period preset whose end is "now" (i.e. almost all of
  // them) made that comparison fail permanently, since `trafficEventsSyncedAt`
  // always lags the instant of the request by however long since the last
  // sync tick. That silently forced every request onto the live BigQuery
  // path regardless of how complete the mirror actually was — confirmed in
  // production via the cache key (`...␟live␟...`) never once reading
  // `local`. The trailing sliver between `trafficEventsSyncedAt` and "now"
  // doesn't need special handling either: `fetchDirectFunnelRowsLocal`/
  // `fetchAttributedInstallsLocal` just filter `eventTimestamp` by range, so
  // a not-yet-synced instant simply yields fewer rows for that instant, not
  // a wrong answer — the same self-correcting staleness every other sync
  // tick in this app already relies on. The only thing actually worth
  // gating on is whether the sync is still alive at all.
  const localReadiness = resolveLocalReadiness(
    trafficEventsBackfillCompletedAt,
    trafficEventsSyncedAt,
  );

  const cacheKey = [
    /* Bump when a dimension's definition changes (v2: medium, language and
       search term, 2026-09-24), so a deploy never serves old-definition rows. */
    "dims:v2",
    appId,
    projectId ?? "",
    datasetId ?? "",
    localReadiness ? "local" : "live",
    cacheBucketKey(range.start),
    cacheBucketKey(range.end),
    range.interval,
    activeDimensions.join(","),
    activeFunnels.join(","),
    String(page),
    String(pageSize),
    JSON.stringify(activeFilters),
    compareRange
      ? `${cacheBucketKey(compareRange.start)}|${cacheBucketKey(compareRange.end)}|${compareRange.interval}`
      : "none",
  ].join("␟");

  const redisKey = `${TRAFFIC_REPORT_CACHE_KEY_PREFIX}${cacheKey}`;
  const result = await cachedWithRedis(redisKey, TRAFFIC_REPORT_CACHE_TTL_MS, () =>
    computeTrafficSourcesReport(
      range,
      dimensions,
      funnelEvents,
      page,
      pageSize,
      filters,
      compareRange,
      datasetId,
      projectId,
      appId,
      localReadiness,
    ),
  );

  // Don't let a transient failure (e.g. a BigQuery hiccup) get stuck as a
  // cached error for the full TTL — evict it so the next request retries
  // fresh instead of repeating the same failure for up to 2 minutes.
  if (!result.available) {
    await redis.del(redisKey).catch(() => undefined);
  }

  return result;
}

/** One app's GA4/BigQuery wiring plus its local-mirror sync state, resolved
 * by the caller from the same `apps` row it already loaded — the same five
 * values `getTrafficSourcesReport` takes as trailing parameters, bundled so a
 * list of them can be passed for the "All apps" aggregate. */
export interface TrafficAppScope {
  appId: string;
  datasetId: string | null;
  projectId: string | null;
  trafficEventsBackfillCompletedAt: Date | null;
  trafficEventsSyncedAt: Date | null;
}

/**
 * Where "All time" starts for the traffic reports: the earliest traffic event
 * held for these apps. Without it `resolveAnalyticsRange("all_time")` falls
 * back to the start of TODAY — both traffic reports showed only today's
 * handful of events under "All time". Mirrored apps read the local table; an
 * app served live asks BigQuery for its oldest daily export table (a metadata
 * query, nothing scanned). `undefined` when no app has any traffic.
 */
export async function findTrafficAllTimeStart(
  scopes: TrafficAppScope[],
): Promise<Date | undefined> {
  const local = scopes.filter((scope) =>
    resolveLocalReadiness(
      scope.trafficEventsBackfillCompletedAt,
      scope.trafficEventsSyncedAt,
    ),
  );
  const live = scopes.filter(
    (scope) => !local.includes(scope) && scope.projectId && scope.datasetId,
  );
  const starts = await Promise.all([
    local.length > 0
      ? prisma.trafficEventFact
          .aggregate({
            where: { appId: { in: local.map((scope) => scope.appId) } },
            _min: { eventTimestamp: true },
          })
          .then((result) => result._min.eventTimestamp ?? undefined)
      : undefined,
    ...live.map(async (scope) => {
      const [rows] = await getClient().query({
        query: `
          SELECT MIN(SUBSTR(table_name, 8, 8)) AS day
          FROM \`${scope.projectId}.${scope.datasetId}.INFORMATION_SCHEMA.TABLES\`
          WHERE REGEXP_CONTAINS(table_name, r"^events_[0-9]{8}$")`,
      });
      const day = rows[0]?.day as string | null | undefined;
      return day
        ? new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`)
        : undefined;
    }),
  ]);
  const found = starts.filter((date): date is Date => Boolean(date));
  return found.length > 0
    ? new Date(Math.min(...found.map((date) => date.getTime())))
    : undefined;
}

/**
 * Effectively "no pagination" for the per-app fetches the aggregate merges.
 *
 * Merging already-paginated pages would be wrong: app A's five busiest rows
 * and app B's five busiest rows, merged, are not the five busiest rows
 * overall. So each app is asked for its complete filtered row set, and the
 * merged result is sorted and paged once — the same order and page arithmetic
 * `computeTrafficSourcesReport` applies to a single app.
 *
 * This costs no extra database work: `attachMrrAndClv` issues exactly two
 * queries scoped to every attributed shop in the range regardless of how many
 * rows it then maps, so a larger page only means more in-memory
 * `contributionsAt` calls over the same already-loaded histories.
 */
const AGGREGATE_FETCH_PAGE_SIZE = 1_000_000;

/** Elementwise sum into `into`, tolerating a shorter/absent addend. */
function addTrendInto(into: number[], from: number[] | undefined): void {
  if (!from) return;
  for (let i = 0; i < into.length; i++) into[i] += from[i] ?? 0;
}

/**
 * Traffic for one app, or for every configured app at once.
 *
 * GA4 is per-app (one property, one dataset per app), so there is no single
 * query that spans them — an aggregate has to be built by running each app's
 * report and merging. With exactly one scope this delegates straight through,
 * so the single-app path (still by far the common one) keeps its existing
 * behaviour and its existing cache entries untouched.
 *
 * Rows are merged by dimension-value combination, which is what makes the
 * aggregate meaningful: `(direct)` traffic across four apps becomes one row
 * whose counts are the sum, not four near-identical rows.
 */
export async function getTrafficSourcesReportForApps(
  scopes: TrafficAppScope[],
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  dimensions: PivotDimensionKey[] = DEFAULT_PIVOT_DIMENSIONS,
  funnelEvents: FunnelEventKey[] = DEFAULT_FUNNEL_EVENTS,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  filters: DimensionFilters = {},
  compareRange?: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
): Promise<TrafficSourcesReport> {
  const activeDimensions =
    dimensions.length > 0 ? dimensions : DEFAULT_PIVOT_DIMENSIONS;
  const activeFunnels =
    funnelEvents.length > 0 ? funnelEvents : DEFAULT_FUNNEL_EVENTS;
  const activeFilters: DimensionFilters = {};
  for (const key of activeDimensions) {
    const selected = filters[key];
    if (selected && selected.length > 0) activeFilters[key] = selected;
  }

  const single = (scope: TrafficAppScope, forPage: number, forSize: number) =>
    getTrafficSourcesReport(
      range,
      dimensions,
      funnelEvents,
      forPage,
      forSize,
      filters,
      compareRange,
      scope.datasetId,
      scope.projectId,
      scope.appId,
      scope.trafficEventsBackfillCompletedAt,
      scope.trafficEventsSyncedAt,
    );

  if (scopes.length === 1) return single(scopes[0], page, pageSize);

  if (scopes.length === 0) {
    return {
      available: false,
      error: "No app has GA4/BigQuery configured yet.",
      periodStart: range.start.toISOString(),
      periodEnd: range.end.toISOString(),
      dimensions: activeDimensions,
      funnelEvents: activeFunnels,
      filters: activeFilters,
      availableValues: {},
      rows: [],
      totals: {},
      totalsTrend: {},
      trendBuckets: [],
      page: 1,
      totalPages: 1,
      compareRange: null,
    };
  }

  const reports = await Promise.all(
    scopes.map((scope) => single(scope, 1, AGGREGATE_FETCH_PAGE_SIZE)),
  );
  return mergeTrafficSourceReports(reports, {
    periodStart: range.start.toISOString(),
    periodEnd: range.end.toISOString(),
    dimensions: activeDimensions,
    funnelEvents: activeFunnels,
    filters: activeFilters,
    page,
    pageSize,
  });
}

/**
 * Merges one report per app into a single "All apps" report.
 *
 * Split out from `getTrafficSourcesReportForApps` as a pure function purely so
 * it can be tested without BigQuery or a database — the merge rules (null MRR,
 * CLV, elementwise trends, re-sorting before paging) are where this would go
 * subtly wrong, and none of them need real data to exercise.
 *
 * `reports` must all cover the same range and interval; the caller guarantees
 * that by passing the same `range` to each. Each report is expected UNPAGED
 * (see `AGGREGATE_FETCH_PAGE_SIZE`) — paging happens here, after merging.
 */
export function mergeTrafficSourceReports(
  reports: TrafficSourcesReport[],
  context: {
    periodStart: string;
    periodEnd: string;
    dimensions: PivotDimensionKey[];
    funnelEvents: FunnelEventKey[];
    filters: DimensionFilters;
    page: number;
    pageSize: number;
  },
): TrafficSourcesReport {
  const {
    periodStart,
    periodEnd,
    dimensions: activeDimensions,
    funnelEvents: activeFunnels,
    filters: activeFilters,
    page,
    pageSize,
  } = context;
  const usable = reports.filter((report) => report.available);

  if (usable.length === 0) {
    // Every app failed or is unconfigured — surface it as a single failure
    // rather than an empty-but-successful report that reads as "no traffic".
    const messages = [
      ...new Set(reports.map((report) => report.error).filter(Boolean)),
    ] as string[];
    return {
      available: false,
      error: messages.join(" ") || "GA4/BigQuery is not configured.",
      periodStart,
      periodEnd,
      dimensions: activeDimensions,
      funnelEvents: activeFunnels,
      filters: activeFilters,
      availableValues: {},
      rows: [],
      totals: {},
      totalsTrend: {},
      trendBuckets: [],
      page: 1,
      totalPages: 1,
      compareRange: null,
    };
  }

  // Identical across apps (derived from the same range + interval), so the
  // first usable report's buckets define the axis every trend array is
  // aligned to.
  const trendBuckets = usable[0].trendBuckets;
  const bucketCount = trendBuckets.length;

  const mergedByKey = new Map<string, TrafficSourceRow>();

  for (const report of usable) {
    for (const row of report.rows) {
      const key = dimensionRowKey(activeDimensions, row.dimensions);
      const existing = mergedByKey.get(key);
      if (!existing) {
        const trend: Partial<Record<FunnelEventKey, number[]>> = {};
        for (const funnel of activeFunnels) {
          const series = new Array<number>(bucketCount).fill(0);
          addTrendInto(series, row.trend[funnel]);
          trend[funnel] = series;
        }
        mergedByKey.set(key, {
          dimensions: row.dimensions,
          funnel: { ...row.funnel },
          trend,
          compare: row.compare ? { ...row.compare } : undefined,
          mrr: row.mrr,
          clv: row.clv,
        });
        continue;
      }
      for (const funnel of activeFunnels) {
        existing.funnel[funnel] =
          (existing.funnel[funnel] ?? 0) + (row.funnel[funnel] ?? 0);
        addTrendInto(existing.trend[funnel]!, row.trend[funnel]);
        if (row.compare) {
          existing.compare ??= {};
          existing.compare[funnel] =
            (existing.compare[funnel] ?? 0) + (row.compare[funnel] ?? 0);
        }
      }
      // `null` means "unavailable", not zero, so it must not be summed as 0 —
      // but one app being unavailable shouldn't erase another's real figure
      // either. Sum the numbers that exist; stay null only if none did.
      if (row.mrr !== null) existing.mrr = (existing.mrr ?? 0) + row.mrr;
      // CLV is ARPU ÷ churn over this row's attributed shops. Two apps' ratios
      // cannot be added, and the true combined value needs the union of both
      // apps' charge histories, which the per-app reports have already
      // collapsed. Rather than present a weighted guess as a measurement, a
      // row that more than one app contributed to shows no CLV; a row only one
      // app contributed to keeps its exact value.
      existing.clv = null;
    }
  }

  const filteredRows = [...mergedByKey.values()];
  // Same busiest-first order `fetchAllRows` applies, on the merged counts.
  const sortKey = activeFunnels[0];
  filteredRows.sort((a, b) => (b.funnel[sortKey] ?? 0) - (a.funnel[sortKey] ?? 0));

  const totals: Partial<Record<FunnelEventKey, number>> = {};
  const totalsTrend: Partial<Record<FunnelEventKey, number[]>> = {};
  for (const funnel of activeFunnels) {
    let sum = 0;
    const series = new Array<number>(bucketCount).fill(0);
    for (const report of usable) {
      sum += report.totals[funnel] ?? 0;
      addTrendInto(series, report.totalsTrend[funnel]);
    }
    totals[funnel] = sum;
    totalsTrend[funnel] = series;
  }

  // Union of each app's option list, first-seen order preserved. Each app
  // ranks its own values busiest-first; the merged order therefore leads with
  // the first app's ranking rather than a true cross-app one. That only
  // affects the order options appear in the filter picker, never which options
  // it offers or any number in the report.
  const availableValues: Partial<Record<PivotDimensionKey, string[]>> = {};
  for (const key of activeDimensions) {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const report of usable) {
      for (const value of report.availableValues[key] ?? []) {
        if (seen.has(value)) continue;
        seen.add(value);
        values.push(value);
      }
    }
    availableValues[key] = values;
  }

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const clampedPage = Number.isInteger(page)
    ? Math.min(Math.max(page, 1), totalPages)
    : 1;

  // Only apps that were configured AND failed; an unconfigured app has no
  // traffic to contribute, so leaving it out understates nothing.
  const partialErrors = reports
    .filter(
      (report) =>
        !report.available &&
        report.error &&
        !report.error.includes("not configured"),
    )
    .map((report) => report.error!);

  return {
    available: true,
    periodStart,
    periodEnd,
    dimensions: activeDimensions,
    funnelEvents: activeFunnels,
    filters: activeFilters,
    availableValues,
    rows: filteredRows.slice(
      (clampedPage - 1) * pageSize,
      clampedPage * pageSize,
    ),
    totals,
    totalsTrend,
    trendBuckets,
    page: clampedPage,
    totalPages,
    compareRange: usable[0].compareRange,
    ...(partialErrors.length > 0 ? { partialErrors } : {}),
  };
}

/* ------------------------------------------------------ traffic insights */

export interface InsightSlice {
  value: string;
  /** Events for Volume; the metric's USD amount otherwise. */
  count: number;
}

export interface InsightPieData {
  /** Recorded values only, busiest first. */
  slices: InsightSlice[];
  /** This pie's denominator: the sum of `slices`. */
  total: number;
  /** Left out of the pie for having no value for this dimension — events
   * for Volume, customers for a revenue metric. See `INSIGHT_UNSET_VALUES`. */
  unset: number;
}

export interface TrafficInsightsReport {
  available: boolean;
  error?: string;
  event: InsightEventKey;
  /** The metric actually drawn: Volume whenever the event has no shop, see
   * `SHOPLESS_INSIGHT_EVENTS`. */
  metric: InsightMetricKey;
  /** Events counted in the range, recorded values or not. */
  total: number;
  /** One pie per dimension. */
  pies: Record<InsightDimensionKey, InsightPieData>;
}

/**
 * The Traffic source insights report: how one funnel event splits across each
 * of `INSIGHT_DIMENSIONS`.
 *
 * ONE pass per app, grouped by all six dimensions at once, then each pie is
 * summed out of that. This is exact for counts — every event carries exactly
 * one value per dimension, installs included (their page-view-only dimensions
 * come from the same single visitor lookback), so a dimension's slices add up
 * to the same total whichever dimensions it was grouped with. The alternative,
 * six separate report runs, would repeat the whole attribution join six times.
 *
 * It calls `fetchAllRows` directly rather than `getTrafficSourcesReport`, which
 * always attaches MRR and CLV to every row (fixed trailing columns in the
 * pivot table) — the most expensive part of that report, and nothing a volume
 * pie reads.
 *
 * The revenue metrics ride the same pass: `fetchAllRows` reports each event's
 * shop and attribution, and each slice is then computed from its distinct
 * customers' revenue. Averages and medians are not additive, so unlike the
 * counts they can't be summed out of the grouped rows — they need the
 * customer list itself.
 */
export async function getTrafficInsights(
  scopes: TrafficAppScope[],
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
  event: InsightEventKey,
  requestedMetric: InsightMetricKey = "volume",
): Promise<TrafficInsightsReport> {
  const metric = SHOPLESS_INSIGHT_EVENTS.has(event) ? "volume" : requestedMetric;
  const emptyPies = Object.fromEntries(
    INSIGHT_DIMENSIONS.map((key) => [key, { slices: [], total: 0, unset: 0 }]),
  ) as unknown as Record<InsightDimensionKey, InsightPieData>;
  const empty = { event, metric, total: 0, pies: emptyPies };

  const servable = scopes.map((scope) => ({
    scope,
    local: resolveLocalReadiness(
      scope.trafficEventsBackfillCompletedAt,
      scope.trafficEventsSyncedAt,
    ),
  }));
  const usable = servable.filter(
    ({ scope, local }) => local || (scope.projectId && scope.datasetId),
  );
  if (usable.length === 0) {
    return {
      ...empty,
      available: false,
      error: "GA4/BigQuery is not configured for this app.",
    };
  }

  const cacheKey = [
    /* Versioned: bump when `TrafficInsightsReport`'s shape changes, or a
       cached entry in the old shape outlives the deploy and the page reads a
       field that isn't there. */
    "insights:v6",
    ...usable
      .map(({ scope, local }) => `${scope.appId}:${local ? "local" : "live"}`)
      .sort(),
    cacheBucketKey(range.start),
    cacheBucketKey(range.end),
    event,
    metric,
  ].join("␟");
  const redisKey = `${TRAFFIC_REPORT_CACHE_KEY_PREFIX}${cacheKey}`;

  const result = await cachedWithRedis(
    redisKey,
    TRAFFIC_REPORT_CACHE_TTL_MS,
    async (): Promise<TrafficInsightsReport> => {
      try {
        /* A customer is (app, shop): the same store in two apps is two
           relationships with two revenues. Keyed that way from the start so
           "All apps" never merges them. */
        const customersByValue = new Map<InsightDimensionKey, Map<string, Set<string>>>(
          INSIGHT_DIMENSIONS.map((key) => [key, new Map()]),
        );
        const unsetCustomers = new Map<InsightDimensionKey, Set<string>>(
          INSIGHT_DIMENSIONS.map((key) => [key, new Set()]),
        );
        const shopsByApp = new Map<string, Set<string>>();

        const perApp = await Promise.all(
          usable.map(({ scope, local }) =>
            fetchAllRows(
              new Map(),
              local
                ? createLocalTrafficSource(scope.appId)
                : createBigQueryTrafficSource(
                    getClient(),
                    scope.projectId!,
                    scope.datasetId!,
                  ),
              range,
              [...INSIGHT_DIMENSIONS],
              [event],
              scope.appId,
              metric === "volume"
                ? undefined
                : (shopDomain, dimensions) => {
                    /* Shopify's placeholder for a GDPR-erased shop: thousands
                       of different stores share it, so as a "customer" it
                       would be one fictional store owning all their revenue. */
                    if (shopDomain === "REDACTED") return;
                    const customer = `${scope.appId}␟${shopDomain}`;
                    let shops = shopsByApp.get(scope.appId);
                    if (!shops) shopsByApp.set(scope.appId, (shops = new Set()));
                    shops.add(shopDomain);
                    for (const key of INSIGHT_DIMENSIONS) {
                      const value = dimensions[key];
                      if (INSIGHT_UNSET_VALUES.has(value)) {
                        unsetCustomers.get(key)!.add(customer);
                        continue;
                      }
                      const byValue = customersByValue.get(key)!;
                      const label = insightLabel(key, value);
                      let customers = byValue.get(label);
                      if (!customers) byValue.set(label, (customers = new Set()));
                      customers.add(customer);
                    }
                  },
            ).then((result) => result.allRows),
          ),
        );

        const counts = new Map<InsightDimensionKey, Map<string, number>>(
          INSIGHT_DIMENSIONS.map((key) => [key, new Map()]),
        );
        const unset = new Map<InsightDimensionKey, number>(
          INSIGHT_DIMENSIONS.map((key) => [key, 0]),
        );
        let total = 0;
        for (const rows of perApp) {
          for (const row of rows) {
            const n = row.funnel[event] ?? 0;
            if (n === 0) continue;
            total += n;
            if (metric !== "volume") continue;
            for (const key of INSIGHT_DIMENSIONS) {
              const value = row.dimensions[key];
              if (INSIGHT_UNSET_VALUES.has(value)) {
                unset.set(key, unset.get(key)! + n);
                continue;
              }
              const label = insightLabel(key, value);
              const byValue = counts.get(key)!;
              byValue.set(label, (byValue.get(label) ?? 0) + n);
            }
          }
        }

        if (metric !== "volume") {
          const revenue = await fetchCustomerRevenue(shopsByApp);
          for (const key of INSIGHT_DIMENSIONS) {
            const byValue = counts.get(key)!;
            for (const [label, customers] of customersByValue.get(key)!) {
              byValue.set(
                label,
                summarizeMetric(
                  [...customers].map((customer) =>
                    customerValue(revenue.get(customer), metric),
                  ),
                  metric,
                ),
              );
            }
            unset.set(key, unsetCustomers.get(key)!.size);
          }
        }

        const pies = Object.fromEntries(
          INSIGHT_DIMENSIONS.map((key) => {
            const slices = [...counts.get(key)!.entries()]
              .map(([value, count]) => ({ value, count }))
              .sort(
                (a, b) => b.count - a.count || a.value.localeCompare(b.value),
              );
            return [
              key,
              {
                slices,
                total: slices.reduce((n, slice) => n + slice.count, 0),
                unset: unset.get(key)!,
              },
            ];
          }),
        ) as unknown as Record<InsightDimensionKey, InsightPieData>;

        return { available: true, event, metric, total, pies };
      } catch (error) {
        return {
          ...empty,
          available: false,
          error:
            error instanceof Error ? error.message : "Unknown BigQuery error",
        };
      }
    },
  );

  // Same as the pivot table: a transient failure must not sit in the cache.
  if (!result.available) {
    await redis.del(redisKey).catch(() => undefined);
  }
  return result;
}

/**
 * Surface detail arrives query-string encoded ("facebook+pixel"). The engine
 * already decodes Search term the same way; this decodes Surface detail for
 * display, merging any value that arrived both ways. Done HERE rather than in
 * the engine's SQL because the Traffic trends pivot table filters on the raw
 * string, and saved filters store it — decoding at the source would silently
 * stop those matching.
 */
function insightLabel(key: InsightDimensionKey, value: string): string {
  return key === "surface_detail" ? value.replace(/\+/g, " ") : value;
}

/** Keeps each `IN (...)` list well under MySQL's placeholder limit. */
const REVENUE_SHOP_CHUNK = 2000;

/**
 * Lifetime revenue per customer, keyed `appId␟shopDomain` — the same CLV and
 * months-billed definitions as `getTopCustomers`. Filtered by app, as every
 * sale-fact read in this file must be: shop domains aren't unique across apps.
 * A customer with no sale is simply absent, and counts as zero.
 */
async function fetchCustomerRevenue(
  shopsByApp: Map<string, Set<string>>,
): Promise<Map<string, CustomerRevenue>> {
  const revenue = new Map<string, CustomerRevenue>();
  for (const [appId, shopSet] of shopsByApp) {
    const shops = [...shopSet];
    for (let i = 0; i < shops.length; i += REVENUE_SHOP_CHUNK) {
      const chunk = shops.slice(i, i + REVENUE_SHOP_CHUNK);
      const rows = await prisma.$queryRaw<
        Array<{ shopDomain: string; clv: unknown; months: unknown }>
      >`
        SELECT s.shopDomain AS shopDomain,
               COALESCE(SUM(s.grossAmount), 0) AS clv,
               SUM(CASE WHEN s.billingInterval = 'ANNUAL' THEN 12 ELSE 1 END) AS months
        FROM partner_subscription_sale_facts s
        WHERE s.appId = ${appId}
          AND s.shopDomain IN (${Prisma.join(chunk)})
        GROUP BY s.shopDomain`;
      for (const row of rows) {
        revenue.set(`${appId}␟${row.shopDomain}`, {
          clv: Number(row.clv),
          months: Number(row.months),
        });
      }
    }
  }
  return revenue;
}
