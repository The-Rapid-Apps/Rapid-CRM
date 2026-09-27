import type { Prisma } from "../../../generated/prisma/client";
import { cachedWithRedis } from "../cache/redis-cache.server";
import { prisma } from "../db.server";
import { env } from "../env.server";
import type { AnalyticsInterval, AnalyticsPeriod } from "./analytics.shared";
import {
  computeDirtyRangeSnapshotRows,
  type DailyInstallFlow,
  type DailyInstallStock,
} from "./install-snapshot.server";

export type { AnalyticsInterval, AnalyticsPeriod } from "./analytics.shared";

export interface AnalyticsQuery {
  /** Hard tenant boundary. It must always come from the authenticated user. */
  organizationId: string;
  appId?: string;
  period?: AnalyticsPeriod;
  interval?: AnalyticsInterval;
  /** Test/custom-range escape hatch; the dashboard uses period presets. */
  start?: Date;
  end?: Date;
  now?: Date;
}

export interface ResolvedAnalyticsRange {
  period: AnalyticsPeriod;
  start: Date;
  end: Date;
  interval: AnalyticsInterval;
}

export interface UtcBucket {
  start: Date;
  end: Date;
  provisional: boolean;
}

export interface ReportEnvelope {
  period: AnalyticsPeriod;
  periodStart: string;
  periodEnd: string;
  interval: AnalyticsInterval;
}

export interface RevenuePoint {
  periodStart: string;
  periodEnd: string;
  gross: number;
  credits: number;
  net: number;
  provisional: boolean;
}

export interface RevenueCurrencyReport {
  currency: string;
  value: { gross: number; credits: number; net: number };
  timeSeries: RevenuePoint[];
}

export interface RevenueReport extends ReportEnvelope {
  currencies: RevenueCurrencyReport[];
}

export interface CountChurnPoint {
  periodStart: string;
  periodEnd: string;
  lost: number;
  recovered: number;
  netLost: number;
  denominator: number;
  rate: number;
  provisional: boolean;
}

export interface CountChurnMetric {
  value: number;
  netLost: number;
  denominator: number;
  timeSeries: CountChurnPoint[];
}

export interface RevenueChurnPoint {
  periodStart: string;
  periodEnd: string;
  lostMrr: number;
  startMrr: number;
  rate: number;
  provisional: boolean;
}

export interface RevenueChurnCurrencyReport {
  currency: string;
  value: { lostMrr: number; startMrr: number; rate: number };
  timeSeries: RevenueChurnPoint[];
}

export interface ChurnReport extends ReportEnvelope {
  /** Customer-driven net logo churn; store-closure movements are excluded. */
  logo: CountChurnMetric;
  /**
   * Explicit cancellations only. Completed tier changes and approved
   * replacement subscriptions are excluded from the cancellation numerator.
   */
  subscription: CountChurnMetric;
  /** Cancellation MRR only; downgrades need normalized event deltas not stored yet. */
  grossRevenue: { currencies: RevenueChurnCurrencyReport[] };
}

export interface LtvPoint {
  periodStart: string;
  periodEnd: string;
  value: number | null;
  arpu: number;
  mrr: number;
  activeSubscriptions: number;
  monthlyChurnRate: number;
  churnBasis: "subscription" | "logo";
  provisional: boolean;
}

export interface LtvCurrencyReport {
  currency: string;
  value: number | null;
  arpu: number;
  mrr: number;
  activeSubscriptions: number;
  monthlyChurnRate: number;
  churnBasis: "subscription" | "logo";
  timeSeries: LtvPoint[];
}

export interface LtvReport extends ReportEnvelope {
  currencies: LtvCurrencyReport[];
}

export interface RecurringPoint {
  periodStart: string;
  periodEnd: string;
  currency: string;
  monthlySubscriptions: number;
  annualSubscriptions: number;
  usageCharges: number;
  trialSubscriptions: number;
  mrr: number;
  arr: number;
  activeSubscriptions: number;
  activeCustomers: number;
  /** Distinct non-trial customers when the source can separate trials. */
  activePayingCustomers?: number;
  /** Paid subscriptions live at the start of the rolling 30-day window. */
  subscriptionChurnDenominator?: number;
  /** Net paid cancellations in the rolling 30-day window. */
  churnedSubscriptions?: number;
  /** Paid subscription churn reconstructed from charge state transitions. */
  monthlySubscriptionChurnRate?: number;
  provisional: boolean;
  /**
   * Trailing-30-day MRR growth: `(mrr - mrrThirtyDaysAgo) / mrrThirtyDaysAgo`.
   *
   * A MONTHLY rate evaluated at every bucket, which is what "MRR growth rate"
   * means and what makes the metric comparable across intervals. The obvious
   * alternative — bucket-over-bucket change — is not the same metric at all: on
   * a daily series it reports ~0.2% moves, and scaling one day's change up to a
   * month multiplies that day's noise by 30. Null when there was no MRR 30 days
   * earlier, since growth from zero is not a rate.
   */
  monthlyMrrGrowthRate?: number | null;
  /** The base the rate above divides by, kept so the UI need not re-derive it. */
  mrrThirtyDaysAgo?: number;
}

export interface RecurringCurrencySummary {
  currency: string;
  mrr: number;
  arr: number;
  monthlySubscriptions: number;
  annualSubscriptions: number;
  usageCharges: number;
  trialSubscriptions: number;
  startingMrr: number;
  netMrrGrowth: number;
  growthRate: number;
  activeSubscriptions: number;
  activeCustomers: number;
}

/**
 * One currency's MRR movement over a whole range.
 *
 * Every field is POSITIVE, as the columns store them; `net` applies the signs.
 * Kept that way rather than pre-signing the losses so the reader cannot
 * accidentally add a loss — the same reasoning as `MrrMovementDelta.amount`.
 *
 * `earlyPlanChange` is a DISCLOSURE, not a category: it is already counted
 * inside `new`, and reports how much of `new` is really first-period plan
 * shopping. Adding it to the others would double-count.
 */
/* The movement vocabulary lives in a client-safe module — the Reports panel
   renders `MRR_MOVEMENT_ROWS` as a value, and importing that from here would
   drag this server module into the client bundle. Re-exported so server
   callers keep one import site. */
import type {
  MrrMovementSummary,
  PlanMrrSeries,
} from "./mrr-movement.shared";
import { STORE_CLOSURE_CODES } from "../customer-events/uninstall-reason";
export type {
  MrrMovementCategory,
  MrrMovementBucket,
  MrrMovementSummary,
  PlanMrrSeries,
} from "./mrr-movement.shared";
export {
  MRR_MOVEMENT_ROWS,
  EMPTY_MRR_MOVEMENT_BUCKET,
  mrrMovementNet,
} from "./mrr-movement.shared";

export interface InstallPoint {
  periodStart: string;
  periodEnd: string;
  activeInstalls: number;
  newInstalls: number;
  uninstalls: number;
  netGrowth: number;
  provisional: boolean;
}

export interface TrialTotals {
  started: number;
  converted: number;
  canceled: number;
  completed: number;
  unresolved: number;
  conversionRate: number;
  activeNow: number;
}

export interface TrialSummary extends TrialTotals {
  timeSeries: TrialPoint[];
  source: "local_lifecycle" | "shopify_partner_inferred";
  historyComplete: boolean;
  /**
   * The same report with $0 plans excluded, for the "Paid plans only" toggle.
   *
   * Shipped alongside rather than refetched: the toggle is client state, and
   * the fold behind this costs seconds.
   *
   * There is deliberately NO paid variant of `TrialPoint`'s *Value fields. A
   * free plan's monthly amount is 0, so it already contributes nothing to any
   * sum — only the COUNTS, and the count-ratio `conversionRate` built from
   * them, can differ. Adding value twins would be dead weight that silently
   * invites the two copies to drift.
   *
   * Optional because the local-lifecycle source doesn't produce it.
   */
  paidOnly?: TrialTotals & { timeSeries: TrialPoint[] };
}

export interface TrialPoint {
  periodStart: string;
  periodEnd: string;
  /** Monthly-normalized plan value of the trials in each state. Present so a
   * trials table can report money; the counts beside them are unchanged.
   *
   * `startedValue` is a FLOW (trials begun in this bucket) and sums across
   * buckets; `activeValue` is a STOCK (trials open at the bucket's end) and
   * does not — adding it across days counts one trial once per day it stayed
   * open. The table totals a flow for that reason. */
  startedValue?: number;
  activeValue?: number;
  convertedValue?: number;
  canceledValue?: number;
  started: number;
  converted: number;
  canceled: number;
  active: number;
  conversionRate: number;
  provisional: boolean;
}

export interface UsagePoint {
  periodStart: string;
  periodEnd: string;
  quantity: number;
  eventCount: number;
  activeInstalls: number;
  provisional: boolean;
}

export interface FunnelSummary {
  installed: number;
  subscribed: number;
  activated: number;
  paid: number;
}

export interface RetentionCohort {
  cohort: string;
  installed: number;
  retained: number;
  retentionRate: number;
}

export interface UsageMetricSummary {
  metric: string;
  quantity: number;
  eventCount: number;
  activeInstalls: number;
  previousQuantity: number;
  changeRate: number | null;
  timeSeries: UsagePoint[];
}

export interface UninstallReasonSummary {
  reasonCode: string;
  count: number;
  share: number;
  storeClosure: boolean;
}

export interface PortfolioReport extends ReportEnvelope {
  recurring: {
    currencies: RecurringCurrencySummary[];
    timeSeries: RecurringPoint[];
    /** Where MRR moved in the range. Absent unless snapshot-covered. */
    movement?: MrrMovementSummary[];
    /** Top plans by MRR. Absent on the snapshot path, which has no plan column. */
    planSeries?: PlanMrrSeries[];
  };
  installs: {
    activeNow: number;
    installedInPeriod: number;
    uninstalledInPeriod: number;
    netGrowth: number;
    timeSeries: InstallPoint[];
  };
  trials: TrialSummary;
  funnel: FunnelSummary;
  retention: RetentionCohort[];
  usage: UsageMetricSummary[];
  uninstallReasons: UninstallReasonSummary[];
  forecast: Array<{
    currency: string;
    monthlyRunRate: number;
    annualRunRate: number;
  }>;
  sourceCoverage: {
    installs: number;
    subscriptions: number;
    successfulCharges: number;
    usageEvents: number;
    notes: string[];
    unavailable: string[];
  };
}

export interface AnalyticsReports {
  portfolio: PortfolioReport;
  revenue: RevenueReport;
  churn: ChurnReport;
  ltv: LtvReport;
}

type Numeric = string | number | { toString(): string };

export interface RecurringPlanForReport {
  amount: Numeric;
  recurringInterval: string;
  recurringIntervalCount: number;
  currencyCode?: string;
}

export interface DiscountApplicationForReport {
  startsAt: Date;
  endsAt: Date | null;
  discount: {
    type: string;
    value: Numeric;
    discountMethod: string;
    durationIntervals: number | null;
  };
}

interface SubscriptionForReport {
  id: string;
  appInstallId: string;
  test: boolean;
  activatedAt: Date | null;
  canceledAt: Date | null;
  frozenAt: Date | null;
  pausedUntil: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  plan: RecurringPlanForReport & { currencyCode: string };
  discounts: DiscountApplicationForReport[];
  flexBillingEvents: Array<{
    type: string;
    completedAt: Date | null;
  }>;
  replacementSubscriptions: Array<{
    activatedAt: Date | null;
  }>;
}

/** Exported so install-snapshot.server.ts's equivalence test can compare its
 * transition-based stock computation against this exact, real predicate
 * rather than a hand-maintained copy that could silently drift from it. */
export interface InstallForReport {
  id: string;
  installedAt: Date;
  uninstalledAt: Date | null;
  lifecycleEvents: Array<{
    type: string;
    occurredAt: Date;
    uninstallDetail: { isStoreClosure: boolean } | null;
  }>;
}

function finiteDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return value;
}

export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function startOfUtcWeek(value: Date): Date {
  const day = startOfUtcDay(value);
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day;
}

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addUtcInterval(value: Date, interval: AnalyticsInterval): Date {
  const next = new Date(value);
  if (interval === "day") next.setUTCDate(next.getUTCDate() + 1);
  else if (interval === "week") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1, 1);
  return next;
}

export function autoInterval(start: Date, end: Date): AnalyticsInterval {
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days <= 45) return "day";
  if (days <= 180) return "week";
  return "month";
}

/**
 * Every bucket in a report built from Partner facts (mrr/churn/ltv) costs
 * roughly one full pass over every live charge — `contributionMapAt`,
 * `subscriptionChurnAt` — so bucket *count* drives cost independently of any
 * caching. `interval` is normally auto-picked to keep that count sane
 * (`autoInterval`), but a caller can explicitly request `day` regardless of
 * how wide the range is — e.g. a UI's "Chart interval" control left on
 * "Daily" after switching "Period" to "All time" on a years-old account.
 * That combination (day granularity x years of history) is what actually
 * produced 504 timeouts in production (2026-08-16) — not a caching gap, a
 * genuine O(buckets x histories) blowup. Coarsen the requested interval,
 * never fine it up, until the bucket count is bounded — the explicit choice
 * still wins for any range narrow enough to make it safe.
 */
const MAX_REPORT_BUCKETS = 200;
const INTERVAL_ORDER: AnalyticsInterval[] = ["day", "week", "month"];
const INTERVAL_MS: Record<AnalyticsInterval, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

export function capReportInterval(
  interval: AnalyticsInterval,
  start: Date,
  end: Date,
): AnalyticsInterval {
  const rangeMs = end.getTime() - start.getTime();
  let index = INTERVAL_ORDER.indexOf(interval);
  while (
    index < INTERVAL_ORDER.length - 1 &&
    rangeMs / INTERVAL_MS[INTERVAL_ORDER[index]] > MAX_REPORT_BUCKETS
  ) {
    index += 1;
  }
  return INTERVAL_ORDER[index];
}

/**
 * Resolve a preset using UTC because Organization has no timezone field yet.
 * Dashboard copy calls this out rather than pretending these are local days.
 */
export function resolveAnalyticsRange(
  period: AnalyticsPeriod = "last_30_days",
  now = new Date(),
  allTimeStart?: Date,
): ResolvedAnalyticsRange {
  const end = finiteDate(new Date(now), "now");
  let start: Date;

  if (period === "last_30_days") {
    start = startOfUtcDay(end);
    start.setUTCDate(start.getUTCDate() - 29);
  } else if (period === "last_90_days") {
    start = startOfUtcDay(end);
    start.setUTCDate(start.getUTCDate() - 89);
  } else if (period === "last_12_months") {
    start = startOfUtcMonth(end);
    start.setUTCMonth(start.getUTCMonth() - 11);
  } else if (period === "year_to_date") {
    start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  } else {
    start = startOfUtcDay(allTimeStart ?? end);
  }

  if (start >= end) {
    start = new Date(end.getTime() - 86_400_000);
  }
  return { period, start, end, interval: autoInterval(start, end) };
}

export function buildUtcBuckets(
  range: Pick<ResolvedAnalyticsRange, "start" | "end" | "interval">,
): UtcBucket[] {
  const floor =
    range.interval === "day"
      ? startOfUtcDay(range.start)
      : range.interval === "week"
        ? startOfUtcWeek(range.start)
        : startOfUtcMonth(range.start);
  const buckets: UtcBucket[] = [];
  let cursor = floor;

  while (cursor < range.end) {
    const naturalEnd = addUtcInterval(cursor, range.interval);
    const start = cursor < range.start ? range.start : cursor;
    const end = naturalEnd > range.end ? range.end : naturalEnd;
    if (end > start) {
      buckets.push({
        start: new Date(start),
        end: new Date(end),
        provisional: naturalEnd > range.end,
      });
    }
    cursor = naturalEnd;
  }
  return buckets;
}

function round(value: number, places = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator, 6) : 0;
}

function afterDiscount(
  amount: number,
  application: DiscountApplicationForReport,
): number {
  const value = Number(application.discount.value);
  if (application.discount.type === "PERCENTAGE") {
    return Math.max(amount * (1 - value / 100), 0);
  }
  if (application.discount.type === "AMOUNT") {
    return Math.max(amount - value, 0);
  }
  if (application.discount.type === "FLAT_PRICE") {
    return Math.max(value, 0);
  }
  return amount;
}

/**
 * Mantle baseline rule: only a permanent PRICE_REDUCTION application lowers
 * MRR. Temporary rules and APP_CREDITS change collected cash, not baseline MRR.
 */
export function monthlyRecurringAmount(
  plan: RecurringPlanForReport,
  applications: DiscountApplicationForReport[] = [],
  asOf = new Date(),
): number {
  let amount = Number(plan.amount);
  const permanent = applications
    .filter(
      (application) =>
        application.startsAt <= asOf &&
        application.endsAt === null &&
        application.discount.durationIntervals === null &&
        application.discount.discountMethod === "PRICE_REDUCTION",
    )
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
  if (permanent) amount = afterDiscount(amount, permanent);

  const count = Math.max(1, plan.recurringIntervalCount);
  if (plan.recurringInterval === "DAY" && count === 30) return amount;
  if (plan.recurringInterval === "DAY") return (amount * 365) / count / 12;
  if (plan.recurringInterval === "WEEK") return (amount * 52) / count / 12;
  if (plan.recurringInterval === "YEAR") return amount / count / 12;
  // MONTH (and safe fallback) — e.g. a $90 quarterly plan is $30 MRR.
  return amount / count;
}

export function subscriptionAsOfWhere(
  organizationId: string,
  at: Date,
  appId?: string,
): Prisma.SubscriptionWhereInput {
  return {
    test: false,
    activatedAt: { lte: at },
    AND: [
      { OR: [{ canceledAt: null }, { canceledAt: { gt: at } }] },
      { OR: [{ frozenAt: null }, { frozenAt: { gt: at } }] },
      { OR: [{ pausedUntil: null }, { pausedUntil: { lt: at } }] },
      { OR: [{ trialEndsAt: null }, { trialEndsAt: { lte: at } }] },
    ],
    appInstall: {
      app: {
        organizationId,
        ...(appId ? { id: appId } : {}),
      },
    },
  };
}

function subscriptionIsLiveAt(
  subscription: SubscriptionForReport,
  at: Date,
  test: boolean = false,
): boolean {
  return Boolean(
    subscription.test === test &&
    subscription.activatedAt &&
    subscription.activatedAt <= at &&
    (!subscription.canceledAt || subscription.canceledAt > at) &&
    (!subscription.frozenAt || subscription.frozenAt > at) &&
    (!subscription.pausedUntil || subscription.pausedUntil < at) &&
    (!subscription.trialEndsAt || subscription.trialEndsAt <= at),
  );
}

function isRealCancellation(subscription: SubscriptionForReport): boolean {
  if (!subscription.canceledAt) return false;
  const tierChange = subscription.flexBillingEvents.some(
    (event) =>
      (event.type === "UPGRADED" || event.type === "DOWNGRADED") &&
      event.completedAt,
  );
  const approvedReplacement = subscription.replacementSubscriptions.some(
    (replacement) => replacement.activatedAt,
  );
  return !tierChange && !approvedReplacement;
}

function latestLifecycleEventAt(install: InstallForReport, at: Date) {
  let latest: InstallForReport["lifecycleEvents"][number] | null = null;
  for (const event of install.lifecycleEvents) {
    if (event.occurredAt > at) break;
    latest = event;
  }
  return latest;
}

/** Exported so install-snapshot.server.ts's equivalence test can assert its
 * transition-based stock computation matches this predicate exactly — the
 * single source of truth for "is this install active at instant X". */
export function installIsActiveAt(install: InstallForReport, at: Date): boolean {
  const latest = latestLifecycleEventAt(install, at);
  if (latest) {
    return (
      latest.type === "INSTALLED" ||
      latest.type === "REINSTALLED" ||
      latest.type === "REACTIVATED"
    );
  }
  return (
    install.installedAt <= at &&
    (!install.uninstalledAt || install.uninstalledAt > at)
  );
}

function logoMovement(
  installs: InstallForReport[],
  start: Date,
  end: Date,
): { lost: number; recovered: number } {
  let lost = 0;
  let recovered = 0;
  for (const install of installs) {
    if (install.lifecycleEvents.length === 0) {
      if (
        install.uninstalledAt &&
        install.uninstalledAt >= start &&
        install.uninstalledAt < end
      ) {
        lost += 1;
      }
      continue;
    }
    for (const event of install.lifecycleEvents) {
      if (event.occurredAt < start || event.occurredAt >= end) continue;
      if (
        event.type === "UNINSTALLED" &&
        !event.uninstallDetail?.isStoreClosure
      ) {
        lost += 1;
      } else if (event.type === "REINSTALLED") {
        recovered += 1;
      }
      // DEACTIVATED/REACTIVATED are store lifecycle, not product churn.
    }
  }
  return { lost, recovered };
}

function envelope(range: ResolvedAnalyticsRange): ReportEnvelope {
  return {
    period: range.period,
    periodStart: range.start.toISOString(),
    periodEnd: range.end.toISOString(),
    interval: range.interval,
  };
}

function reportScope(organizationId: string, appId?: string) {
  return {
    app: {
      organizationId,
      ...(appId ? { id: appId } : {}),
    },
  };
}

async function findAllTimeStart(query: AnalyticsQuery): Promise<Date> {
  const scope = reportScope(query.organizationId, query.appId);
  const [install, subscription, charge, lifecycle] = await Promise.all([
    prisma.appInstall.findFirst({
      where: scope,
      orderBy: { installedAt: "asc" },
      select: { installedAt: true },
    }),
    prisma.subscription.findFirst({
      where: { appInstall: scope },
      orderBy: { activatedAt: "asc" },
      select: { activatedAt: true, createdAt: true },
    }),
    prisma.charge.findFirst({
      where: { subscription: { appInstall: scope } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    prisma.accountLifecycleEvent.findFirst({
      where: { appInstall: scope },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);
  const candidates = [
    install?.installedAt,
    subscription?.activatedAt ?? subscription?.createdAt,
    charge?.occurredAt,
    lifecycle?.occurredAt,
  ].filter((value): value is Date => Boolean(value));
  return candidates.length
    ? new Date(Math.min(...candidates.map((value) => value.getTime())))
    : (query.now ?? new Date());
}

/**
 * Relative periods ("Last 30 days", …) resolve their end to `new Date()`, which
 * carries millisecond precision. Every cache and deduplication key downstream is
 * built from that boundary, so an unquantized `now` mints a brand-new key on
 * every request and guarantees a miss — the exact failure already diagnosed and
 * fixed for the Traffic report (see `cacheBucketKey` in traffic-sources.server.ts).
 *
 * Flooring `now` to a whole minute makes two requests inside the same minute
 * resolve the *identical* range, so they share cache entries and in-flight
 * loads. Because the boundary itself moves (not just the key), the report
 * envelope and its bucket edges stay consistent with each other — a report is
 * never labelled with an end it was not actually computed for.
 *
 * The lag is invisible at this resolution: the finest supported interval is a
 * day, and the underlying Shopify facts only change when a sync writes them —
 * which is itself on a five-minute cadence.
 *
 * Kept deliberately equal to `RECURRING_CACHE_MS` in partner-mrr.server.ts. A
 * quantum shorter than that TTL mints a new key while the previous entry is
 * still live, so cached work expires unused; a longer one would serve a report
 * whose entry had already aged out. They are two halves of one decision — change
 * them together.
 */
export const RANGE_QUANTUM_MS = 5 * 60_000;

function quantize(now: Date): Date {
  return new Date(Math.floor(now.getTime() / RANGE_QUANTUM_MS) * RANGE_QUANTUM_MS);
}

/**
 * Resolve the report window once per request and pass the result to every
 * report function via their `suppliedRange` argument. Letting each function
 * resolve its own range re-reads `new Date()` per call, which silently splits
 * otherwise-identical loads across different cache keys.
 */
export async function resolveReportRange(
  query: AnalyticsQuery,
): Promise<ResolvedAnalyticsRange> {
  return rangeFor(query);
}

async function rangeFor(
  query: AnalyticsQuery,
): Promise<ResolvedAnalyticsRange> {
  const now = quantize(finiteDate(new Date(query.now ?? new Date()), "now"));
  if (query.start || query.end) {
    if (!query.start || !query.end) {
      throw new Error("Both start and end are required for a custom range");
    }
    const start = finiteDate(new Date(query.start), "start");
    const requestedEnd = finiteDate(new Date(query.end), "end");
    const end = requestedEnd > now ? now : requestedEnd;
    if (start >= end) throw new Error("Report start must be before end");
    return {
      period: query.period ?? "all_time",
      start,
      end,
      interval: capReportInterval(query.interval ?? autoInterval(start, end), start, end),
    };
  }
  const period = query.period ?? "last_30_days";
  const allTimeStart =
    period === "all_time" ? await findAllTimeStart(query) : undefined;
  const range = resolveAnalyticsRange(period, now, allTimeStart);
  if (!query.interval) return range;
  return {
    ...range,
    interval: capReportInterval(query.interval, range.start, range.end),
  };
}

/**
 * MySQL rejects a statement carrying more than 65,535 bound parameters.
 * Prisma resolves a nested relation `select`/`include` as a follow-up query
 * holding one placeholder per parent row, so an unbounded `findMany` over a
 * large table starts failing with P2029 ("query parameter limit ... exceeded")
 * as soon as the table outgrows that ceiling. That is not hypothetical: the
 * Shopify backfill took `app_installs` past 53k rows and every report 500'd.
 *
 * Keep pages well under the limit — the parent page size is only part of the
 * budget, since each nested relation's own filters bind parameters too.
 */
const RELATION_PAGE_SIZE = 10_000;

/**
 * `getAnalyticsReports` builds four reports concurrently, and three of them
 * independently call `loadInstalls`. A single request therefore issued the same
 * 77k-row / 192k-event read three or four times at once, multiplying both the
 * database work and peak memory — the dominant cost in a ~99s response.
 *
 * Collapse identical concurrent reads: the first caller performs the load and
 * the rest await its promise. The entry is dropped as soon as the load settles,
 * so nothing is retained between requests and no caller can observe stale data.
 * This is deduplication rather than caching, which keeps it consistent with the
 * rule that derived values are never persisted.
 */
const inFlightLoads = new Map<string, Promise<unknown>>();

function dedupeConcurrent<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inFlightLoads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = load().finally(() => {
    inFlightLoads.delete(key);
  });
  inFlightLoads.set(key, pending);
  return pending;
}

/** Stable key for a tenant-scoped, time-bounded load. */
function loadKey(
  kind: string,
  query: AnalyticsQuery,
  bounds: Array<Date | undefined>,
): string {
  return [
    kind,
    query.organizationId,
    query.appId ?? "*",
    ...bounds.map((bound) => bound?.getTime() ?? ""),
  ].join(":");
}

/**
 * Reads every row matching a query in primary-key-ordered pages, so no single
 * statement — including Prisma's nested relation queries — can exceed the
 * database's bound-parameter limit.
 *
 * Paging by `id` cursor rather than `skip`/`offset` keeps each page an
 * index-backed seek instead of a growing scan, and stays correct if rows are
 * inserted while the report runs.
 */
async function findManyPaged<T extends { id: string }>(
  fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor, RELATION_PAGE_SIZE);
    rows.push(...page);
    // A short page means the cursor reached the end. An exactly-full final page
    // costs one extra empty round trip, which is cheaper than risking a miss.
    if (page.length < RELATION_PAGE_SIZE) return rows;
    cursor = page[page.length - 1].id;
  }
}

async function loadSubscriptions(
  query: AnalyticsQuery,
  range: ResolvedAnalyticsRange,
): Promise<SubscriptionForReport[]> {
  return dedupeConcurrent(
    loadKey("subscriptions", query, [range.start, range.end]),
    () =>
      findManyPaged<SubscriptionForReport>(
        (cursor, take) =>
          prisma.subscription.findMany({
            where: {
              test: false,
              activatedAt: { lt: range.end },
              OR: [{ canceledAt: null }, { canceledAt: { gte: range.start } }],
              appInstall: reportScope(query.organizationId, query.appId),
            },
            include: {
              plan: true,
              discounts: { include: { discount: true } },
              flexBillingEvents: {
                where: {
                  type: { in: ["UPGRADED", "DOWNGRADED"] },
                  completedAt: { not: null },
                },
                select: { type: true, completedAt: true },
              },
              replacementSubscriptions: {
                select: { activatedAt: true },
              },
            },
            orderBy: { id: "asc" },
            take,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          }) as unknown as Promise<SubscriptionForReport[]>,
      ),
  );
}

/**
 * Opening-balance lifecycle event per install: the single latest event with
 * `occurredAt < windowStart`, one row per install, via a window function
 * joined through `app_installs`/`apps` for the same tenant scope
 * `reportScope` applies everywhere else (`AccountLifecycleEvent` has no
 * denormalized `appId`/`organizationId` of its own).
 *
 * Safe to bound this way — verified against every consumer of
 * `InstallForReport.lifecycleEvents` before this was built:
 * `installIsActiveAt`/`latestLifecycleEventAt` only ever need "the latest
 * event at or before instant X", never "the first event of a given type
 * ever" (unlike the analogous `activatedAt` case in
 * `partner-mrr-snapshot.server.ts`'s event bounding — there is no field here
 * that depends on an install's full lifecycle history). `logoMovement` and
 * the install time series only ever look at events strictly inside
 * `[windowStart, end)`, which the windowed fetch below covers directly.
 */
async function loadOpeningBalanceInstallEvents(
  organizationId: string,
  appId: string | undefined,
  windowStart: Date,
): Promise<Map<string, { id: string; type: string; occurredAt: Date }>> {
  const rows = await prisma.$queryRaw<
    Array<{ appInstallId: string; id: string; type: string; occurredAt: Date }>
  >`
    SELECT t.appInstallId, t.id, t.type, t.occurredAt
    FROM (
      SELECT e.appInstallId, e.id, e.type, e.occurredAt,
        ROW_NUMBER() OVER (
          PARTITION BY e.appInstallId
          ORDER BY e.occurredAt DESC, e.id DESC
        ) AS rn
      FROM account_lifecycle_events e
      INNER JOIN app_installs ai ON ai.id = e.appInstallId
      INNER JOIN apps a ON a.id = ai.appId
      WHERE a.organizationId = ${organizationId}
        AND (${appId ?? null} IS NULL OR a.id = ${appId ?? null})
        AND e.occurredAt < ${windowStart}
    ) t
    WHERE t.rn = 1
  `;
  return new Map(rows.map((row) => [row.appInstallId, row]));
}

async function loadInstalls(
  query: AnalyticsQuery,
  end: Date,
  lookbackStart?: Date,
  activeSince?: Date,
): Promise<InstallForReport[]> {
  // Paged: the nested `lifecycleEvents` select binds one placeholder per
  // install, so reading every install at once exceeded MySQL's parameter limit
  // once the backfill grew this table past ~53k rows.
  //
  // Deduplicated: portfolio, churn and LTV each ask for this same load inside
  // one `getAnalyticsReports` call, so without this the heaviest query in the
  // system ran three times concurrently per request.
  //
  // `activeSince` drops installs that cannot possibly matter to the caller's
  // report window: ones `uninstalledAt` shows as churned before that date, with
  // no reinstall/reactivation since (installLifecycleMirrorUpdate always clears
  // `uninstalledAt` back to null on RELATIONSHIP_INSTALLED/REACTIVATED, so a
  // stale, pre-window `uninstalledAt` is authoritative proof nothing about this
  // install changed during the window). It only bounds *which* installs load —
  // every count derived from the result is still exact, not sampled.
  //
  // `lookbackStart` bounds *how much of each remaining install's history*
  // loads: an opening-balance event (see `loadOpeningBalanceInstallEvents`)
  // plus everything from `lookbackStart` forward, instead of every lifecycle
  // event since the install's creation. Every report calling this today has a
  // natural window floor (`range.start`) to pass, so latency stops scaling
  // with account age and starts scaling with the report window instead.
  return dedupeConcurrent(
    loadKey("installs", query, [end, lookbackStart, activeSince]),
    async () => {
      const scope = reportScope(query.organizationId, query.appId);
      const [installs, openingBalanceByInstallId] = await Promise.all([
        findManyPaged<
          Omit<InstallForReport, "lifecycleEvents"> & {
            lifecycleEvents: Array<{
              id: string;
              type: string;
              occurredAt: Date;
            }>;
          }
        >((cursor, take) =>
          prisma.appInstall.findMany({
            where: {
              ...scope,
              ...(activeSince
                ? {
                    OR: [
                      { uninstalledAt: null },
                      { uninstalledAt: { gte: activeSince } },
                    ],
                  }
                : {}),
            },
            select: {
              id: true,
              installedAt: true,
              uninstalledAt: true,
              lifecycleEvents: {
                where: {
                  occurredAt: {
                    gte: lookbackStart ?? undefined,
                    lt: end,
                  },
                },
                orderBy: { occurredAt: "asc" },
                // `id` only, not the nested `uninstallDetail` relation — that
                // relation binds one placeholder per *event*, not per install
                // (10k installs can easily carry 100k+ events), which is both
                // wasted work (only read for UNINSTALLED events) and a latent
                // return of the same P2029 bound-parameter error this function's
                // own pagination exists to prevent. Fetched as one flat,
                // fixed-size query below instead and merged in.
                select: {
                  id: true,
                  type: true,
                  occurredAt: true,
                },
              },
            },
            orderBy: { id: "asc" },
            take,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          }),
        ),
        lookbackStart
          ? loadOpeningBalanceInstallEvents(
              query.organizationId,
              query.appId,
              lookbackStart,
            )
          : Promise.resolve(new Map<string, { id: string; type: string; occurredAt: Date }>()),
      ]);

      // Filtered by the same fixed date/scope bounds used for `lifecycleEvents`
      // above, not by an ID list — an `eventId: { in: [...] }` here would just
      // move the same per-row placeholder scaling problem to a second query.
      // The opening-balance event never needs this: `logoMovement` (the only
      // consumer of `uninstallDetail`) only ever looks at events strictly
      // inside `[lookbackStart, end)`, and the opening balance is by
      // definition from before that window.
      const isStoreClosureByEventId = new Map<string, boolean>();
      const details = await prisma.uninstallEventDetail.findMany({
        where: {
          event: {
            type: "UNINSTALLED",
            occurredAt: {
              gte: lookbackStart ?? undefined,
              lt: end,
            },
            appInstall: scope,
          },
        },
        select: { eventId: true, isStoreClosure: true },
      });
      for (const detail of details) {
        isStoreClosureByEventId.set(detail.eventId, detail.isStoreClosure);
      }

      return installs.map((install) => {
        const openingBalance = openingBalanceByInstallId.get(install.id);
        const lifecycleEvents = openingBalance
          ? [openingBalance, ...install.lifecycleEvents]
          : install.lifecycleEvents;
        return {
          ...install,
          lifecycleEvents: lifecycleEvents.map((event) => ({
            type: event.type,
            occurredAt: event.occurredAt,
            uninstallDetail: isStoreClosureByEventId.has(event.id)
              ? { isStoreClosure: isStoreClosureByEventId.get(event.id)! }
              : null,
          })),
        };
      });
    },
  );
}

function mrrAt(
  subscriptions: SubscriptionForReport[],
  at: Date,
  test: boolean = false,
): Map<string, { mrr: number; installIds: Set<string> }> {
  const values = new Map<string, { mrr: number; installIds: Set<string> }>();
  for (const subscription of subscriptions) {
    if (!subscriptionIsLiveAt(subscription, at, test)) continue;
    const currency = subscription.plan.currencyCode;
    const current = values.get(currency) ?? { mrr: 0, installIds: new Set() };
    current.mrr += monthlyRecurringAmount(
      subscription.plan,
      subscription.discounts,
      at,
    );
    current.installIds.add(subscription.appInstallId);
    values.set(currency, current);
  }
  return values;
}

/**
 * Same live/trial classification as `mrrAt` + the portfolio bucket loop's own
 * trial/active filters, but in one pass over `subscriptions` instead of three
 * (mrrAt, a trial `.filter().reduce()`, and an active `.filter()`). Called
 * once per bucket, so at O(buckets) call sites this turns O(buckets ×
 * currencies × subscriptions) into O(buckets × subscriptions) — the portfolio
 * report's dominant cost at wide periods (see REPORTS-PERFORMANCE-AUDIT.md
 * item F).
 */
function recurringStatsAt(
  subscriptions: SubscriptionForReport[],
  at: Date,
): Map<
  string,
  {
    mrr: number;
    installIds: Set<string>;
    trialSubscriptions: number;
    activeSubscriptions: number;
  }
> {
  const values = new Map<
    string,
    {
      mrr: number;
      installIds: Set<string>;
      trialSubscriptions: number;
      activeSubscriptions: number;
    }
  >();
  const ensure = (currency: string) => {
    let current = values.get(currency);
    if (!current) {
      current = {
        mrr: 0,
        installIds: new Set<string>(),
        trialSubscriptions: 0,
        activeSubscriptions: 0,
      };
      values.set(currency, current);
    }
    return current;
  };
  for (const subscription of subscriptions) {
    if (subscription.test) continue;
    const currency = subscription.plan.currencyCode;
    const isOnTrial = Boolean(
      subscription.activatedAt &&
        subscription.activatedAt <= at &&
        subscription.trialEndsAt &&
        subscription.trialEndsAt > at &&
        (!subscription.canceledAt || subscription.canceledAt > at) &&
        (!subscription.frozenAt || subscription.frozenAt > at) &&
        (!subscription.pausedUntil || subscription.pausedUntil < at),
    );
    if (isOnTrial) {
      ensure(currency).trialSubscriptions += monthlyRecurringAmount(
        subscription.plan,
        subscription.discounts,
        at,
      );
      continue;
    }
    if (!subscriptionIsLiveAt(subscription, at)) continue;
    const current = ensure(currency);
    current.activeSubscriptions += 1;
    current.mrr += monthlyRecurringAmount(
      subscription.plan,
      subscription.discounts,
      at,
    );
    current.installIds.add(subscription.appInstallId);
  }
  return values;
}

/** Current stock value used by both the dashboard overview and report screens. */
export async function getCurrentMrrByCurrency(params: {
  organizationId: string;
  appId?: string;
  at?: Date;
  /** Test subscriptions are shown separately and never mixed into live MRR. */
  dataSet?: "live" | "test";
}): Promise<Array<{ currency: string; mrr: number }>> {
  const at = finiteDate(new Date(params.at ?? new Date()), "at");
  const test = params.dataSet === "test";
  // Paged for the same reason as loadSubscriptions: the nested includes bind a
  // placeholder per subscription, so this would start throwing P2029 once the
  // table outgrows MySQL's limit.
  const subscriptions = await findManyPaged<SubscriptionForReport>(
    (cursor, take) =>
      prisma.subscription.findMany({
        where: {
          ...subscriptionAsOfWhere(params.organizationId, at, params.appId),
          test,
        },
        include: {
          plan: true,
          discounts: { include: { discount: true } },
          flexBillingEvents: {
            select: { type: true, completedAt: true },
          },
          replacementSubscriptions: {
            select: { activatedAt: true },
          },
        },
        orderBy: { id: "asc" },
        take,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }) as unknown as Promise<SubscriptionForReport[]>,
  );
  return [...mrrAt(subscriptions, at, test).entries()]
    .map(([currency, value]) => ({ currency, mrr: round(value.mrr) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function getRevenueReport(
  query: AnalyticsQuery,
  suppliedRange?: ResolvedAnalyticsRange,
): Promise<RevenueReport> {
  const range = suppliedRange ?? (await rangeFor(query));
  const buckets = buildUtcBuckets(range);
  const charges = await prisma.charge.findMany({
    where: {
      status: "ACTIVE",
      occurredAt: { gte: range.start, lt: range.end },
      subscription: {
        test: false,
        appInstall: reportScope(query.organizationId, query.appId),
      },
    },
    select: {
      chargedAmount: true,
      chargedCurrencyCode: true,
      isCredit: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: "asc" },
  });

  const currencies = [
    ...new Set(charges.map((charge) => charge.chargedCurrencyCode)),
  ]
    .sort()
    .map((currency): RevenueCurrencyReport => {
      const currencyCharges = charges.filter(
        (charge) => charge.chargedCurrencyCode === currency,
      );
      const timeSeries = buckets.map((bucket): RevenuePoint => {
        let gross = 0;
        let credits = 0;
        for (const charge of currencyCharges) {
          if (
            charge.occurredAt < bucket.start ||
            charge.occurredAt >= bucket.end
          ) {
            continue;
          }
          if (charge.isCredit) credits += Number(charge.chargedAmount);
          else gross += Number(charge.chargedAmount);
        }
        return {
          periodStart: bucket.start.toISOString(),
          periodEnd: bucket.end.toISOString(),
          gross: round(gross),
          credits: round(credits),
          net: round(gross - credits),
          provisional: bucket.provisional,
        };
      });
      const gross = timeSeries.reduce((sum, point) => sum + point.gross, 0);
      const credits = timeSeries.reduce((sum, point) => sum + point.credits, 0);
      return {
        currency,
        value: {
          gross: round(gross),
          credits: round(credits),
          net: round(gross - credits),
        },
        timeSeries,
      };
    });

  return { ...envelope(range), currencies };
}

// ---------------------------------------------------------------------------
// Install-snapshot read path (PartnerDailyInstallSnapshot). Strictly
// additive: `INSTALL_SNAPSHOT_READ_PATH_ENABLED` off, or readiness not
// applied, reproduces today's live `loadInstalls`-based computation
// byte-for-byte. See docs/plan for the full design; `retention` cohorts are
// deliberately excluded (stay live — see `loadInstallsForRetention` below).
// ---------------------------------------------------------------------------

interface InstallSnapshotAppState {
  id: string;
  installSnapshotFloorDate: Date | null;
  installSnapshotDirtyFrom: Date | null;
}

interface InstallSnapshotReadiness {
  applied: boolean;
  appIds: string[];
}

interface DailyInstallTotals extends DailyInstallStock, DailyInstallFlow {}

function emptyInstallTotals(): DailyInstallTotals {
  return {
    activeInstallsAtDayStart: 0,
    activeInstallsAtDayEnd: 0,
    newInstalls: 0,
    uninstallsAll: 0,
    logoLost: 0,
    logoRecovered: 0,
    reactivations: 0,
    deactivations: 0,
  };
}

function addInstallTotals(target: DailyInstallTotals, row: DailyInstallTotals): void {
  target.activeInstallsAtDayStart += row.activeInstallsAtDayStart;
  target.activeInstallsAtDayEnd += row.activeInstallsAtDayEnd;
  target.newInstalls += row.newInstalls;
  target.uninstallsAll += row.uninstallsAll;
  target.logoLost += row.logoLost;
  target.logoRecovered += row.logoRecovered;
  target.reactivations += row.reactivations;
  target.deactivations += row.deactivations;
}

/** All enabled, non-removed apps in scope — the same population `loadInstalls`
 * et al. read via `reportScope`, resolved to concrete ids because the
 * snapshot readiness check needs to know exactly which apps must each have a
 * complete row set, not just a Prisma where-fragment. */
async function resolveScopeAppIds(query: AnalyticsQuery): Promise<string[]> {
  if (query.appId) return [query.appId];
  const apps = await prisma.app.findMany({
    where: {
      organizationId: query.organizationId,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
    },
    select: { id: true },
  });
  return apps.map((app) => app.id);
}

/**
 * Pure completeness check, unit-testable without a live database. Mirrors
 * `evaluateSnapshotCompleteness` (the MRR snapshot's own version) in shape —
 * all-or-nothing across every app in scope — with two install-specific
 * additions: a day before an app's `installSnapshotFloorDate` is
 * covered-with-zero rather than missing (no install can exist before an
 * app's own history starts), and any app with `installSnapshotDirtyFrom` set
 * and before `rangeEndExclusive` disqualifies the whole scope outright — a
 * dirty stock must never be served, unlike a merely-missing day.
 */
function evaluateInstallSnapshotCompleteness(params: {
  apps: InstallSnapshotAppState[];
  rangeStart: Date;
  rangeEndExclusive: Date;
  coveredDaysByApp: Map<string, Set<number>>;
}): InstallSnapshotReadiness {
  const { apps, rangeStart, rangeEndExclusive, coveredDaysByApp } = params;
  const appIds = apps.map((app) => app.id);
  if (apps.length === 0) return { applied: false, appIds };
  if (rangeEndExclusive.getTime() <= rangeStart.getTime()) {
    // The whole requested range is "today" or later — nothing a snapshot
    // could ever cover; the live top-up path handles this instead.
    return { applied: false, appIds };
  }
  // Every boundary the caller will point-read a stock value at must be an
  // exact UTC midnight, or that read would silently target the wrong
  // instant — a custom (non-preset) date range is the one place this can
  // fail (see the plan's Phase 4 note on this exact risk).
  if (
    startOfUtcDay(rangeStart).getTime() !== rangeStart.getTime() ||
    startOfUtcDay(rangeEndExclusive).getTime() !== rangeEndExclusive.getTime()
  ) {
    return { applied: false, appIds };
  }

  for (const app of apps) {
    if (
      app.installSnapshotDirtyFrom &&
      app.installSnapshotDirtyFrom.getTime() < rangeEndExclusive.getTime()
    ) {
      return { applied: false, appIds };
    }
    const covered = coveredDaysByApp.get(app.id);
    for (
      let day = rangeStart;
      day.getTime() < rangeEndExclusive.getTime();
      day = new Date(day.getTime() + 86_400_000)
    ) {
      if (
        app.installSnapshotFloorDate &&
        day.getTime() < app.installSnapshotFloorDate.getTime()
      ) {
        continue;
      }
      if (!covered?.has(day.getTime())) return { applied: false, appIds };
    }
  }
  return { applied: true, appIds };
}

/** Thin async wrapper: resolves per-app floor/dirty state, queries the
 * (tiny) snapshot rows for the window, and delegates to the pure check. */
async function installSnapshotReadiness(
  appIds: string[],
  rangeStart: Date,
  rangeEndExclusive: Date,
): Promise<InstallSnapshotReadiness> {
  if (appIds.length === 0 || rangeEndExclusive.getTime() <= rangeStart.getTime()) {
    return { applied: false, appIds };
  }
  const [apps, rows] = await Promise.all([
    prisma.app.findMany({
      where: { id: { in: appIds } },
      select: {
        id: true,
        installSnapshotFloorDate: true,
        installSnapshotDirtyFrom: true,
      },
    }),
    prisma.partnerDailyInstallSnapshot.findMany({
      where: {
        appId: { in: appIds },
        snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
      },
      select: { appId: true, snapshotDate: true },
    }),
  ]);
  if (apps.length !== appIds.length) return { applied: false, appIds };

  const coveredDaysByApp = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = coveredDaysByApp.get(row.appId) ?? new Set<number>();
    set.add(row.snapshotDate.getTime());
    coveredDaysByApp.set(row.appId, set);
  }
  return evaluateInstallSnapshotCompleteness({
    apps,
    rangeStart,
    rangeEndExclusive,
    coveredDaysByApp,
  });
}

async function readInstallSnapshotDailyTotals(
  appIds: string[],
  rangeStart: Date,
  rangeEndExclusive: Date,
): Promise<Map<number, DailyInstallTotals>> {
  const byDay = new Map<number, DailyInstallTotals>();
  if (rangeEndExclusive.getTime() <= rangeStart.getTime()) return byDay;
  const rows = await prisma.partnerDailyInstallSnapshot.findMany({
    where: {
      appId: { in: appIds },
      snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
    },
  });
  for (const row of rows) {
    const key = row.snapshotDate.getTime();
    const totals = byDay.get(key) ?? emptyInstallTotals();
    addInstallTotals(totals, row);
    byDay.set(key, totals);
  }
  return byDay;
}

/**
 * How long a single app's live-computed "today" row is reused before
 * `computeDirtyRangeSnapshotRows` reruns for it. Does NOT weaken the "today
 * is never trusted from the persisted table" rule — that rule is about not
 * reading a stale *persisted* row, not about forbidding a cache in front of
 * the live computation. Mirrors the exact same trade-off already accepted
 * for the MRR snapshot's `facts:` cache (partner-mrr.server.ts): a number
 * can trail "just happened" by up to this TTL, which is fine for an
 * internal dashboard. Kept equal to `RANGE_QUANTUM_MS` for the same reason
 * that constant is shared elsewhere — no point caching finer than the grid
 * every report request's own range already rounds to.
 *
 * Added 2026-08-18: found in production that this recomputed from scratch —
 * a touched-install scan plus per-install event fold — on every single
 * request with zero caching, dominating `getPortfolioReport`'s cost for the
 * account's largest apps (measured 850-1200ms for the biggest app, out of a
 * ~1s total) even though installs/events rarely change meaningfully between
 * two requests seconds apart.
 */
const INSTALL_TODAY_LIVE_TOP_UP_CACHE_MS = RANGE_QUANTUM_MS;

/**
 * Persisted days for `[rangeStart, todayStart)` plus a live-computed "today"
 * row per app, anchored on yesterday's persisted `activeInstallsAtDayEnd`
 * and folded via the exact same touched-install logic the writer itself
 * uses (`computeDirtyRangeSnapshotRows`) rather than a full account scan.
 * This is what actually fills the "today" gap instead of silently reading it
 * as zero/stale — the bug this table's plan explicitly avoided repeating
 * from the MRR snapshot's read path.
 */
async function readInstallSnapshotWithLiveTopUp(
  appIds: string[],
  rangeStart: Date,
  rangeEndExclusive: Date,
  now: Date,
): Promise<Map<number, DailyInstallTotals>> {
  const todayStart = startOfUtcDay(now);
  const persistedEnd =
    rangeEndExclusive.getTime() < todayStart.getTime()
      ? rangeEndExclusive
      : todayStart;
  const totals = await readInstallSnapshotDailyTotals(appIds, rangeStart, persistedEnd);
  if (rangeEndExclusive.getTime() <= todayStart.getTime()) return totals;

  const yesterday = new Date(todayStart.getTime() - 86_400_000);
  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
  const anchorRows = await prisma.partnerDailyInstallSnapshot.findMany({
    where: { appId: { in: appIds }, snapshotDate: yesterday },
    select: { appId: true, activeInstallsAtDayEnd: true },
  });
  const anchorByApp = new Map(anchorRows.map((row) => [row.appId, row.activeInstallsAtDayEnd]));

  const todayRowsPerApp = await Promise.all(
    appIds.map((appId) =>
      cachedWithRedis(
        `install-today:${JSON.stringify({ appId, todayStart: todayStart.toISOString() })}`,
        INSTALL_TODAY_LIVE_TOP_UP_CACHE_MS,
        () =>
          computeDirtyRangeSnapshotRows(
            appId,
            todayStart,
            tomorrowStart,
            anchorByApp.get(appId) ?? 0,
            null,
          ),
      ),
    ),
  );
  const today = emptyInstallTotals();
  for (const rows of todayRowsPerApp) {
    if (rows[0]) addInstallTotals(today, rows[0]);
  }
  totals.set(todayStart.getTime(), today);
  return totals;
}

function sumInstallFlowOverDays(
  totals: Map<number, DailyInstallTotals>,
  start: Date,
  endExclusive: Date,
): DailyInstallFlow {
  const sum: DailyInstallFlow = {
    newInstalls: 0,
    uninstallsAll: 0,
    logoLost: 0,
    logoRecovered: 0,
    reactivations: 0,
    deactivations: 0,
  };
  for (
    let day = startOfUtcDay(start);
    day.getTime() < endExclusive.getTime();
    day = new Date(day.getTime() + 86_400_000)
  ) {
    const row = totals.get(day.getTime());
    if (!row) continue;
    sum.newInstalls += row.newInstalls;
    sum.uninstallsAll += row.uninstallsAll;
    sum.logoLost += row.logoLost;
    sum.logoRecovered += row.logoRecovered;
    sum.reactivations += row.reactivations;
    sum.deactivations += row.deactivations;
  }
  return sum;
}

function stockAtDayStart(totals: Map<number, DailyInstallTotals>, at: Date): number {
  return totals.get(startOfUtcDay(at).getTime())?.activeInstallsAtDayStart ?? 0;
}

function stockAtDayEnd(totals: Map<number, DailyInstallTotals>, at: Date): number {
  return totals.get(startOfUtcDay(at).getTime())?.activeInstallsAtDayEnd ?? 0;
}

/**
 * Retention cohorts stay live by design (see the plan) — the obvious
 * shortcut (`uninstalledAt IS NULL`) measurably overstates retention on real
 * data. But the population this needs is much narrower than the full
 * `loadInstalls` result: only installs whose `installedAt` falls inside the
 * report window itself (every call site already filters for exactly this).
 * When the snapshot covers everything else `getPortfolioReport` computes,
 * this is the only live install read left in that function.
 */
async function loadInstallsForRetention(
  query: AnalyticsQuery,
  range: ResolvedAnalyticsRange,
): Promise<InstallForReport[]> {
  const scope = reportScope(query.organizationId, query.appId);
  return findManyPaged<InstallForReport>((cursor, take) =>
    prisma.appInstall
      .findMany({
        where: { ...scope, installedAt: { gte: range.start, lt: range.end } },
        select: {
          id: true,
          installedAt: true,
          uninstalledAt: true,
          lifecycleEvents: {
            where: { occurredAt: { lt: range.end } },
            orderBy: { occurredAt: "asc" },
            select: { type: true, occurredAt: true },
          },
        },
        orderBy: { id: "asc" },
        take,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          lifecycleEvents: row.lifecycleEvents.map((event) => ({
            ...event,
            uninstallDetail: null,
          })),
        })),
      ),
  );
}

export async function getChurnReport(
  query: AnalyticsQuery,
  suppliedRange?: ResolvedAnalyticsRange,
): Promise<ChurnReport> {
  const range = suppliedRange ?? (await rangeFor(query));
  const buckets = buildUtcBuckets(range);

  const snapshotAppIds = env.INSTALL_SNAPSHOT_READ_PATH_ENABLED
    ? await resolveScopeAppIds(query)
    : [];
  const todayStart = startOfUtcDay(new Date());
  const snapshotReadiness = snapshotAppIds.length
    ? await installSnapshotReadiness(
        snapshotAppIds,
        range.start,
        range.end.getTime() < todayStart.getTime() ? range.end : todayStart,
      )
    : { applied: false, appIds: snapshotAppIds };

  const [subscriptions, installs, snapshotTotals] = await Promise.all([
    loadSubscriptions(query, range),
    // `range.start` as both the window floor AND `activeSince`: an
    // opening-balance event per install (see `loadOpeningBalanceInstallEvents`)
    // keeps the first bucket's active-install denominator exactly as knowable
    // as reading full history would, without actually reading it. Passing the
    // same `activeSince` `getPortfolioReport` uses is required, not just an
    // optimization — `loadKey`'s dedupe cache key includes `activeSince`, so a
    // mismatched value here used to mint a different key and silently defeat
    // `dedupeConcurrent` whenever this ran alongside `getPortfolioReport` in
    // the same `getAnalyticsReports` request (the `metric=all` case), each
    // paying for its own full, undeduped `loadInstalls` load. Safe for the
    // same reason it's safe there: an install `activeSince` proves unchanged
    // since can't have contributed any lost/recovered event inside this
    // report's own window either.
    //
    // Skipped entirely when the install snapshot covers this report — `logo`
    // is the only thing in this function that ever reads `installs`.
    snapshotReadiness.applied
      ? Promise.resolve<InstallForReport[]>([])
      : loadInstalls(query, range.end, range.start, range.start),
    snapshotReadiness.applied
      ? readInstallSnapshotWithLiveTopUp(
          snapshotAppIds,
          range.start,
          range.end,
          new Date(),
        )
      : Promise.resolve(null),
  ]);

  const logoTimeSeries = buckets.map((bucket): CountChurnPoint => {
    if (snapshotTotals) {
      const denominator = stockAtDayStart(snapshotTotals, bucket.start);
      const flow = sumInstallFlowOverDays(snapshotTotals, bucket.start, bucket.end);
      const netLost = flow.logoLost - flow.logoRecovered;
      return {
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        lost: flow.logoLost,
        recovered: flow.logoRecovered,
        netLost,
        denominator,
        rate: rate(netLost, denominator),
        provisional: bucket.provisional,
      };
    }
    const denominator = installs.filter((install) =>
      installIsActiveAt(install, bucket.start),
    ).length;
    const { lost, recovered } = logoMovement(
      installs,
      bucket.start,
      bucket.end,
    );
    const netLost = lost - recovered;
    return {
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      lost,
      recovered,
      netLost,
      denominator,
      rate: rate(netLost, denominator),
      provisional: bucket.provisional,
    };
  });

  const realCancellations = subscriptions.filter(isRealCancellation);
  const subscriptionTimeSeries = buckets.map((bucket): CountChurnPoint => {
    const denominator = subscriptions.filter((subscription) =>
      subscriptionIsLiveAt(subscription, bucket.start),
    ).length;
    const lost = realCancellations.filter(
      (subscription) =>
        subscription.canceledAt &&
        subscription.canceledAt >= bucket.start &&
        subscription.canceledAt < bucket.end,
    ).length;
    return {
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      lost,
      recovered: 0,
      netLost: lost,
      denominator,
      rate: rate(lost, denominator),
      provisional: bucket.provisional,
    };
  });

  const revenueCurrencies = [
    ...new Set(
      subscriptions.map((subscription) => subscription.plan.currencyCode),
    ),
  ]
    .sort()
    .map((currency): RevenueChurnCurrencyReport => {
      const timeSeries = buckets.map((bucket): RevenueChurnPoint => {
        const startMrr =
          mrrAt(subscriptions, bucket.start).get(currency)?.mrr ?? 0;
        let lostMrr = 0;
        for (const subscription of realCancellations) {
          if (
            subscription.plan.currencyCode !== currency ||
            !subscription.canceledAt ||
            subscription.canceledAt < bucket.start ||
            subscription.canceledAt >= bucket.end
          ) {
            continue;
          }
          lostMrr += monthlyRecurringAmount(
            subscription.plan,
            subscription.discounts,
            new Date(subscription.canceledAt.getTime() - 1),
          );
        }
        return {
          periodStart: bucket.start.toISOString(),
          periodEnd: bucket.end.toISOString(),
          lostMrr: round(lostMrr),
          startMrr: round(startMrr),
          rate: rate(lostMrr, startMrr),
          provisional: bucket.provisional,
        };
      });
      const startMrr =
        mrrAt(subscriptions, range.start).get(currency)?.mrr ?? 0;
      const lostMrr = timeSeries.reduce((sum, point) => sum + point.lostMrr, 0);
      return {
        currency,
        value: {
          lostMrr: round(lostMrr),
          startMrr: round(startMrr),
          rate: rate(lostMrr, startMrr),
        },
        timeSeries,
      };
    });

  const logoDenominator = snapshotTotals
    ? stockAtDayStart(snapshotTotals, range.start)
    : installs.filter((install) => installIsActiveAt(install, range.start))
        .length;
  const logoNet = logoTimeSeries.reduce((sum, point) => sum + point.netLost, 0);
  const subscriptionDenominator = subscriptions.filter((subscription) =>
    subscriptionIsLiveAt(subscription, range.start),
  ).length;
  const subscriptionNet = subscriptionTimeSeries.reduce(
    (sum, point) => sum + point.netLost,
    0,
  );

  return {
    ...envelope(range),
    logo: {
      value: rate(logoNet, logoDenominator),
      netLost: logoNet,
      denominator: logoDenominator,
      timeSeries: logoTimeSeries,
    },
    subscription: {
      value: rate(subscriptionNet, subscriptionDenominator),
      netLost: subscriptionNet,
      denominator: subscriptionDenominator,
      timeSeries: subscriptionTimeSeries,
    },
    grossRevenue: { currencies: revenueCurrencies },
  };
}

export async function getLtvReport(
  query: AnalyticsQuery,
  suppliedRange?: ResolvedAnalyticsRange,
): Promise<LtvReport> {
  const range = suppliedRange ?? (await rangeFor(query));
  const buckets = buildUtcBuckets(range);
  // LTV needs a rolling 30-day churn window before each visible point.
  const earliestRollingStart = new Date(
    range.start.getTime() - 30 * 86_400_000,
  );
  const subscriptionRange = {
    ...range,
    start: earliestRollingStart,
  };

  const snapshotAppIds = env.INSTALL_SNAPSHOT_READ_PATH_ENABLED
    ? await resolveScopeAppIds(query)
    : [];
  const todayStart = startOfUtcDay(new Date());
  // The rolling window reaches back 30 days before every visible bucket, so
  // the earliest possible read is `range.start - 30d`, not `range.start`.
  const snapshotReadiness = snapshotAppIds.length
    ? await installSnapshotReadiness(
        snapshotAppIds,
        earliestRollingStart,
        range.end.getTime() < todayStart.getTime() ? range.end : todayStart,
      )
    : { applied: false, appIds: snapshotAppIds };

  const [subscriptions, installs, snapshotTotals] = await Promise.all([
    loadSubscriptions(query, subscriptionRange),
    // `activeSince: range.start` matches `getChurnReport`/`getPortfolioReport`
    // exactly — see the comment on the `getChurnReport` call site for why
    // this must be identical, not just similarly-shaped, across all three
    // `loadInstalls` callers. Skipped entirely once the snapshot covers the
    // full rolling-window range this report's logo-churn fallback needs.
    snapshotReadiness.applied
      ? Promise.resolve<InstallForReport[]>([])
      : loadInstalls(query, range.end, range.start, range.start),
    snapshotReadiness.applied
      ? readInstallSnapshotWithLiveTopUp(
          snapshotAppIds,
          earliestRollingStart,
          range.end,
          new Date(),
        )
      : Promise.resolve(null),
  ]);
  const currencies = [
    ...new Set(
      subscriptions.map((subscription) => subscription.plan.currencyCode),
    ),
  ].sort();
  const recurringTimeSeries: RecurringPoint[] = [];
  for (const bucket of buckets) {
    const at = bucket.end;
    const byCurrency = mrrAt(subscriptions, at);
    for (const currency of currencies) {
      const current = byCurrency.get(currency);
      const mrr = round(current?.mrr ?? 0);
      const activeSubscriptions = subscriptions.filter(
        (subscription) =>
          subscription.plan.currencyCode === currency &&
          subscriptionIsLiveAt(subscription, at),
      ).length;
      recurringTimeSeries.push({
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        currency,
        monthlySubscriptions: mrr,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: 0,
        mrr,
        arr: round(mrr * 12),
        activeSubscriptions,
        activeCustomers: current?.installIds.size ?? 0,
        provisional: bucket.provisional,
      });
    }
  }

  return buildLtvReportFromRecurring(
    range,
    recurringTimeSeries,
    snapshotTotals ? logoChurnAtFromSnapshot(snapshotTotals) : logoChurnAtFromInstalls(installs),
  );
}

interface LogoChurnWindow {
  denominator: number;
  lost: number;
  recovered: number;
}

function logoChurnAtFromInstalls(
  installs: InstallForReport[],
): (rollingStart: Date, at: Date) => LogoChurnWindow {
  return (rollingStart, at) => {
    const denominator = installs.filter((install) =>
      installIsActiveAt(install, rollingStart),
    ).length;
    const movement = logoMovement(installs, rollingStart, at);
    return { denominator, lost: movement.lost, recovered: movement.recovered };
  };
}

/**
 * Same rolling-window shape as `logoChurnAtFromInstalls`, sourced from the
 * install snapshot instead. `rollingStart`/`at` land on exact UTC midnight
 * for every non-provisional bucket (30 days is a whole number of days), so
 * the day-level stock/flow reads are exact there; for the one provisional
 * bucket (`at` = "now"), `rollingStart` is rounded down to its containing
 * day by `stockAtDayStart` — a deliberate, bounded (<24h) approximation for
 * that single bucket, not a general read-path shortcut.
 */
function logoChurnAtFromSnapshot(
  totals: Map<number, DailyInstallTotals>,
): (rollingStart: Date, at: Date) => LogoChurnWindow {
  return (rollingStart, at) => {
    const denominator = stockAtDayStart(totals, rollingStart);
    const flow = sumInstallFlowOverDays(totals, rollingStart, at);
    return { denominator, lost: flow.logoLost, recovered: flow.logoRecovered };
  };
}

function buildLtvReportFromRecurring(
  range: ResolvedAnalyticsRange,
  recurringTimeSeries: RecurringPoint[],
  logoChurnAt: (rollingStart: Date, at: Date) => LogoChurnWindow,
): LtvReport {
  const currencies = [
    ...new Set(recurringTimeSeries.map((point) => point.currency)),
  ].sort();
  const reportCurrencies = currencies.map((currency): LtvCurrencyReport => {
    const timeSeries = recurringTimeSeries
      .filter((point) => point.currency === currency)
      .map((point): LtvPoint => {
        const at = new Date(point.periodEnd);
        // Trials are useful as a separate forecast component, but ARPU/LTV use
        // paid recurring revenue and paid subscriptions only.
        const mrr = round(
          point.monthlySubscriptions +
            point.annualSubscriptions +
            point.usageCharges,
        );
        // Mantle's ARPU population is the active paid subscription population,
        // not distinct shops. This also keeps numerator and denominator on the
        // same Shopify charge lifecycle.
        const activeSubscriptions = point.activeSubscriptions;
        const arpu = activeSubscriptions > 0 ? mrr / activeSubscriptions : 0;
        const hasSubscriptionChurn = point.monthlySubscriptionChurnRate != null;
        let monthlyChurnRate = point.monthlySubscriptionChurnRate ?? 0;
        let churnBasis: LtvPoint["churnBasis"] = "subscription";

        // Local reports without Partner charge history retain the install-state
        // fallback. Partner reports always use the paid charge state machine.
        if (!hasSubscriptionChurn) {
          const rollingStart = new Date(at.getTime() - 30 * 86_400_000);
          const { denominator, lost, recovered } = logoChurnAt(rollingStart, at);
          monthlyChurnRate = rate(Math.max(0, lost - recovered), denominator);
          churnBasis = "logo";
        }
        return {
          periodStart: point.periodStart,
          periodEnd: point.periodEnd,
          value: monthlyChurnRate > 0 ? round(arpu / monthlyChurnRate) : null,
          arpu: round(arpu),
          mrr,
          activeSubscriptions,
          monthlyChurnRate,
          churnBasis,
          provisional: point.provisional,
        };
      });
    const latest = timeSeries.at(-1) ?? {
      value: null,
      arpu: 0,
      mrr: 0,
      activeSubscriptions: 0,
      monthlyChurnRate: 0,
      churnBasis: "subscription" as const,
    };
    return {
      currency,
      value: latest.value,
      arpu: latest.arpu,
      mrr: latest.mrr,
      activeSubscriptions: latest.activeSubscriptions,
      monthlyChurnRate: latest.monthlyChurnRate,
      churnBasis: latest.churnBasis,
      timeSeries,
    };
  });

  return { ...envelope(range), currencies: reportCurrencies };
}

/**
 * Calculates LTV from an externally reconstructed recurring-revenue series
 * (for example the persisted Shopify Partner lifecycle). The formula and churn
 * predicate stay shared with the local subscription implementation above.
 */
export async function getLtvReportFromRecurring(
  query: AnalyticsQuery,
  recurring: PortfolioReport["recurring"],
  suppliedRange?: ResolvedAnalyticsRange,
): Promise<LtvReport> {
  const range = suppliedRange ?? (await rangeFor(query));
  // `buildLtvReportFromRecurring` only touches installs for its logo-churn
  // fallback, which is dead whenever the series already carries a paid
  // subscription churn rate — i.e. always, for the Shopify Partner lifecycle.
  // Loading them unconditionally made the heaviest query in the system run on
  // every LTV request purely to be filtered out again.
  const needsInstalls = recurring.timeSeries.some(
    (point) => point.monthlySubscriptionChurnRate == null,
  );
  if (!needsInstalls) {
    return buildLtvReportFromRecurring(
      range,
      recurring.timeSeries,
      logoChurnAtFromInstalls([]),
    );
  }

  const earliestRollingStart = new Date(range.start.getTime() - 30 * 86_400_000);
  const snapshotAppIds = env.INSTALL_SNAPSHOT_READ_PATH_ENABLED
    ? await resolveScopeAppIds(query)
    : [];
  const todayStart = startOfUtcDay(new Date());
  const snapshotReadiness = snapshotAppIds.length
    ? await installSnapshotReadiness(
        snapshotAppIds,
        earliestRollingStart,
        range.end.getTime() < todayStart.getTime() ? range.end : todayStart,
      )
    : { applied: false, appIds: snapshotAppIds };

  if (snapshotReadiness.applied) {
    const snapshotTotals = await readInstallSnapshotWithLiveTopUp(
      snapshotAppIds,
      earliestRollingStart,
      range.end,
      new Date(),
    );
    return buildLtvReportFromRecurring(
      range,
      recurring.timeSeries,
      logoChurnAtFromSnapshot(snapshotTotals),
    );
  }

  const installs = await loadInstalls(query, range.end, range.start, range.start);
  return buildLtvReportFromRecurring(
    range,
    recurring.timeSeries,
    logoChurnAtFromInstalls(installs),
  );
}

function atEndOfBucket(bucket: UtcBucket): Date {
  return new Date(Math.max(bucket.start.getTime(), bucket.end.getTime() - 1));
}

function cohortMonth(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The cross-report Mantle-style portfolio view. Every metric is derived from
 * the same tenant scope, UTC range, test exclusion, and as-of predicates used
 * by the dedicated Revenue/LTV/Churn reports.
 */
/** Uninstall reasons, biggest first, with each one's share of the window. */
export function summarizeUninstallReasons(
  details: ReadonlyArray<{ reasonCode: string; isStoreClosure: boolean }>,
): UninstallReasonSummary[] {
  const byReason = new Map<string, number>();
  for (const detail of details) {
    byReason.set(detail.reasonCode, (byReason.get(detail.reasonCode) ?? 0) + 1);
  }
  return [...byReason.entries()]
    .map(([reasonCode, count]) => ({
      reasonCode,
      count,
      share: rate(count, details.length),
      /* Read from the CODE, not OR-ed across the rows in the group.
         The survey is multi-select, so a merchant can answer "Not using app
         now, Store is closing or pausing" — one row whose primary code is
         `not_using` but whose `isStoreClosure` is true. OR-ing then flagged
         the whole `not_using` category as a store closure on the strength of
         28 such rows out of 4,692, and `testing_multiple_apps` on 12. A group
         keyed by reason code either IS that reason or is not. */
      storeClosure: STORE_CLOSURE_CODES.has(reasonCode),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The two local figures an app's overview page needs: how many merchants have
 * it installed right now, and why the ones who left said they left.
 *
 * Exists because that page was calling `getPortfolioReport` for exactly these
 * two values and throwing the rest away. That function also loads
 * subscriptions, usage events for two windows, charges, retention cohorts and
 * the install time series — none of which the overview displays — at a
 * measured ~6s per request, uncached, on every single load. It was the largest
 * remaining cost on the page and all of it was waste.
 *
 * Deliberately built from the SAME primitives rather than fresh SQL:
 * `installSnapshotReadiness` / `stockAtDayEnd` / `installIsActiveAt` and
 * `summarizeUninstallReasons` are the definitions, and both callers reach them
 * the same way — so the overview's "Users" tile cannot drift from the
 * portfolio report's install count.
 */
export async function getAppOverviewBasics(
  query: AnalyticsQuery,
  range: ResolvedAnalyticsRange,
): Promise<{ activeInstalls: number; uninstallReasons: UninstallReasonSummary[] }> {
  const todayStart = startOfUtcDay(new Date());
  const snapshotAppIds = env.INSTALL_SNAPSHOT_READ_PATH_ENABLED
    ? await resolveScopeAppIds(query)
    : [];
  const snapshotReadiness = snapshotAppIds.length
    ? await installSnapshotReadiness(
        snapshotAppIds,
        range.start,
        range.end.getTime() < todayStart.getTime() ? range.end : todayStart,
      )
    : { applied: false as const, appIds: snapshotAppIds };

  /* The last instant inside the window, matching `getPortfolioReport`'s own
     `nowPoint` — "active now" means active as of the end of what is shown. */
  const nowPoint = new Date(range.end.getTime() - 1);

  const [activeInstalls, uninstallDetails] = await Promise.all([
    snapshotReadiness.applied
      ? readInstallSnapshotWithLiveTopUp(
          snapshotAppIds,
          range.start,
          range.end,
          new Date(),
        ).then((totals) => stockAtDayEnd(totals, nowPoint))
      : loadInstalls(query, range.end, range.start, range.start).then(
          (installs) =>
            installs.filter((install) => installIsActiveAt(install, nowPoint))
              .length,
        ),
    prisma.uninstallEventDetail.findMany({
      where: {
        event: {
          occurredAt: { gte: range.start, lt: range.end },
          appInstall: reportScope(query.organizationId, query.appId),
        },
      },
      select: { reasonCode: true, isStoreClosure: true },
    }),
  ]);

  return {
    activeInstalls,
    uninstallReasons: summarizeUninstallReasons(uninstallDetails),
  };
}

export async function getPortfolioReport(
  query: AnalyticsQuery,
  suppliedRange?: ResolvedAnalyticsRange,
): Promise<PortfolioReport> {
  const range = suppliedRange ?? (await rangeFor(query));
  const buckets = buildUtcBuckets(range);
  const scope = reportScope(query.organizationId, query.appId);
  const previousUsageStart = new Date(
    range.start.getTime() - (range.end.getTime() - range.start.getTime()),
  );
  const installsStartedAt = Date.now();

  const snapshotAppIds = env.INSTALL_SNAPSHOT_READ_PATH_ENABLED
    ? await resolveScopeAppIds(query)
    : [];
  const todayStart = startOfUtcDay(new Date());
  const snapshotReadiness = snapshotAppIds.length
    ? await installSnapshotReadiness(
        snapshotAppIds,
        range.start,
        range.end.getTime() < todayStart.getTime() ? range.end : todayStart,
      )
    : { applied: false, appIds: snapshotAppIds };

  const [
    subscriptions,
    installs,
    totalInstalls,
    usageEvents,
    previousUsageEvents,
    uninstallDetails,
    chargeRows,
    snapshotTotals,
  ] = await Promise.all([
    loadSubscriptions(query, range),
    // Retention cohorts (built below) always need a live install read, but
    // only over the narrow installed-within-the-window population — when the
    // snapshot covers everything else this function computes, that narrower
    // query replaces the full, activeSince-bounded `loadInstalls` scan.
    snapshotReadiness.applied
      ? loadInstallsForRetention(query, range)
      : loadInstalls(query, range.end, range.start, range.start).then((result) => {
          console.log(
            `[DIAG] loadInstalls count=${result.length}: ${Date.now() - installsStartedAt}ms`,
          );
          return result;
        }),
    // `funnel.installed` / `sourceCoverage.installs` report the lifetime
    // total, which `activeSince`-bounded `installs` above no longer holds in
    // full — a plain COUNT costs nothing next to transferring every row.
    prisma.appInstall.count({ where: scope }),
    prisma.usageEvent.findMany({
      where: {
        occurredAt: { gte: range.start, lt: range.end },
        appInstall: scope,
      },
      select: {
        metric: true,
        quantity: true,
        appInstallId: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: "asc" },
    }),
    prisma.usageEvent.groupBy({
      by: ["metric"],
      where: {
        occurredAt: { gte: previousUsageStart, lt: range.start },
        appInstall: scope,
      },
      _sum: { quantity: true },
    }),
    prisma.uninstallEventDetail.findMany({
      where: {
        event: {
          occurredAt: { gte: range.start, lt: range.end },
          appInstall: scope,
        },
      },
      select: { reasonCode: true, isStoreClosure: true },
    }),
    prisma.charge.findMany({
      where: {
        status: "ACTIVE",
        occurredAt: { gte: range.start, lt: range.end },
        subscription: { test: false, appInstall: scope },
      },
      select: { subscription: { select: { appInstallId: true } } },
    }),
    snapshotReadiness.applied
      ? readInstallSnapshotWithLiveTopUp(
          snapshotAppIds,
          range.start,
          range.end,
          new Date(),
        )
      : Promise.resolve(null),
  ]);

  const currencySet = new Set(
    subscriptions.map((subscription) => subscription.plan.currencyCode),
  );
  const recurringTimeSeries: RecurringPoint[] = [];
  for (const bucket of buckets) {
    const at = atEndOfBucket(bucket);
    const statsByCurrency = recurringStatsAt(subscriptions, at);
    for (const currency of currencySet) {
      const stats = statsByCurrency.get(currency);
      const mrr = round(stats?.mrr ?? 0);
      recurringTimeSeries.push({
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        currency,
        monthlySubscriptions: mrr,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions: round(stats?.trialSubscriptions ?? 0),
        mrr,
        arr: round(mrr * 12),
        activeSubscriptions: stats?.activeSubscriptions ?? 0,
        activeCustomers: stats?.installIds.size ?? 0,
        provisional: bucket.provisional,
      });
    }
  }

  const startStatsByCurrency = recurringStatsAt(subscriptions, range.start);
  const currentAt = new Date(
    Math.max(range.start.getTime(), range.end.getTime() - 1),
  );
  const currentStatsByCurrency = recurringStatsAt(subscriptions, currentAt);
  const recurringCurrencies = [...currencySet]
    .sort()
    .map((currency): RecurringCurrencySummary => {
      const startingMrr = round(
        startStatsByCurrency.get(currency)?.mrr ?? 0,
      );
      const current = currentStatsByCurrency.get(currency);
      const mrr = round(current?.mrr ?? 0);
      const trialSubscriptions =
        recurringTimeSeries
          .filter((point) => point.currency === currency)
          .at(-1)?.trialSubscriptions ?? 0;
      return {
        currency,
        mrr,
        arr: round(mrr * 12),
        monthlySubscriptions: mrr,
        annualSubscriptions: 0,
        usageCharges: 0,
        trialSubscriptions,
        startingMrr,
        netMrrGrowth: round(mrr - startingMrr),
        growthRate: rate(mrr - startingMrr, startingMrr),
        activeSubscriptions: current?.activeSubscriptions ?? 0,
        activeCustomers: current?.installIds.size ?? 0,
      };
    });

  // One pass over `installs` per bucket instead of three (`.filter()` for
  // newInstalls, a nested `.filter()` per install for uninstalls, and another
  // `.filter()` for activeInstalls) — see REPORTS-PERFORMANCE-AUDIT.md item F.
  const installTimeSeries = buckets.map((bucket): InstallPoint => {
    if (snapshotTotals) {
      const flow = sumInstallFlowOverDays(snapshotTotals, bucket.start, bucket.end);
      const activeInstalls = stockAtDayEnd(
        snapshotTotals,
        new Date(bucket.end.getTime() - 1),
      );
      return {
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        activeInstalls,
        newInstalls: flow.newInstalls,
        uninstalls: flow.uninstallsAll,
        netGrowth: flow.newInstalls - flow.uninstallsAll,
        provisional: bucket.provisional,
      };
    }
    const at = atEndOfBucket(bucket);
    let newInstalls = 0;
    let uninstalls = 0;
    let activeInstalls = 0;
    for (const install of installs) {
      if (
        install.installedAt >= bucket.start &&
        install.installedAt < bucket.end
      ) {
        newInstalls += 1;
      }
      let uninstallEvents = 0;
      for (const event of install.lifecycleEvents) {
        if (
          event.type === "UNINSTALLED" &&
          event.occurredAt >= bucket.start &&
          event.occurredAt < bucket.end
        ) {
          uninstallEvents += 1;
        }
      }
      uninstalls +=
        uninstallEvents ||
        (install.uninstalledAt &&
        install.uninstalledAt >= bucket.start &&
        install.uninstalledAt < bucket.end
          ? 1
          : 0);
      if (installIsActiveAt(install, at)) activeInstalls += 1;
    }
    return {
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      activeInstalls,
      newInstalls,
      uninstalls,
      netGrowth: newInstalls - uninstalls,
      provisional: bucket.provisional,
    };
  });

  const nowPoint = new Date(range.end.getTime() - 1);
  const installedInPeriod = snapshotTotals
    ? sumInstallFlowOverDays(snapshotTotals, range.start, range.end).newInstalls
    : installs.filter(
        (install) =>
          install.installedAt >= range.start && install.installedAt < range.end,
      ).length;
  const uninstalledInPeriod = installTimeSeries.reduce(
    (sum, point) => sum + point.uninstalls,
    0,
  );

  const trialCycleMap = new Map<
    string,
    {
      startedAt: Date;
      endsAt: Date;
      subscriptions: SubscriptionForReport[];
    }
  >();
  for (const subscription of subscriptions) {
    if (
      subscription.test ||
      !subscription.activatedAt ||
      !subscription.trialStartedAt ||
      !subscription.trialEndsAt
    ) {
      continue;
    }
    const key = `${subscription.appInstallId}:${subscription.trialStartedAt.toISOString()}`;
    const cycle = trialCycleMap.get(key) ?? {
      startedAt: subscription.trialStartedAt,
      endsAt: subscription.trialEndsAt,
      subscriptions: [],
    };
    cycle.subscriptions.push(subscription);
    if (subscription.trialEndsAt > cycle.endsAt) {
      cycle.endsAt = subscription.trialEndsAt;
    }
    trialCycleMap.set(key, cycle);
  }
  const trialCycles = [...trialCycleMap.values()];
  const periodTrialCycles = trialCycles.filter(
    (cycle) => cycle.startedAt >= range.start && cycle.startedAt < range.end,
  );
  const completedTrialCycles = periodTrialCycles.filter(
    (cycle) => cycle.endsAt <= nowPoint,
  );
  const cycleCanceledInTrial = (cycle: (typeof trialCycles)[number]): boolean =>
    cycle.subscriptions.every(
      (subscription) =>
        subscription.canceledAt && subscription.canceledAt <= cycle.endsAt,
    );
  const canceledTrials =
    completedTrialCycles.filter(cycleCanceledInTrial).length;
  const convertedTrials = completedTrialCycles.length - canceledTrials;
  const cycleActiveAt = (
    cycle: (typeof trialCycles)[number],
    at: Date,
  ): boolean =>
    cycle.startedAt <= at &&
    cycle.endsAt > at &&
    cycle.subscriptions.some(
      (subscription) =>
        subscription.activatedAt &&
        subscription.activatedAt <= at &&
        (!subscription.canceledAt || subscription.canceledAt > at) &&
        (!subscription.frozenAt || subscription.frozenAt > at) &&
        (!subscription.pausedUntil || subscription.pausedUntil < at),
    );
  const trialTimeSeries = buckets.map((bucket): TrialPoint => {
    const at = atEndOfBucket(bucket);
    const started = trialCycles.filter(
      (cycle) =>
        cycle.startedAt >= bucket.start && cycle.startedAt < bucket.end,
    ).length;
    const converted = trialCycles.filter(
      (cycle) =>
        cycle.endsAt >= bucket.start &&
        cycle.endsAt < bucket.end &&
        !cycleCanceledInTrial(cycle),
    ).length;
    const canceled = trialCycles.filter((cycle) => {
      if (!cycleCanceledInTrial(cycle)) return false;
      const outcomeAt = new Date(
        Math.max(
          ...cycle.subscriptions.map((subscription) =>
            subscription.canceledAt!.getTime(),
          ),
        ),
      );
      return outcomeAt >= bucket.start && outcomeAt < bucket.end;
    }).length;
    const active = trialCycles.filter((cycle) =>
      cycleActiveAt(cycle, at),
    ).length;
    return {
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      started,
      converted,
      canceled,
      active,
      conversionRate: rate(converted, converted + canceled),
      provisional: bucket.provisional,
    };
  });

  const allSubscriptionInstalls = new Set(
    subscriptions.map((subscription) => subscription.appInstallId),
  );
  const activatedInstalls = new Set(
    subscriptions
      .filter((subscription) => subscription.activatedAt)
      .map((subscription) => subscription.appInstallId),
  );
  const paidInstalls = new Set(
    chargeRows.map((charge) => charge.subscription.appInstallId),
  );

  const cohortMap = new Map<string, InstallForReport[]>();
  for (const install of installs) {
    if (install.installedAt < range.start || install.installedAt >= range.end)
      continue;
    const key = cohortMonth(install.installedAt);
    cohortMap.set(key, [...(cohortMap.get(key) ?? []), install]);
  }
  const retention = [...cohortMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, members]): RetentionCohort => {
      const retained = members.filter((install) =>
        installIsActiveAt(install, nowPoint),
      ).length;
      return {
        cohort,
        installed: members.length,
        retained,
        retentionRate: rate(retained, members.length),
      };
    });

  const usageMap = new Map<
    string,
    {
      quantity: number;
      eventCount: number;
      installIds: Set<string>;
      points: UsagePoint[];
    }
  >();
  const usageMetrics = new Set(usageEvents.map((event) => event.metric));
  const previousUsageByMetric = new Map<string, number>();
  for (const event of previousUsageEvents) {
    previousUsageByMetric.set(event.metric, Number(event._sum.quantity ?? 0));
  }
  const usageBucketState = new Map<
    string,
    Array<{
      quantity: number;
      eventCount: number;
      installIds: Set<string>;
    }>
  >();
  for (const metric of usageMetrics) {
    const points = buckets.map(() => ({
      quantity: 0,
      eventCount: 0,
      installIds: new Set<string>(),
    }));
    usageBucketState.set(metric, points);
    usageMap.set(metric, {
      quantity: 0,
      eventCount: 0,
      installIds: new Set<string>(),
      points: [],
    });
  }
  for (const event of usageEvents) {
    const current = usageMap.get(event.metric)!;
    current.quantity += Number(event.quantity);
    current.eventCount += 1;
    current.installIds.add(event.appInstallId);
    const bucketIndex = buckets.findIndex(
      (bucket) =>
        event.occurredAt >= bucket.start && event.occurredAt < bucket.end,
    );
    if (bucketIndex >= 0) {
      const point = usageBucketState.get(event.metric)![bucketIndex];
      point.quantity += Number(event.quantity);
      point.eventCount += 1;
      point.installIds.add(event.appInstallId);
    }
  }
  for (const [metric, states] of usageBucketState) {
    usageMap.get(metric)!.points = states.map((state, index) => ({
      periodStart: buckets[index].start.toISOString(),
      periodEnd: buckets[index].end.toISOString(),
      quantity: round(state.quantity, 6),
      eventCount: state.eventCount,
      activeInstalls: state.installIds.size,
      provisional: buckets[index].provisional,
    }));
  }
  const usage = [...usageMap.entries()]
    .map(([metric, value]) => {
      const previousQuantity = round(previousUsageByMetric.get(metric) ?? 0, 6);
      return {
        metric,
        quantity: round(value.quantity, 6),
        eventCount: value.eventCount,
        activeInstalls: value.installIds.size,
        previousQuantity,
        changeRate:
          previousQuantity > 0
            ? rate(value.quantity - previousQuantity, previousQuantity)
            : null,
        timeSeries: value.points,
      };
    })
    .sort((a, b) => b.quantity - a.quantity);

  const uninstallReasons = summarizeUninstallReasons(uninstallDetails);

  return {
    ...envelope(range),
    recurring: {
      currencies: recurringCurrencies,
      timeSeries: recurringTimeSeries,
    },
    installs: {
      activeNow: snapshotTotals
        ? stockAtDayEnd(snapshotTotals, nowPoint)
        : installs.filter((install) => installIsActiveAt(install, nowPoint))
            .length,
      installedInPeriod,
      uninstalledInPeriod,
      netGrowth: installedInPeriod - uninstalledInPeriod,
      timeSeries: installTimeSeries,
    },
    trials: {
      started: periodTrialCycles.length,
      converted: convertedTrials,
      canceled: canceledTrials,
      completed: completedTrialCycles.length,
      unresolved: 0,
      conversionRate: rate(convertedTrials, convertedTrials + canceledTrials),
      activeNow: trialCycles.filter((cycle) => cycleActiveAt(cycle, nowPoint))
        .length,
      timeSeries: trialTimeSeries,
      source: "local_lifecycle",
      historyComplete: true,
    },
    funnel: {
      installed: totalInstalls,
      subscribed: allSubscriptionInstalls.size,
      activated: activatedInstalls.size,
      paid: paidInstalls.size,
    },
    retention,
    usage,
    uninstallReasons,
    forecast: recurringCurrencies.map((currency) => ({
      currency: currency.currency,
      monthlyRunRate: currency.mrr,
      annualRunRate: currency.arr,
    })),
    sourceCoverage: {
      installs: totalInstalls,
      subscriptions: subscriptions.length,
      successfulCharges: chargeRows.length,
      usageEvents: usageEvents.length,
      notes: [
        "Each Shopify shop is treated as one customer.",
        "MRR uses active non-test subscriptions, normalized cadence, and permanent price-reduction discounts.",
        "Forecast is a current run-rate projection, not a probabilistic forecast.",
      ],
      unavailable: [
        "Shopify payout, tax, refund, and revenue-share reconciliation",
        "GA4 traffic, campaign attribution, and page-view conversion",
        "Expansion/contraction decomposition before plan-history snapshots exist",
      ],
    },
  };
}

export async function getAnalyticsReports(
  query: AnalyticsQuery,
  suppliedRange?: ResolvedAnalyticsRange,
): Promise<AnalyticsReports> {
  const range = suppliedRange ?? (await rangeFor(query));
  const [portfolio, revenue, churn, ltv] = await Promise.all([
    getPortfolioReport(query, range),
    getRevenueReport(query, range),
    getChurnReport(query, range),
    getLtvReport(query, range),
  ]);
  return { portfolio, revenue, churn, ltv };
}
