import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { claimRedisThrottle } from "../cache/redis-cache.server";
import type {
  ResolvedAnalyticsRange,
  RevenueReport,
  RecurringCurrencySummary,
  RecurringPoint,
  MrrMovementSummary,
  MrrMovementBucket,
  PlanMrrSeries,
  ChurnReport,
  CountChurnPoint,
  RevenueChurnPoint,
  RevenueChurnCurrencyReport,
} from "../reports/analytics.server";
import {
  buildUtcBuckets,
  EMPTY_MRR_MOVEMENT_BUCKET,
  mrrMovementNet,
} from "../reports/analytics.server";
export type { MrrMovementSummary } from "../reports/analytics.server";
import type {
  EventFact,
  SaleFact,
  ChargeContribution,
  ChargeHistory,
  ChurnEvidenceIndex,
  MrrMovementKind,
  MrrMovementDelta,
} from "./partner-mrr.server";
import {
  buildFirstPaidContributionIndex,
  mrrMovementForShop,
  historiesFromFacts,
  liveHistoriesSince,
  contributionMapAt,
  summarizeContributions,
  buildPartnerRevenueFromFacts,
  buildChurnEvidenceIndex,
  activePaidHistoryMap,
  contributionAt,
  isReplacementCancellation,
  replacedCancellation,
  resolveOfferCadencePins,
  loadLiveDiscountChecks,
  clockTransitionBillingOnWindows,
  mantlePlanLabel,
  planMrrKey,
  rankPlanMrrSeries,
  round,
} from "./partner-mrr.server";
import { updateAppWithinBillingLease } from "./partner-subscription-sync.server";

/**
 * Sentinel `appId` for `PartnerDailyLogoChurnSnapshot` rows representing the
 * org-wide scope (see that model's doc comment for why not `null`). Never
 * collides with a real `App.id` (those are cuids).
 */
export const ORG_WIDE_LOGO_SCOPE_ID = "__org_wide__";

const log = logger.scope("partner-mrr-snapshot");

/**
 * Every sync tick unconditionally recomputes the trailing N days, rather than
 * threading the exact range of newly-inserted rows back out of
 * persistEventEdges/persistSaleEdges (they only return counts, not
 * timestamps). 7 days is a wide margin over the sync layer's documented
 * correction window (SALE_OVERLAP_MS = 48h) without relying on 48h being a
 * hard bound — recomputing 7 already-in-memory days is cheap either way.
 */
export const SNAPSHOT_TRAILING_DAYS = 7;

/** The window "MRR growth rate" means: a monthly rate, evaluated per bucket. */
const MONTHLY_GROWTH_LOOKBACK_DAYS = 30;

/** Historical backfill walks this many days per invocation, oldest first. */
const SNAPSHOT_BACKFILL_CHUNK_DAYS = 90;

const DAY_MS = 86_400_000;

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

export interface SubscriptionChurnDelta {
  at: Date;
  delta: 1 | -1;
  /** Only meaningful on a `delta: 1` (churn) row — the contribution's
   * currency/amount just before cancellation, for `churnedRevenueLost`. */
  currency: string;
  amount: number;
}

/**
 * Signed transitions reproducing `buildPartnerChurnFromFacts`'s per-charge
 * `subscription` lost/recovered verdict exactly. Unlike `subscriptionChurnAt`,
 * this is a plain bucket-boundary diff with no rolling lookback, so it's
 * day-additive-safe: `+1` when a charge stops being paid-and-non-trial via a
 * real cancel type, UNLESS `isReplacementCancellation` suppresses it
 * (same-shop reactivation within 60s — tier-change noise, not real churn);
 * `-1` when a charge this ledger counted churned resumes contributing.
 */
export function subscriptionChurnTransitions(
  history: ChargeHistory,
  evidence: ChurnEvidenceIndex,
): SubscriptionChurnDelta[] {
  const deltas: SubscriptionChurnDelta[] = [];
  // Mirrors `activePaidHistoryMap`'s definition of "contributing" exactly
  // (contributionAt !== null && kind !== "trial"), re-derived fresh via
  // `contributionAt` at each event's own instant rather than hand-rolled from
  // the event type — so it inherits every nuance (test events always "off";
  // FROZEN is NOT excluded here, unlike the abandoned `subscriptionChurnAt`).
  let contributing = false;
  let everContributed = false;
  for (const event of history.events) {
    const contribution = contributionAt(history, event.occurredAt);
    const nowContributing = Boolean(contribution && contribution.kind !== "trial");
    if (nowContributing === contributing) continue;
    if (nowContributing) {
      // A charge's first-ever paid contribution is a new subscription, not a
      // recovery — matches `buildPartnerChurnFromFacts`'s own
      // has-a-prior-activation gate on `recovered`.
      if (everContributed) {
        deltas.push({ at: event.occurredAt, delta: -1, currency: "", amount: 0 });
      }
      everContributed = true;
    } else if (
      !(
        event.type === "SUBSCRIPTION_CHARGE_CANCELED" &&
        isReplacementCancellation(history, evidence, event.occurredAt)
      )
    ) {
      const justBefore = contributionAt(history, new Date(event.occurredAt.getTime() - 1));
      deltas.push({
        at: event.occurredAt,
        delta: 1,
        currency: justBefore?.currency ?? "",
        amount: justBefore?.amount ?? 0,
      });
    }
    contributing = nowContributing;
  }
  return deltas;
}

export interface LogoChurnDailyCounts {
  activeShops: number;
  churned: number;
  recovered: number;
}

/**
 * Day-additive distinct-SHOP churn/recovery counts, one entry per day in
 * `days`. Unlike `subscriptionChurnTransitions` (a single charge's own event
 * sequence), a shop's "active" membership depends on ALL its charges
 * together, so this reuses `activePaidHistoryMap` and diffs consecutive
 * day-boundary snapshots rather than deriving a per-charge delta stream.
 * Reproduces `buildPartnerChurnFromFacts`'s `lostShops`/`recoveredShops`
 * set-diff exactly, once per UTC day — same accepted trade-off as
 * `subscriptionChurnTransitions`: a churn-then-recovery landing inside one
 * multi-day bucket sums to 1+1 here instead of 0/0 from a live boundary diff.
 *
 * Deliberately does NOT reapply `isReplacementCancellation` — a shop that
 * cancels one charge and activates a replacement same-day is simply present
 * in both day's active-shop sets, so it's never flagged churned; re-applying
 * that charge-level predicate at shop level would risk double-suppressing.
 *
 * `histories` may span one app or every enabled app folded together
 * (org-wide) — this function is scope-agnostic; the caller decides.
 */
function logoChurnCountsByDay(
  histories: ChargeHistory[],
  evidence: ChurnEvidenceIndex,
  days: Date[],
): Map<number, LogoChurnDailyCounts> {
  const result = new Map<number, LogoChurnDailyCounts>();
  if (days.length === 0) return result;
  const live = liveHistoriesSince(histories, days[0]);
  // Seed with the active-shop set at days[0]'s own start, so day one's
  // churned/recovered reflect real movement during that day, not the whole
  // pre-history colliding with day zero.
  let previousShops = new Set(
    [...activePaidHistoryMap(live, days[0]).values()].map(
      (value) => value.shopDomain,
    ),
  );
  for (const day of days) {
    const dayEnd = new Date(day.getTime() + DAY_MS - 1);
    const activeNow = activePaidHistoryMap(live, dayEnd);
    const currentShops = new Set(
      [...activeNow.values()].map((value) => value.shopDomain),
    );
    const churned = [...previousShops].filter(
      (shop) => !currentShops.has(shop),
    ).length;
    const recovered = [...currentShops].filter((shop) => {
      if (previousShops.has(shop)) return false;
      const earliest = evidence.earliestActivationByShop.get(shop);
      return earliest !== undefined && earliest < day;
    }).length;
    result.set(day.getTime(), {
      activeShops: currentShops.size,
      churned,
      recovered,
    });
    previousShops = currentShops;
  }
  return result;
}

export interface LogoChurnDailyRow {
  organizationId: string;
  appId: string;
  snapshotDate: Date;
  activeShops: number;
  churnedShops: number;
  recoveredShops: number;
}

/**
 * Builds `PartnerDailyLogoChurnSnapshot` rows for one scope (a single app, or
 * every enabled app's histories folded together for the org-wide row) — kept
 * separate from `buildDailySnapshotRows` since logo rows have no currency
 * dimension and the org-wide writer needs a DIFFERENT `appId` (the sentinel)
 * than the histories' own real app(s).
 */
export function buildLogoChurnDailyRows(params: {
  organizationId: string;
  appId: string;
  histories: ChargeHistory[];
  days: Date[];
}): LogoChurnDailyRow[] {
  if (params.days.length === 0) return [];
  const evidence = buildChurnEvidenceIndex(params.histories);
  const countsByDay = logoChurnCountsByDay(
    params.histories,
    evidence,
    params.days,
  );
  return params.days.map((day) => {
    const counts = countsByDay.get(day.getTime());
    return {
      organizationId: params.organizationId,
      appId: params.appId,
      snapshotDate: day,
      activeShops: counts?.activeShops ?? 0,
      churnedShops: counts?.churned ?? 0,
      recoveredShops: counts?.recovered ?? 0,
    };
  });
}

async function writeLogoChurnRows(rows: LogoChurnDailyRow[]): Promise<void> {
  for (const row of rows) {
    await prisma.partnerDailyLogoChurnSnapshot.upsert({
      where: {
        organizationId_appId_snapshotDate: {
          organizationId: row.organizationId,
          appId: row.appId,
          snapshotDate: row.snapshotDate,
        },
      },
      create: row,
      update: row,
    });
  }
}

/**
 * One plan's MRR on one day — a row of `PartnerDailyPlanMrrSnapshot`.
 *
 * Produced in the same pass as `DailySnapshotRow` (see `buildDailySnapshotRows`)
 * so the parent table's presence is a valid coverage check for these: a day
 * that has MRR rows has had its plan rows written too, even when there are
 * none because nothing carried revenue.
 */
export interface DailyPlanMrrRow {
  appId: string;
  snapshotDate: Date;
  currencyCode: string;
  plan: string;
  mrr: number;
  activeSubscriptions: number;
}

export interface DailySnapshotRow {
  appId: string;
  snapshotDate: Date;
  currencyCode: string;
  mrr: number;
  arr: number;
  monthlySubscriptions: number;
  annualSubscriptions: number;
  trialSubscriptions: number;
  usageCharges: number;
  activeSubscriptions: number;
  revenueGross: number;
  revenueCredits: number;
  revenueNet: number;
  subscriptionChurnedCount: number;
  subscriptionRecoveredCount: number;
  churnedRevenueLost: number;
  mrrNew: number;
  mrrReactivation: number;
  mrrExpansion: number;
  mrrContraction: number;
  mrrChurn: number;
  mrrFrozen: number;
  mrrUnfrozen: number;
  mrrEarlyPlanChange: number;
  builtFromEventsSyncedAt: Date | null;
  builtFromSalesSyncedAt: Date | null;
}

/** One day+currency's movement totals. Every field is positive; see the deltas. */
interface MovementTotals {
  mrrNew: number;
  mrrReactivation: number;
  mrrExpansion: number;
  mrrContraction: number;
  mrrChurn: number;
  mrrFrozen: number;
  mrrUnfrozen: number;
  mrrEarlyPlanChange: number;
}

const NO_MOVEMENT: MovementTotals = {
  mrrNew: 0,
  mrrReactivation: 0,
  mrrExpansion: 0,
  mrrContraction: 0,
  mrrChurn: 0,
  mrrFrozen: 0,
  mrrUnfrozen: 0,
  mrrEarlyPlanChange: 0,
};

const MOVEMENT_COLUMN: Record<MrrMovementKind, keyof MovementTotals> = {
  new: "mrrNew",
  reactivation: "mrrReactivation",
  expansion: "mrrExpansion",
  contraction: "mrrContraction",
  churn: "mrrChurn",
  frozen: "mrrFrozen",
  unfrozen: "mrrUnfrozen",
};

/**
 * Computes one row per (day in `days`, currency the app has ever billed in)
 * by reusing the live report path's own reconstruction primitives —
 * contributionMapAt/summarizeContributions for stock fields,
 * buildPartnerRevenueFromFacts for the revenue flow. Zero independent
 * MRR/revenue arithmetic; every number here comes from code the live path
 * already trusts.
 *
 * `buildPartnerRecurringFromFacts` is deliberately NOT used here — it also
 * computes the 30-day rolling churn window and trial lifecycle (out of
 * scope), and it's tuned for one instant, not N arbitrary days.
 */
export function buildDailySnapshotRows(params: {
  appId: string;
  /**
   * Display name, used only to resolve plan labels (`mantlePlanLabel`). Omitted
   * means plan rows carry the raw Shopify charge name — correct but not what
   * the report's live path would show, so the writer always passes it.
   */
  appName?: string;
  events: EventFact[];
  sales: SaleFact[];
  histories?: ChargeHistory[];
  /** UTC-midnight Dates, ascending. Never include "today" — it's always
   * provisional and must never be trusted from a snapshot. */
  days: Date[];
  builtFromEventsSyncedAt: Date | null;
  builtFromSalesSyncedAt: Date | null;
}): { rows: DailySnapshotRow[]; planRows: DailyPlanMrrRow[] } {
  if (params.days.length === 0) return { rows: [], planRows: [] };
  const histories =
    params.histories ?? historiesFromFacts(params.events, params.sales);
  const live = liveHistoriesSince(histories, params.days[0]);

  // Every currency the app has EVER billed in (matches
  // buildPartnerRecurringFromFacts), not just currencies active that day —
  // so a zero-contribution currency still gets an explicit `mrr: 0` row,
  // letting the read path's "row exists" check stay a simple presence check.
  const currencies = [
    ...new Set(
      params.events
        .filter((event) => !event.test)
        .map((event) => event.currencyCode),
    ),
  ].sort();

  const periodStart = params.days[0];
  const periodEnd = addUtcDays(params.days[params.days.length - 1], 1);
  const revenue = buildPartnerRevenueFromFacts({
    sales: params.sales,
    period: "all_time",
    periodStart,
    periodEnd,
    interval: "day",
  });

  // Subscription-level churn flow: currency-agnostic counts (matching
  // `buildPartnerChurnFromFacts`'s `subscription.lost`/`recovered`, never
  // split by currency — only `churnedRevenueLost` is), so the same per-day
  // count is written into every currency row for that day.
  const churnCountByDay = new Map<number, { churned: number; recovered: number }>();
  const revenueLostByDayAndCurrency = new Map<string, number>();
  const evidence = buildChurnEvidenceIndex(histories);
  for (const history of live) {
    for (const delta of subscriptionChurnTransitions(history, evidence)) {
      if (delta.at.getTime() < periodStart.getTime() || delta.at.getTime() >= periodEnd.getTime()) {
        continue;
      }
      const dayKey = startOfUtcDay(delta.at).getTime();
      const entry = churnCountByDay.get(dayKey) ?? { churned: 0, recovered: 0 };
      if (delta.delta === 1) {
        entry.churned += 1;
        const revenueKey = `${dayKey}:${delta.currency}`;
        revenueLostByDayAndCurrency.set(
          revenueKey,
          (revenueLostByDayAndCurrency.get(revenueKey) ?? 0) + delta.amount,
        );
      } else {
        entry.recovered += 1;
      }
      churnCountByDay.set(dayKey, entry);
    }
  }
  /* MRR movement, decomposed. Per-currency like `churnedRevenueLost` rather
     than currency-agnostic like the churn COUNTS — every one of these is an
     amount, and summing two currencies into one would invent an exchange rate
     at the one point nobody would see it happen.

     Same `live` list and same evidence index as the churn loop above, so the
     two walks see exactly the same charges. */
  const movementByDayAndCurrency = new Map<string, MovementTotals>();
  /* Built from ALL histories, not `live`: a shop's earlier paid subscription can
     sit on a charge long dead and pruned from the contribution loops, and that
     is exactly the charge that makes today's activation a reactivation. */
  const firstPaidByShop = buildFirstPaidContributionIndex(histories);
  /* Grouped by shop, because the movement walk is per shop: an activation
     arriving while the shop is already paying is a plan change, not an entry,
     and a per-charge walk cannot see that. Keyed the same way as the indexes so
     one shop's charges cannot be split across two groups.
     
     Deliberately `histories` and NOT `live` — the one place in this function
     that does not use the pruned set. The fold is stateful, so pruning by range
     would make an activation's classification depend on the window asked for,
     and the live path (`buildMrrMovementFromHistories`) would then disagree
     with these columns. Deltas are filtered to the range below instead. */
  const liveByShop = new Map<string, ChargeHistory[]>();
  for (const history of histories) {
    const shop = history.events[0]?.shopDomain;
    if (!shop) continue;
    const key = `${history.appId}\u001f${shop}`;
    const group = liveByShop.get(key);
    if (group) group.push(history);
    else liveByShop.set(key, [history]);
  }
  for (const group of liveByShop.values()) {
    for (const delta of mrrMovementForShop(group, evidence, firstPaidByShop)) {
      if (
        delta.at.getTime() < periodStart.getTime() ||
        delta.at.getTime() >= periodEnd.getTime()
      ) {
        continue;
      }
      const dayKey = startOfUtcDay(delta.at).getTime();
      const key = `${dayKey}:${delta.currency}`;
      const totals = movementByDayAndCurrency.get(key) ?? { ...NO_MOVEMENT };
      totals[MOVEMENT_COLUMN[delta.kind]] += delta.amount;
      /* Recorded IN ADDITION to the `new` it was booked as, never instead of
         it: the waterfall must still sum to the MRR change, and this is a
         disclosure of how much of `new` is really early plan-shopping. */
      if (delta.earlyPlanChange) totals.mrrEarlyPlanChange += delta.amount;
      movementByDayAndCurrency.set(key, totals);
    }
  }

  const revenueByCurrencyAndDay = new Map<
    string,
    Map<number, { gross: number; credits: number; net: number }>
  >();
  for (const currencyReport of revenue.currencies) {
    const byDay = new Map<
      number,
      { gross: number; credits: number; net: number }
    >();
    for (const point of currencyReport.timeSeries) {
      byDay.set(new Date(point.periodStart).getTime(), {
        gross: point.gross,
        credits: point.credits,
        net: point.net,
      });
    }
    revenueByCurrencyAndDay.set(currencyReport.currency, byDay);
  }

  const rows: DailySnapshotRow[] = [];
  const planRows: DailyPlanMrrRow[] = [];
  for (const day of params.days) {
    const dayEnd = addUtcDays(day, 1);
    const at = new Date(dayEnd.getTime() - 1);
    const currentAt = contributionMapAt(live, at);
    const contributions = [...currentAt.values()];
    const churnForDay = churnCountByDay.get(day.getTime());

    /* Per-plan MRR for this day, off the map the stock summary already needed
       — the reason this lives here rather than in a function of its own.
       `contributionMapAt` over every live charge is the expensive part of this
       whole builder, and a second pass just to group the same contributions by
       plan would double it for no new information.

       Trials are excluded, matching the live path: a trial contributes to
       `trialSubscriptions`, never to a plan's MRR. */
    const planTotals = new Map<string, { mrr: number; count: number }>();
    for (const contribution of contributions) {
      if (contribution.kind === "trial") continue;
      const plan = mantlePlanLabel(params.appName, contribution);
      if (!plan) continue;
      const key = `${contribution.currency}\u001f${plan}`;
      const entry = planTotals.get(key) ?? { mrr: 0, count: 0 };
      entry.mrr += contribution.amount;
      entry.count += 1;
      planTotals.set(key, entry);
    }
    for (const [key, entry] of planTotals) {
      const [currency, plan] = key.split("\u001f") as [string, string];
      // No row for a plan that carried nothing — see the model's doc comment
      // on why absence here is not a coverage gap.
      if (entry.mrr === 0) continue;
      planRows.push({
        appId: params.appId,
        snapshotDate: day,
        currencyCode: currency,
        plan,
        mrr: round(entry.mrr),
        activeSubscriptions: entry.count,
      });
    }

    for (const currency of currencies) {
      const stock = summarizeContributions(contributions, currency);
      const revenueForDay = revenueByCurrencyAndDay
        .get(currency)
        ?.get(day.getTime());
      rows.push({
        appId: params.appId,
        snapshotDate: day,
        currencyCode: currency,
        mrr: stock.mrr,
        arr: round(stock.mrr * 12),
        monthlySubscriptions: stock.monthlySubscriptions,
        annualSubscriptions: stock.annualSubscriptions,
        trialSubscriptions: stock.trialSubscriptions,
        usageCharges: 0,
        activeSubscriptions: stock.activeSubscriptions,
        revenueGross: revenueForDay?.gross ?? 0,
        revenueCredits: revenueForDay?.credits ?? 0,
        revenueNet: revenueForDay?.net ?? 0,
        // Currency-agnostic — the same count on every currency row for this
        // day (see the comment above `churnCountByDay`).
        subscriptionChurnedCount: churnForDay?.churned ?? 0,
        subscriptionRecoveredCount: churnForDay?.recovered ?? 0,
        churnedRevenueLost:
          revenueLostByDayAndCurrency.get(`${day.getTime()}:${currency}`) ?? 0,
        ...(movementByDayAndCurrency.get(`${day.getTime()}:${currency}`) ??
          NO_MOVEMENT),
        builtFromEventsSyncedAt: params.builtFromEventsSyncedAt,
        builtFromSalesSyncedAt: params.builtFromSalesSyncedAt,
      });
    }
  }
  return { rows, planRows };
}

async function writeRows(
  rows: DailySnapshotRow[],
  planRows: DailyPlanMrrRow[],
): Promise<void> {
  for (const row of rows) {
    await prisma.partnerDailyMrrSnapshot.upsert({
      where: {
        appId_snapshotDate_currencyCode: {
          appId: row.appId,
          snapshotDate: row.snapshotDate,
          currencyCode: row.currencyCode,
        },
      },
      create: row,
      update: row,
    });
  }
  /* Plan rows are DELETED for the days being written before being re-inserted,
     which the parent table never needs: a plan that dropped to zero MRR stops
     producing a row, so a plain upsert would leave yesterday's row standing
     forever and the plan would appear to hold revenue it no longer has. The
     delete is scoped to exactly the days in this batch. */
  const appIds = [...new Set(rows.map((row) => row.appId))];
  const writtenDays = [
    ...new Set(rows.map((row) => row.snapshotDate.getTime())),
  ];
  if (appIds.length > 0 && writtenDays.length > 0) {
    await prisma.partnerDailyPlanMrrSnapshot.deleteMany({
      where: {
        appId: { in: appIds },
        snapshotDate: { in: writtenDays.map((ms) => new Date(ms)) },
      },
    });
  }
  if (planRows.length > 0) {
    await prisma.partnerDailyPlanMrrSnapshot.createMany({ data: planRows });
  }
}

interface SnapshotableApp {
  id: string;
  organizationId: string;
  /** Only used to resolve plan labels — see `buildDailySnapshotRows`. */
  name: string;
  mrrSnapshotSyncedAt: Date | null;
  mrrSnapshotBackfillCursor: Date | null;
  mrrSnapshotBackfillCompletedAt: Date | null;
  mrrSnapshotDirtyFrom: Date | null;
  billingEventsBackfillCompletedAt: Date | null;
  billingSalesBackfillCompletedAt: Date | null;
  billingEventsSyncedAt: Date | null;
  billingSalesSyncedAt: Date | null;
}

/**
 * Marks a day dirty for the trailing-rewrite writer — call this from every
 * write path that can move subscription/charge history after the fact (a
 * historical backfill delivering an old event, a late-arriving sale). Only
 * ever *lowers* the watermark, mirroring `markInstallSnapshotDirty`.
 *
 * Also lowers `logoSnapshotDirtyFrom` — a SEPARATE field from
 * `mrrSnapshotDirtyFrom`, since the far-more-frequent per-app MRR writer
 * clears its own field as soon as its chunk covers it; sharing one field
 * would starve the independently-ticked org-wide logo writer of its rebuild
 * signal. Two `updateMany` calls, not one, since each field has its own
 * independent "only if currently null or greater" guard.
 */
export async function markMrrSnapshotDirty(appId: string, occurredAt: Date): Promise<void> {
  const day = startOfUtcDay(occurredAt);
  await Promise.all([
    prisma.app.updateMany({
      where: {
        id: appId,
        OR: [{ mrrSnapshotDirtyFrom: null }, { mrrSnapshotDirtyFrom: { gt: day } }],
      },
      data: { mrrSnapshotDirtyFrom: day },
    }),
    prisma.app.updateMany({
      where: {
        id: appId,
        OR: [{ logoSnapshotDirtyFrom: null }, { logoSnapshotDirtyFrom: { gt: day } }],
      },
      data: { logoSnapshotDirtyFrom: day },
    }),
  ]);
}

/**
 * Opening-balance events for the trailing window: per charge, the single
 * latest event before `trailingFloor` (so `historiesFromFacts`'s
 * `lastEventAt`/`terminal` and `contributionAt`'s `lastAt` see true state as
 * of the window start) PLUS the charge's true first
 * `SUBSCRIPTION_CHARGE_ACTIVATED` event before `trailingFloor` (so
 * `activatedAt` — used for trial-window detection — isn't lost when a
 * charge's true first activation isn't also its latest pre-window event).
 * Two representative rows per charge, not the whole history.
 *
 * Two window-function queries rather than one: MySQL 8 can't cheaply number
 * "first ACTIVATED row" and "latest row" in the same partition without
 * scanning every row for both anyway, and each query is individually cheap
 * (indexed by `partner_sub_event_charge_occurred_idx`).
 */
async function loadOpeningBalanceEvents(
  appId: string,
  trailingFloor: Date,
): Promise<EventFact[]> {
  type RawEventRow = EventFact & { id: string };
  const [
    latestPerCharge,
    firstActivatedPerCharge,
    latestLifecyclePerCharge,
    latestFreezePerCharge,
  ] = await Promise.all([
    prisma.$queryRaw<RawEventRow[]>`
      SELECT t.id, t.appId, t.type, t.occurredAt, t.shopDomain,
             t.chargePlatformId, t.chargeName, t.amount, t.currencyCode,
             t.billingOn, t.test
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY chargePlatformId
            ORDER BY occurredAt DESC, id DESC
          ) AS rn
        FROM partner_subscription_events
        WHERE appId = ${appId} AND occurredAt < ${trailingFloor}
      ) t
      WHERE t.rn = 1
    `,
    prisma.$queryRaw<RawEventRow[]>`
      SELECT t.id, t.appId, t.type, t.occurredAt, t.shopDomain,
             t.chargePlatformId, t.chargeName, t.amount, t.currencyCode,
             t.billingOn, t.test
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY chargePlatformId
            ORDER BY occurredAt ASC, id ASC
          ) AS rn
        FROM partner_subscription_events
        WHERE appId = ${appId} AND occurredAt < ${trailingFloor}
          AND type = 'SUBSCRIPTION_CHARGE_ACTIVATED'
      ) t
      WHERE t.rn = 1
    `,
    // `isChargeActive` reads the last LIFECYCLE event while ignoring
    // FROZEN/UNFROZEN entirely, so the single latest-overall event above is
    // NOT sufficient on its own: for the exact shape fixed 2026-09-01
    // (ACTIVATED -> CANCELED -> FROZEN -> UNFROZEN) the latest event is the
    // UNFROZEN, and the CANCELED in the middle would be dropped — leaving
    // only an ACTIVATED in `lifecycleEvents` and reviving a dead charge.
    // That silently reintroduced the stray-unfreeze bug in the trailing lane
    // only (the backfill loads full history, so it stayed correct), which is
    // why trailing days read higher than backfilled ones at the seam —
    // caught 2026-09-03 against 537 matching charges on a production app.
    prisma.$queryRaw<RawEventRow[]>`
      SELECT t.id, t.appId, t.type, t.occurredAt, t.shopDomain,
             t.chargePlatformId, t.chargeName, t.amount, t.currencyCode,
             t.billingOn, t.test
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY chargePlatformId
            ORDER BY occurredAt DESC, id DESC
          ) AS rn
        FROM partner_subscription_events
        WHERE appId = ${appId} AND occurredAt < ${trailingFloor}
          AND type IN (
            'SUBSCRIPTION_CHARGE_ACTIVATED',
            'SUBSCRIPTION_CHARGE_CANCELED',
            'SUBSCRIPTION_CHARGE_DECLINED',
            'SUBSCRIPTION_CHARGE_EXPIRED'
          )
      ) t
      WHERE t.rn = 1
    `,
    // Same reasoning for the freeze half: the currently-frozen check needs the
    // last FROZEN/UNFROZEN, which the latest-overall row misses whenever a
    // lifecycle event landed after it.
    prisma.$queryRaw<RawEventRow[]>`
      SELECT t.id, t.appId, t.type, t.occurredAt, t.shopDomain,
             t.chargePlatformId, t.chargeName, t.amount, t.currencyCode,
             t.billingOn, t.test
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY chargePlatformId
            ORDER BY occurredAt DESC, id DESC
          ) AS rn
        FROM partner_subscription_events
        WHERE appId = ${appId} AND occurredAt < ${trailingFloor}
          AND type IN (
            'SUBSCRIPTION_CHARGE_FROZEN',
            'SUBSCRIPTION_CHARGE_UNFROZEN'
          )
      ) t
      WHERE t.rn = 1
    `,
  ]);

  // One row can satisfy several of the four selections above (a charge whose
  // first-ACTIVATED is also its latest pre-window event, say) — dedupe by id.
  const seen = new Set<string>();
  const merged: EventFact[] = [];
  for (const row of [
    ...latestPerCharge,
    ...firstActivatedPerCharge,
    ...latestLifecyclePerCharge,
    ...latestFreezePerCharge,
  ]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

/**
 * Bounded events for `writeTrailingDailySnapshots` only: the opening balance
 * above, plus every event within the trailing window itself. Safe because
 * every `at` instant this feeds (`contributionAt` et al.) falls within
 * `[trailingFloor, todayStart)`, and the opening balance carries the last
 * pre-window event of *each class the active-checks actually read* — latest
 * lifecycle and latest freeze separately, not just the latest overall. That
 * distinction is load-bearing: see `loadOpeningBalanceEvents`' own comment
 * for the stray-unfreeze shape that a single latest-event row silently
 * mis-reconstructs. Any future check reading a new event class must add its
 * own selection there.
 *
 * Sales stay unbounded: `historiesFromFacts`'s offer-median inference reads
 * every sale across every charge sharing an offer, not just each charge's
 * own latest sale, so bounding sales the same way would silently corrupt
 * that median. `backfillDailySnapshots` below also can't use this — it needs
 * unbounded `loadAppFacts` to find the account's true earliest fact and to
 * build snapshots for arbitrary historical chunks, not just the trailing
 * window.
 */
/** Exported for direct testing against a real database — see
 * `tests/partner-mrr-snapshot-bounding.test.ts`. */
export async function loadTrailingAppFacts(
  appId: string,
  trailingFloor: Date,
  todayStart: Date,
): Promise<{ events: EventFact[]; sales: SaleFact[] }> {
  const [openingBalanceEvents, windowedEvents, sales] = await Promise.all([
    loadOpeningBalanceEvents(appId, trailingFloor),
    prisma.partnerSubscriptionEvent.findMany({
      where: {
        appId,
        occurredAt: { gte: trailingFloor, lt: todayStart },
      },
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
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId, occurredAt: { lt: todayStart } },
      select: {
        appId: true,
        chargePlatformId: true,
        occurredAt: true,
        billingInterval: true,
        grossAmount: true,
        currencyCode: true,
      },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
  ]);
  return { events: [...openingBalanceEvents, ...windowedEvents], sales };
}

async function loadAppFacts(
  appId: string,
  periodEnd: Date,
): Promise<{ events: EventFact[]; sales: SaleFact[] }> {
  // Unbounded on purpose, same as `loadPartnerFacts` in partner-mrr.server.ts
  // — historiesFromFacts needs a charge's full history and its offer-median
  // inference needs every charge's sales, not just a recent window.
  const [events, sales] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId, occurredAt: { lt: periodEnd } },
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
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId, occurredAt: { lt: periodEnd } },
      select: {
        appId: true,
        chargePlatformId: true,
        occurredAt: true,
        billingInterval: true,
        grossAmount: true,
        currencyCode: true,
      },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
  ]);
  return { events, sales };
}

/**
 * Throttle for the trailing rewrite and backfill chunk below, keyed by
 * wall-clock time (unlike `mrrSnapshotSyncedAt`, a calendar-day boundary that
 * can't distinguish "ran 10s ago" from "ran 2 days ago"). Needed because
 * `writeTrailingDailySnapshots`/`backfillDailySnapshots` are invoked from
 * `syncPartnerSubscriptionFactsUnlocked`, which the sync loop can call every
 * few seconds while a lane isn't yet "fresh" — without a throttle, the
 * unbounded sales read reruns on every retry, causing sustained memory
 * pressure across cluster workers. Still needed even after bounding events,
 * since sales stay unbounded by necessity and `backfillDailySnapshots` still
 * reads everything unbounded.
 * Shared with the install daily snapshot writer — see `claimRedisThrottle` in
 * `redis-cache.server.ts` for the atomicity/fallback rationale.
 */
const TRAILING_REWRITE_THROTTLE_MS = 5 * 60_000;

/**
 * Always (re)computes the last `SNAPSHOT_TRAILING_DAYS` days, never today.
 * Must never throw — a snapshot-write failure must not fail the underlying
 * billing sync, since raw facts are strictly more important than this
 * derived cache.
 */
export async function writeTrailingDailySnapshots(
  app: SnapshotableApp,
  leaseToken: string,
  today: Date,
): Promise<void> {
  const claimed = await claimRedisThrottle(
    `snapshot-throttle:trailing:${app.id}`,
    TRAILING_REWRITE_THROTTLE_MS,
  );
  if (!claimed) return;
  const startedAt = Date.now();
  try {
    const todayStart = startOfUtcDay(today);
    const normalFloor = addUtcDays(todayStart, -SNAPSHOT_TRAILING_DAYS);
    // A dirty watermark older than the normal trailing floor widens this
    // tick's rewrite back to cover it, bounded to SNAPSHOT_BACKFILL_CHUNK_DAYS
    // extra days per tick so one very old late fact can't make a tick
    // unboundedly expensive. No anchor/prefix-sum correction needed here,
    // unlike installs — every day's stock is recomputed independently from
    // full history, so re-including a day in `days` is enough to fix it.
    const requestedFloor =
      app.mrrSnapshotDirtyFrom && app.mrrSnapshotDirtyFrom.getTime() < normalFloor.getTime()
        ? app.mrrSnapshotDirtyFrom
        : normalFloor;
    const chunkFloor = new Date(
      Math.max(
        requestedFloor.getTime(),
        todayStart.getTime() - SNAPSHOT_BACKFILL_CHUNK_DAYS * DAY_MS,
      ),
    );

    const days: Date[] = [];
    for (
      let day = chunkFloor;
      day.getTime() < todayStart.getTime();
      day = addUtcDays(day, 1)
    ) {
      days.push(day);
    }
    const { events, sales } = await loadTrailingAppFacts(
      app.id,
      days[0],
      todayStart,
    );
    const offerPins = await resolveOfferCadencePins(events, sales);
    const liveDiscountChecks = await loadLiveDiscountChecks([app.id], todayStart);
    const histories = historiesFromFacts(events, sales, offerPins, liveDiscountChecks);
    const { rows, planRows } = buildDailySnapshotRows({
      appId: app.id,
      appName: app.name,
      events,
      sales,
      histories,
      days,
      builtFromEventsSyncedAt: app.billingEventsSyncedAt,
      builtFromSalesSyncedAt: app.billingSalesSyncedAt,
    });
    await writeRows(rows, planRows);
    // Per-app logo-churn rows ride this same pass, reusing the days/histories
    // already computed above. The org-wide half is a separate writer — see
    // PartnerDailyLogoChurnSnapshot's doc comment.
    await writeLogoChurnRows(
      buildLogoChurnDailyRows({
        organizationId: app.organizationId,
        appId: app.id,
        histories,
        days,
      }),
    );
    const latestDay = days[days.length - 1];
    // A dirty watermark deeper than one chunk can't be paged backward here:
    // this writer always rewrites up to *today*, so widening the floor is the
    // only move it has, and re-running it just recomputes the same window.
    // The old code set `mrrSnapshotDirtyFrom = chunkFloor` in that case, which
    // overwrote (and lost) the deeper request, so the next tick saw itself as
    // caught up and cleared the flag — silently abandoning everything older
    // than SNAPSHOT_BACKFILL_CHUNK_DAYS. Found 2026-09-02: a rewrite requested
    // back to 2025-01-01 stopped dead at today-90d after exactly two ticks.
    // Hand those off to `backfillDailySnapshots` instead — it has a real
    // backward cursor and terminates at the account's earliest fact. Resuming
    // its walk from this tick's floor means it only redoes what this writer
    // couldn't reach; everything newer is already correct.
    const unreached =
      app.mrrSnapshotDirtyFrom && chunkFloor.getTime() > app.mrrSnapshotDirtyFrom.getTime();
    const data: Parameters<typeof updateAppWithinBillingLease>[2] = {
      mrrSnapshotDirtyFrom: null,
    };
    if (unreached) {
      data.mrrSnapshotBackfillCompletedAt = null;
      data.mrrSnapshotBackfillCursor = chunkFloor;
    }
    if (
      !app.mrrSnapshotSyncedAt ||
      latestDay.getTime() > app.mrrSnapshotSyncedAt.getTime()
    ) {
      data.mrrSnapshotSyncedAt = latestDay;
    }
    await updateAppWithinBillingLease(app.id, leaseToken, data);
    log.info("wrote trailing daily snapshots", {
      appId: app.id,
      days: days.length,
      rows: rows.length,
      dirtyRewrite: days.length > SNAPSHOT_TRAILING_DAYS,
      handedToBackfill: Boolean(unreached),
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    log.warn("trailing snapshot write failed", {
      appId: app.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * One-time historical backfill, walking backward from the account's earliest
 * fact toward `mrrSnapshotBackfillCursor`, `SNAPSHOT_BACKFILL_CHUNK_DAYS` at a
 * time — same incremental shape as the raw-fact backfills. Only runs once
 * both raw-fact backfills are complete for this app.
 */
/** Same reasoning as `TRAILING_REWRITE_THROTTLE_MS` — bounds how often this
 * app's unbounded facts read can rerun regardless of sync-tick frequency. */
const BACKFILL_CHUNK_THROTTLE_MS = 60_000;

export async function backfillDailySnapshots(
  app: SnapshotableApp,
  leaseToken: string,
  today: Date,
): Promise<void> {
  if (app.mrrSnapshotBackfillCompletedAt) return;
  if (
    !app.billingEventsBackfillCompletedAt ||
    !app.billingSalesBackfillCompletedAt
  ) {
    // Raw facts aren't fully backfilled yet; nothing safe to snapshot beyond
    // the trailing window. Try again next tick.
    return;
  }
  const claimed = await claimRedisThrottle(
    `snapshot-throttle:backfill:${app.id}`,
    BACKFILL_CHUNK_THROTTLE_MS,
  );
  if (!claimed) return;
  const startedAt = Date.now();
  try {
    const todayStart = startOfUtcDay(today);
    // The trailing window always covers the most recent days; the backfill
    // only needs to reach back to just before it to avoid gaps or duplicate
    // work with writeTrailingDailySnapshots.
    const trailingFloor = addUtcDays(todayStart, -SNAPSHOT_TRAILING_DAYS);
    const cursor = app.mrrSnapshotBackfillCursor
      ? startOfUtcDay(app.mrrSnapshotBackfillCursor)
      : trailingFloor;
    if (cursor.getTime() <= 0) return;

    const { events, sales } = await loadAppFacts(app.id, todayStart);
    const earliestFact = [...events, ...sales].reduce<Date | null>(
      (earliest, fact) =>
        !earliest || fact.occurredAt < earliest ? fact.occurredAt : earliest,
      null,
    );
    const floor = earliestFact ? startOfUtcDay(earliestFact) : cursor;

    const chunkStart = new Date(
      Math.max(floor.getTime(), cursor.getTime() - SNAPSHOT_BACKFILL_CHUNK_DAYS * DAY_MS),
    );
    if (chunkStart.getTime() >= cursor.getTime()) {
      // Nothing left to walk — reached the account's earliest fact.
      await updateAppWithinBillingLease(app.id, leaseToken, {
        mrrSnapshotBackfillCursor: floor,
        mrrSnapshotBackfillCompletedAt: today,
      });
      log.info("snapshot backfill completed", {
        appId: app.id,
        floor: floor.toISOString(),
      });
      return;
    }

    const days: Date[] = [];
    for (
      let cursorDay = chunkStart;
      cursorDay.getTime() < cursor.getTime();
      cursorDay = addUtcDays(cursorDay, 1)
    ) {
      days.push(cursorDay);
    }
    const offerPins = await resolveOfferCadencePins(events, sales);
    const liveDiscountChecks = await loadLiveDiscountChecks([app.id], cursor);
    const histories = historiesFromFacts(events, sales, offerPins, liveDiscountChecks);
    const { rows, planRows } = buildDailySnapshotRows({
      appId: app.id,
      appName: app.name,
      events,
      sales,
      histories,
      days,
      builtFromEventsSyncedAt: app.billingEventsSyncedAt,
      builtFromSalesSyncedAt: app.billingSalesSyncedAt,
    });
    await writeRows(rows, planRows);
    await writeLogoChurnRows(
      buildLogoChurnDailyRows({
        organizationId: app.organizationId,
        appId: app.id,
        histories,
        days,
      }),
    );
    await updateAppWithinBillingLease(app.id, leaseToken, {
      mrrSnapshotBackfillCursor: chunkStart,
    });
    log.info("snapshot backfill chunk written", {
      appId: app.id,
      days: days.length,
      rows: rows.length,
      cursor: chunkStart.toISOString(),
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    log.warn("snapshot backfill chunk failed", {
      appId: app.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Org-wide logo-churn snapshot writer
// ---------------------------------------------------------------------------
//
// Separate from the per-app writers above: a shop active in 2+ apps must
// never be double-counted by summing per-app logo-churn numbers (confirmed
// in production: 68 of 4257 active shops are active in 2 apps at once) — see
// PartnerDailyLogoChurnSnapshot's doc comment. This writer folds every
// enabled app's facts together (same scope as an "all apps" live request)
// and writes ORG_WIDE_LOGO_SCOPE_ID rows, once per tick, org-wide.
//
// No lease guards Organization's own state here — it has no lease columns in
// this schema, and this writer is naturally idempotent (a deterministic
// recompute from immutable facts), so a rare concurrent-write race costs at
// most a redundant recompute, never a wrong value.

const ORG_LOGO_TRAILING_THROTTLE_MS = TRAILING_REWRITE_THROTTLE_MS;
const ORG_LOGO_BACKFILL_THROTTLE_MS = BACKFILL_CHUNK_THROTTLE_MS;

interface OrgLogoSnapshotAppFacts {
  events: EventFact[];
  sales: SaleFact[];
}

async function loadOrgHistories(
  appIds: string[],
  loadOneApp: (appId: string) => Promise<OrgLogoSnapshotAppFacts>,
  /**
   * End of the window being reconstructed — passed through to
   * `loadLiveDiscountChecks` so a rewrite of the same days produces the same
   * rows no matter when it runs. See `LIVE_CHECK_TRUST_MS`.
   */
  reconstructedThrough: Date,
): Promise<ChargeHistory[]> {
  const perApp = await Promise.all(appIds.map(loadOneApp));
  const events = perApp.flatMap((facts) => facts.events);
  const sales = perApp.flatMap((facts) => facts.sales);
  const offerPins = await resolveOfferCadencePins(events, sales);
  const liveDiscountChecks = await loadLiveDiscountChecks(appIds, reconstructedThrough);
  return historiesFromFacts(events, sales, offerPins, liveDiscountChecks);
}

/**
 * Always (re)computes the last `SNAPSHOT_TRAILING_DAYS` days org-wide
 * (widened to cover any app's dirty floor, same chunking rule as
 * `writeTrailingDailySnapshots`). Must never throw.
 */
export async function writeTrailingOrgLogoSnapshot(
  organizationId: string,
  today: Date,
): Promise<void> {
  const claimed = await claimRedisThrottle(
    `snapshot-throttle:org-logo-trailing:${organizationId}`,
    ORG_LOGO_TRAILING_THROTTLE_MS,
  );
  if (!claimed) return;
  const startedAt = Date.now();
  try {
    const apps = await prisma.app.findMany({
      where: {
        organizationId,
        enabled: true,
        removed: false,
        scheduledForDeletionAt: null,
      },
      select: { id: true, logoSnapshotDirtyFrom: true },
    });
    if (apps.length === 0) return;

    const todayStart = startOfUtcDay(today);
    const normalFloor = addUtcDays(todayStart, -SNAPSHOT_TRAILING_DAYS);
    const dirtyValues = apps
      .map((app) => app.logoSnapshotDirtyFrom)
      .filter((value): value is Date => value !== null);
    const minDirty =
      dirtyValues.length > 0
        ? new Date(Math.min(...dirtyValues.map((value) => value.getTime())))
        : null;
    const requestedFloor =
      minDirty && minDirty.getTime() < normalFloor.getTime()
        ? minDirty
        : normalFloor;
    const chunkFloor = new Date(
      Math.max(
        requestedFloor.getTime(),
        todayStart.getTime() - SNAPSHOT_BACKFILL_CHUNK_DAYS * DAY_MS,
      ),
    );

    const days: Date[] = [];
    for (
      let day = chunkFloor;
      day.getTime() < todayStart.getTime();
      day = addUtcDays(day, 1)
    ) {
      days.push(day);
    }
    if (days.length === 0) return;

    const histories = await loadOrgHistories(
      apps.map((app) => app.id),
      (appId) => loadTrailingAppFacts(appId, days[0], todayStart),
      todayStart,
    );
    const rows = buildLogoChurnDailyRows({
      organizationId,
      appId: ORG_WIDE_LOGO_SCOPE_ID,
      histories,
      days,
    });
    await writeLogoChurnRows(rows);

    // Same "only clear once actually caught up" rule as the per-app writer,
    // applied per app: a dirty floor now covered by this chunk clears to
    // null; one still older narrows toward the chunk instead of clearing
    // outright, bounding one very-old late fact to
    // SNAPSHOT_BACKFILL_CHUNK_DAYS of extra work per tick.
    const caughtUpIds = apps
      .filter(
        (app) =>
          app.logoSnapshotDirtyFrom &&
          app.logoSnapshotDirtyFrom.getTime() >= chunkFloor.getTime(),
      )
      .map((app) => app.id);
    const stillDirtyIds = apps
      .filter(
        (app) =>
          app.logoSnapshotDirtyFrom &&
          app.logoSnapshotDirtyFrom.getTime() < chunkFloor.getTime(),
      )
      .map((app) => app.id);
    await Promise.all([
      caughtUpIds.length > 0
        ? prisma.app.updateMany({
            where: { id: { in: caughtUpIds } },
            data: { logoSnapshotDirtyFrom: null },
          })
        : Promise.resolve(),
      stillDirtyIds.length > 0
        ? prisma.app.updateMany({
            where: { id: { in: stillDirtyIds } },
            data: { logoSnapshotDirtyFrom: chunkFloor },
          })
        : Promise.resolve(),
    ]);

    const latestDay = days[days.length - 1];
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { logoSnapshotSyncedAt: true },
    });
    if (
      !organization?.logoSnapshotSyncedAt ||
      latestDay.getTime() > organization.logoSnapshotSyncedAt.getTime()
    ) {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { logoSnapshotSyncedAt: latestDay },
      });
    }
    log.info("wrote trailing org-wide logo snapshot", {
      organizationId,
      apps: apps.length,
      days: days.length,
      rows: rows.length,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    log.warn("trailing org-wide logo snapshot write failed", {
      organizationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * One-time historical backfill, org-wide — mirrors `backfillDailySnapshots`,
 * scoped to the whole org instead of one app. Only runs once EVERY enabled
 * app's raw-fact backfills are complete.
 */
export async function backfillOrgLogoSnapshot(
  organizationId: string,
  today: Date,
): Promise<void> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      logoSnapshotBackfillCursor: true,
      logoSnapshotBackfillCompletedAt: true,
    },
  });
  if (!organization || organization.logoSnapshotBackfillCompletedAt) return;

  const apps = await prisma.app.findMany({
    where: {
      organizationId,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
    },
    select: {
      id: true,
      billingEventsBackfillCompletedAt: true,
      billingSalesBackfillCompletedAt: true,
    },
  });
  if (apps.length === 0) return;
  if (
    apps.some(
      (app) =>
        !app.billingEventsBackfillCompletedAt ||
        !app.billingSalesBackfillCompletedAt,
    )
  ) {
    // At least one app's raw facts aren't fully backfilled yet — nothing
    // safe to snapshot org-wide beyond the trailing window. Try again next
    // tick; a single slow app must not permanently block this.
    return;
  }

  const claimed = await claimRedisThrottle(
    `snapshot-throttle:org-logo-backfill:${organizationId}`,
    ORG_LOGO_BACKFILL_THROTTLE_MS,
  );
  if (!claimed) return;
  const startedAt = Date.now();
  try {
    const todayStart = startOfUtcDay(today);
    const trailingFloor = addUtcDays(todayStart, -SNAPSHOT_TRAILING_DAYS);
    const cursor = organization.logoSnapshotBackfillCursor
      ? startOfUtcDay(organization.logoSnapshotBackfillCursor)
      : trailingFloor;
    if (cursor.getTime() <= 0) return;

    const appIds = apps.map((app) => app.id);
    const perAppFacts = await Promise.all(
      appIds.map((appId) => loadAppFacts(appId, todayStart)),
    );
    const events = perAppFacts.flatMap((facts) => facts.events);
    const sales = perAppFacts.flatMap((facts) => facts.sales);
    const earliestFact = [...events, ...sales].reduce<Date | null>(
      (earliest, fact) =>
        !earliest || fact.occurredAt < earliest ? fact.occurredAt : earliest,
      null,
    );
    const floor = earliestFact ? startOfUtcDay(earliestFact) : cursor;

    const chunkStart = new Date(
      Math.max(
        floor.getTime(),
        cursor.getTime() - SNAPSHOT_BACKFILL_CHUNK_DAYS * DAY_MS,
      ),
    );
    if (chunkStart.getTime() >= cursor.getTime()) {
      await prisma.organization.update({
        where: { id: organizationId },
        data: {
          logoSnapshotBackfillCursor: floor,
          logoSnapshotBackfillCompletedAt: today,
        },
      });
      log.info("org-wide logo snapshot backfill completed", {
        organizationId,
        floor: floor.toISOString(),
      });
      return;
    }

    const days: Date[] = [];
    for (
      let cursorDay = chunkStart;
      cursorDay.getTime() < cursor.getTime();
      cursorDay = addUtcDays(cursorDay, 1)
    ) {
      days.push(cursorDay);
    }
    const offerPins = await resolveOfferCadencePins(events, sales);
    const liveDiscountChecks = await loadLiveDiscountChecks(appIds, cursor);
    const histories = historiesFromFacts(events, sales, offerPins, liveDiscountChecks);
    const rows = buildLogoChurnDailyRows({
      organizationId,
      appId: ORG_WIDE_LOGO_SCOPE_ID,
      histories,
      days,
    });
    await writeLogoChurnRows(rows);
    await prisma.organization.update({
      where: { id: organizationId },
      data: { logoSnapshotBackfillCursor: chunkStart },
    });
    log.info("org-wide logo snapshot backfill chunk written", {
      organizationId,
      days: days.length,
      rows: rows.length,
      cursor: chunkStart.toISOString(),
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    log.warn("org-wide logo snapshot backfill chunk failed", {
      organizationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export interface PartnerSnapshotReadiness {
  /** True only when EVERY app in scope is ready — i.e. `liveAppIds` is empty.
   * Kept for callers/logs that just want a single yes/no; prefer
   * `readyAppIds`/`liveAppIds` for anything that splits work between the two
   * paths. */
  applied: boolean;
  appIds: string[];
  /** Apps whose snapshot has a row for every expected day in range and no
   * dirty watermark inside it — safe to serve straight from the snapshot. */
  readyAppIds: string[];
  /** Apps that must fall back to the live reconstruction for this request —
   * missing a day, never snapshotted at all, or dirty. */
  liveAppIds: string[];
  missingDays: number;
}

/**
 * Pure completeness check, split out so it's unit-testable against fixtures
 * without a live database (`partnerSnapshotReadiness` below is the thin
 * DB-querying wrapper). Partitions `appIds` into `readyAppIds` (a row for
 * every expected UTC day in `[rangeStart, rangeEndExclusive)`, no dirty
 * watermark inside it) and `liveAppIds` (everything else) — so a single
 * young or dirty app in a multi-app "All apps" request no longer forces the
 * *entire* scope onto the slow live path when every other app is ready. A
 * stray row outside `[rangeStart, rangeEndExclusive)` (e.g. today) has no
 * effect, since only days inside that window are checked.
 */
export function evaluateSnapshotCompleteness(params: {
  appIds: string[];
  rangeStart: Date;
  rangeEndExclusive: Date;
  rows: Array<Pick<DailySnapshotRow, "appId" | "snapshotDate">>;
  /** Apps with a dirty watermark inside the requested range never apply — a
   * dirty stock/flow must never be served, mirroring the install-snapshot's
   * `installSnapshotDirtyFrom` rule. */
  dirtyFromByApp?: Map<string, Date | null>;
}): PartnerSnapshotReadiness {
  const { appIds, rangeStart, rangeEndExclusive, rows } = params;
  if (appIds.length === 0) {
    return { applied: false, appIds, readyAppIds: [], liveAppIds: [], missingDays: -1 };
  }
  if (rangeEndExclusive.getTime() <= rangeStart.getTime()) {
    // The whole requested range is "today" or later — nothing to check,
    // nothing a snapshot could ever cover.
    return { applied: false, appIds, readyAppIds: [], liveAppIds: [...appIds], missingDays: -1 };
  }
  const expectedDays: number[] = [];
  for (
    let day = rangeStart;
    day.getTime() < rangeEndExclusive.getTime();
    day = addUtcDays(day, 1)
  ) {
    expectedDays.push(day.getTime());
  }

  const coveredByApp = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = coveredByApp.get(row.appId) ?? new Set<number>();
    set.add(row.snapshotDate.getTime());
    coveredByApp.set(row.appId, set);
  }

  const readyAppIds: string[] = [];
  const liveAppIds: string[] = [];
  let missingDays = 0;
  for (const appId of appIds) {
    const dirtyFrom = params.dirtyFromByApp?.get(appId);
    const isDirty = Boolean(
      dirtyFrom && dirtyFrom.getTime() < rangeEndExclusive.getTime(),
    );
    const covered = coveredByApp.get(appId);
    let appMissingDays = 0;
    for (const day of expectedDays) {
      if (!covered?.has(day)) appMissingDays += 1;
    }
    missingDays += appMissingDays;
    if (!isDirty && appMissingDays === 0) readyAppIds.push(appId);
    else liveAppIds.push(appId);
  }

  return {
    applied: liveAppIds.length === 0,
    appIds,
    readyAppIds,
    liveAppIds,
    missingDays,
  };
}

/**
 * Thin async wrapper: resolves the expected day window, queries the (tiny,
 * cheap) snapshot rows for it, and delegates to `evaluateSnapshotCompleteness`.
 */
export async function partnerSnapshotReadiness(params: {
  appIds: string[];
  range: Pick<ResolvedAnalyticsRange, "start" | "end">;
  now?: Date;
}): Promise<PartnerSnapshotReadiness> {
  const { appIds, range } = params;
  if (appIds.length === 0) {
    return { applied: false, appIds, readyAppIds: [], liveAppIds: [], missingDays: -1 };
  }
  const todayStart = startOfUtcDay(params.now ?? new Date());
  const rangeStart = startOfUtcDay(range.start);
  const rangeEndExclusive = new Date(
    Math.min(startOfUtcDay(range.end).getTime(), todayStart.getTime()),
  );
  const [rows, apps] =
    rangeEndExclusive.getTime() > rangeStart.getTime()
      ? await Promise.all([
          prisma.partnerDailyMrrSnapshot.findMany({
            where: {
              appId: { in: appIds },
              snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
            },
            select: { appId: true, snapshotDate: true },
          }),
          prisma.app.findMany({
            where: { id: { in: appIds } },
            select: { id: true, mrrSnapshotDirtyFrom: true },
          }),
        ])
      : [[], []];
  return evaluateSnapshotCompleteness({
    appIds,
    rangeStart,
    rangeEndExclusive,
    rows,
    dirtyFromByApp: new Map(apps.map((app) => [app.id, app.mrrSnapshotDirtyFrom])),
  });
}

export interface SnapshotPartnerRevenue {
  revenue: Awaited<ReturnType<typeof buildPartnerRevenueFromFacts>>;
}

/**
 * Sums two `RevenueReport`s bucket-for-bucket, currency-for-currency — merges
 * a snapshot-served subset of apps with a live-reconstructed subset
 * (`readyAppIds` vs `liveAppIds`) into one report. Safe only because both
 * reports are built from the exact same `range` — `buildUtcBuckets` is
 * deterministic, so bucket `i` always spans the same instants in both; this
 * does not align reports built from different ranges.
 */
export function mergeRevenueReports(a: RevenueReport, b: RevenueReport): RevenueReport {
  const currencies = [
    ...new Set([...a.currencies.map((c) => c.currency), ...b.currencies.map((c) => c.currency)]),
  ].sort();

  return {
    ...a,
    currencies: currencies.map((currency) => {
      const left = a.currencies.find((c) => c.currency === currency);
      const right = b.currencies.find((c) => c.currency === currency);
      const bucketCount = (left ?? right)!.timeSeries.length;
      const timeSeries = Array.from({ length: bucketCount }, (_, index) => {
        const l = left?.timeSeries[index];
        const r = right?.timeSeries[index];
        const gross = round((l?.gross ?? 0) + (r?.gross ?? 0));
        const credits = round((l?.credits ?? 0) + (r?.credits ?? 0));
        return {
          periodStart: (l ?? r)!.periodStart,
          periodEnd: (l ?? r)!.periodEnd,
          gross,
          credits,
          net: round(gross - credits),
          provisional: Boolean(l?.provisional || r?.provisional),
        };
      });
      const gross = round(timeSeries.reduce((sum, point) => sum + point.gross, 0));
      const credits = round(timeSeries.reduce((sum, point) => sum + point.credits, 0));
      return {
        currency,
        value: { gross, credits, net: round(gross - credits) },
        timeSeries,
      };
    }),
  };
}

/**
 * Revenue-only snapshot read. Serves whichever `readyAppIds` (already
 * partitioned from `liveAppIds` by `partnerSnapshotReadiness`) have full
 * snapshot coverage for `range`. Returns `null` when `readyAppIds` is empty.
 *
 * Snapshot rows never cover "today" (the trailing writer only rewrites
 * *completed* days), so today's partial bucket is topped up with one small,
 * cheap live query scoped to `readyAppIds` and `[todayStart, range.end)` — a
 * handful of rows regardless of `range` width, not a full reconstruction.
 * This top-up is a real correctness requirement: without it, today's revenue
 * reads as $0 on every snapshot-served response, since every period preset's
 * end is "now".
 */
export async function buildSnapshotPartnerAnalytics(params: {
  readyAppIds: string[];
  range: ResolvedAnalyticsRange;
  now?: Date;
}): Promise<SnapshotPartnerRevenue | null> {
  const { readyAppIds: appIds, range } = params;
  if (appIds.length === 0) return null;
  const now = params.now ?? new Date();
  const todayStart = startOfUtcDay(now);
  const rangeStart = startOfUtcDay(range.start);
  const rangeEndExclusive = new Date(
    Math.min(startOfUtcDay(range.end).getTime(), todayStart.getTime()),
  );

  const rows = await prisma.partnerDailyMrrSnapshot.findMany({
    where: {
      appId: { in: appIds },
      snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
    },
    orderBy: { snapshotDate: "asc" },
  });

  // Re-verify against the actual rows — belt-and-suspenders against a race
  // with the writer between the readiness check and this read.
  const coveredByApp = new Map<string, Set<number>>();
  for (const row of rows) {
    if (row.snapshotDate.getTime() < rangeStart.getTime()) continue;
    const set = coveredByApp.get(row.appId) ?? new Set<number>();
    set.add(row.snapshotDate.getTime());
    coveredByApp.set(row.appId, set);
  }
  for (
    let day = rangeStart;
    day.getTime() < rangeEndExclusive.getTime();
    day = addUtcDays(day, 1)
  ) {
    for (const appId of appIds) {
      if (!coveredByApp.get(appId)?.has(day.getTime())) return null;
    }
  }

  let revenue = bucketDailySnapshotRevenue(rows, range);

  if (rangeEndExclusive.getTime() < range.end.getTime()) {
    const todaySales = await prisma.partnerSubscriptionSaleFact.findMany({
      where: {
        appId: { in: appIds },
        occurredAt: { gte: rangeEndExclusive, lt: range.end },
      },
      select: {
        appId: true,
        chargePlatformId: true,
        occurredAt: true,
        billingInterval: true,
        grossAmount: true,
        currencyCode: true,
      },
    });
    if (todaySales.length > 0) {
      const topUp = buildPartnerRevenueFromFacts({
        sales: todaySales,
        period: range.period,
        periodStart: range.start,
        periodEnd: range.end,
        interval: range.interval,
      });
      revenue = mergeRevenueReports(revenue, topUp);
    }
  }

  return { revenue };
}

export interface SnapshotPartnerRecurring {
  currencies: RecurringCurrencySummary[];
  timeSeries: RecurringPoint[];
  /**
   * Where MRR moved inside the range, per currency. Empty when the range is not
   * fully snapshot-covered — a partial sum of a FLOW is not a smaller truth, it
   * is a wrong number, so the panel hides the table rather than under-report it.
   */
  movement?: MrrMovementSummary[];
  /**
   * Top plans by MRR. Absent when `PartnerDailyPlanMrrSnapshot` has nothing for
   * the range — which is what a not-yet-backfilled deployment looks like, and
   * renders as no card rather than a wrong one.
   */
  planSeries?: PlanMrrSeries[];
}

/**
 * Today's movement, folded live, because no snapshot row exists for today.
 *
 * Snapshot rows are only ever written for finalized days, so the provisional
 * bucket of the MRR-changes table read as an em dash while every other series
 * on the page had a value for today. The revenue series already solves this by
 * topping up from live facts (see `buildSnapshotPartnerAnalytics`); movement
 * needs more care, because the fold is STATEFUL per shop — whether an
 * activation is `new`, `reactivation` or half a plan change depends on that
 * shop's whole history, so it cannot be folded from today's rows alone.
 *
 * Loading every shop is what the snapshot path exists to avoid, so this loads
 * only shops that could possibly have moved today. That set is knowable and
 * complete: the fold pushes a delta only at a sample instant, and sample
 * instants are exactly event times, sale times, and clock-driven trial
 * conversions (see `mrrMovementForShop`). A shop with none of those today
 * cannot have a delta today.
 *
 * Scoped BY SHOP, not by charge — the distinction matters. `historiesFromFacts`
 * derives `shopHasPriorSale` from the facts it is given, so a charge-scoped
 * load silently reports "this shop never paid" and misclassifies the charge.
 * Loading the shop's full history keeps that answer correct.
 */
async function buildTodayMovementTopUp(
  appIds: string[],
  todayStart: Date,
  now: Date,
): Promise<Map<string, MrrMovementBucket> | null> {
  if (appIds.length === 0 || now.getTime() <= todayStart.getTime()) return null;

  const [eventShops, saleShops, clockShops] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { appId: { in: appIds }, occurredAt: { gte: todayStart, lt: now } },
      select: { appId: true, shopDomain: true },
      distinct: ["appId", "shopDomain"],
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId: { in: appIds }, occurredAt: { gte: todayStart, lt: now } },
      select: { appId: true, shopDomain: true },
      distinct: ["appId", "shopDomain"],
    }),
    // A trial converting emits nothing; it is the clock passing `billingOn`.
    prisma.partnerSubscriptionEvent.findMany({
      where: {
        appId: { in: appIds },
        OR: clockTransitionBillingOnWindows(
          new Date(todayStart.getTime() - 1),
          now,
        ).map((window) => ({ billingOn: window })),
      },
      select: { appId: true, shopDomain: true },
      distinct: ["appId", "shopDomain"],
    }),
  ]);

  const shopsByApp = new Map<string, Set<string>>();
  for (const row of [...eventShops, ...saleShops, ...clockShops]) {
    if (!row.shopDomain) continue;
    const set = shopsByApp.get(row.appId) ?? new Set<string>();
    set.add(row.shopDomain);
    shopsByApp.set(row.appId, set);
  }
  if (shopsByApp.size === 0) return null;

  const shopFilter = [...shopsByApp].map(([appId, shops]) => ({
    appId,
    shopDomain: { in: [...shops] },
  }));
  const [events, sales] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { OR: shopFilter },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { OR: shopFilter },
      orderBy: [{ chargePlatformId: "asc" }, { occurredAt: "asc" }],
    }),
  ]);
  if (events.length === 0) return null;

  const histories = historiesFromFacts(
    events,
    sales,
    await resolveOfferCadencePins(events, sales),
    await loadLiveDiscountChecks(appIds),
  );
  const evidence = buildChurnEvidenceIndex(histories);
  const firstPaid = buildFirstPaidContributionIndex(histories);

  const byShop = new Map<string, ChargeHistory[]>();
  for (const history of histories) {
    const shop = history.events[0]?.shopDomain;
    if (!shop) continue;
    const key = `${history.appId}\u001f${shop}`;
    const group = byShop.get(key);
    if (group) group.push(history);
    else byShop.set(key, [history]);
  }

  const byCurrency = new Map<string, MrrMovementBucket>();
  for (const group of byShop.values()) {
    for (const delta of mrrMovementForShop(group, evidence, firstPaid)) {
      if (delta.at < todayStart || delta.at >= now) continue;
      const cell =
        byCurrency.get(delta.currency) ?? { ...EMPTY_MRR_MOVEMENT_BUCKET };
      /* `MrrMovementKind` and the bucket's money keys are the same seven
         strings, so the delta's kind indexes the bucket directly. */
      cell[delta.kind] += delta.amount;
      if (delta.earlyPlanChange) cell.earlyPlanChange += delta.amount;
      byCurrency.set(delta.currency, cell);
    }
  }
  return byCurrency.size > 0 ? byCurrency : null;
}

/**
 * Reads the eight movement columns into per-bucket figures, per currency.
 *
 * A flow, not a stock — so unlike the MRR summary beside it this reads EVERY
 * day in range rather than two boundary days, and it verifies that every app
 * has a row for every one of those days before returning. A movement total
 * missing a day is silently too small, which is the failure mode most likely to
 * be believed; returning `null` lets the caller fall back to folding it live
 * (`buildMrrMovementFromHistories`) rather than showing a short number.
 *
 * The columns are per-currency (like `churnedRevenueLost`, unlike the
 * subscription churn COUNTS), so summing every row for a day needs no dedup.
 */
export async function buildSnapshotMrrMovement(params: {
  readyAppIds: string[];
  range: ResolvedAnalyticsRange;
  now?: Date;
}): Promise<MrrMovementSummary[] | null> {
  const { readyAppIds: appIds, range } = params;
  if (appIds.length === 0) return null;
  const todayStart = startOfUtcDay(params.now ?? new Date());
  const rangeStart = startOfUtcDay(range.start);
  const rangeEndExclusive = new Date(
    Math.min(startOfUtcDay(range.end).getTime(), todayStart.getTime()),
  );
  if (rangeEndExclusive.getTime() <= rangeStart.getTime()) return null;

  const rows = await prisma.partnerDailyMrrSnapshot.findMany({
    where: {
      appId: { in: appIds },
      snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
    },
    select: {
      appId: true,
      snapshotDate: true,
      currencyCode: true,
      mrrNew: true,
      mrrReactivation: true,
      mrrExpansion: true,
      mrrContraction: true,
      mrrChurn: true,
      mrrFrozen: true,
      mrrUnfrozen: true,
      mrrEarlyPlanChange: true,
    },
  });

  const coveredByApp = new Map<string, Set<number>>();
  for (const row of rows) {
    const days = coveredByApp.get(row.appId) ?? new Set<number>();
    days.add(row.snapshotDate.getTime());
    coveredByApp.set(row.appId, days);
  }
  for (
    let day = rangeStart;
    day.getTime() < rangeEndExclusive.getTime();
    day = addUtcDays(day, 1)
  ) {
    for (const appId of appIds) {
      if (!coveredByApp.get(appId)?.has(day.getTime())) return null;
    }
  }

  // The same buckets every other series on the page uses, so the movement
  // table's columns line up with the charts above it.
  const buckets = buildUtcBuckets(range);
  if (buckets.length === 0) return null;

  const byCurrency = new Map<string, MrrMovementSummary>();
  const blank = (): MrrMovementBucket => ({ ...EMPTY_MRR_MOVEMENT_BUCKET });

  for (const row of rows) {
    let index = -1;
    const at = row.snapshotDate.getTime();
    for (let i = 0; i < buckets.length; i += 1) {
      if (at >= buckets[i]!.start.getTime() && at < buckets[i]!.end.getTime()) {
        index = i;
        break;
      }
    }
    if (index === -1) continue;

    let summary = byCurrency.get(row.currencyCode);
    if (!summary) {
      summary = {
        currency: row.currencyCode,
        buckets: buckets.map((bucket) => ({
          periodStart: bucket.start.toISOString(),
          periodEnd: bucket.end.toISOString(),
          ...blank(),
        })),
        total: blank(),
      };
      byCurrency.set(row.currencyCode, summary);
    }

    const cell = summary.buckets[index]!;
    const fields = [
      ["new", row.mrrNew],
      ["reactivation", row.mrrReactivation],
      ["expansion", row.mrrExpansion],
      ["contraction", row.mrrContraction],
      ["churn", row.mrrChurn],
      ["frozen", row.mrrFrozen],
      ["unfrozen", row.mrrUnfrozen],
      ["earlyPlanChange", row.mrrEarlyPlanChange],
    ] as const;
    for (const [key, value] of fields) {
      const amount = Number(value);
      cell[key] += amount;
      summary.total[key] += amount;
    }
  }

  /* Today, folded live and added to the provisional bucket — see
     `buildTodayMovementTopUp`. Done before the rounding/net pass below so
     today's column closes to Net change like every other column. */
  const todayTopUp = await buildTodayMovementTopUp(appIds, rangeEndExclusive, range.end);
  if (todayTopUp) {
    let provisionalIndex = -1;
    for (let i = buckets.length - 1; i >= 0; i -= 1) {
      if (buckets[i]?.provisional) {
        provisionalIndex = i;
        break;
      }
    }
    if (provisionalIndex >= 0) {
      for (const [currency, delta] of todayTopUp) {
        let summary = byCurrency.get(currency);
        if (!summary) {
          /* A currency that only moved today has no snapshot row to have
             created its summary. */
          summary = {
            currency,
            buckets: buckets.map((bucket) => ({
              periodStart: bucket.start.toISOString(),
              periodEnd: bucket.end.toISOString(),
              ...blank(),
            })),
            total: blank(),
          };
          byCurrency.set(currency, summary);
        }
        const cell = summary.buckets[provisionalIndex]!;
        for (const key of MOVEMENT_MERGE_KEYS) {
          cell[key] += delta[key];
          summary.total[key] += delta[key];
        }
      }
    }
  }

  for (const summary of byCurrency.values()) {
    for (const cell of summary.buckets) {
      for (const key of Object.keys(cell) as Array<keyof MrrMovementBucket>) {
        if (typeof cell[key] === "number") {
          (cell[key] as number) = round(cell[key] as number);
        }
      }
      cell.net = round(mrrMovementNet(cell));
    }
    for (const key of Object.keys(summary.total) as Array<
      keyof MrrMovementBucket
    >) {
      if (typeof summary.total[key] === "number") {
        (summary.total[key] as number) = round(summary.total[key] as number);
      }
    }
    summary.total.net = round(mrrMovementNet(summary.total));
  }

  return [...byCurrency.values()].sort(
    (left, right) => right.total.net - left.total.net,
  );
}

/**
 * Aggregates one snapshotted day's rows into per-currency totals across
 * `appIds` — the building block for both boundaries `buildSnapshotPartnerRecurring`
 * needs (the day at `rangeStart` and the last fully-covered day in range).
 */
type DecimalLike = number | { toString(): string };

function aggregateSnapshotDay(
  rows: Array<{
    currencyCode: string;
    mrr: DecimalLike;
    monthlySubscriptions: DecimalLike;
    annualSubscriptions: DecimalLike;
    trialSubscriptions: DecimalLike;
    usageCharges: DecimalLike;
    activeSubscriptions: number;
  }>,
): Map<
  string,
  {
    mrr: number;
    monthlySubscriptions: number;
    annualSubscriptions: number;
    trialSubscriptions: number;
    usageCharges: number;
    activeSubscriptions: number;
  }
> {
  const byCurrency = new Map<
    string,
    {
      mrr: number;
      monthlySubscriptions: number;
      annualSubscriptions: number;
      trialSubscriptions: number;
      usageCharges: number;
      activeSubscriptions: number;
    }
  >();
  for (const row of rows) {
    const entry = byCurrency.get(row.currencyCode) ?? {
      mrr: 0,
      monthlySubscriptions: 0,
      annualSubscriptions: 0,
      trialSubscriptions: 0,
      usageCharges: 0,
      activeSubscriptions: 0,
    };
    entry.mrr += Number(row.mrr);
    entry.monthlySubscriptions += Number(row.monthlySubscriptions);
    entry.annualSubscriptions += Number(row.annualSubscriptions);
    entry.trialSubscriptions += Number(row.trialSubscriptions);
    entry.usageCharges += Number(row.usageCharges);
    entry.activeSubscriptions += row.activeSubscriptions;
    byCurrency.set(row.currencyCode, entry);
  }
  return byCurrency;
}

/**
 * The MRR/active-subscriptions/growth counterpart to
 * `buildSnapshotPartnerAnalytics` — same snapshot table and readiness split,
 * for the `recurring` metric (Overview's summary cards) instead of `revenue`.
 *
 * MRR is a stock, not a flow (see `bucketDailySnapshotRevenue`'s warning) —
 * `current`/`starting` are each a single day's aggregated value, never a sum
 * across days. `current` uses the LAST day readiness guarantees is covered
 * (yesterday); `starting` uses the day at `rangeStart` itself rather than the
 * instant just before it (which would need one more day of coverage) — a
 * deliberate small boundary approximation, acceptable because this path is
 * only reached under `mode=fast`, which already accepts approximation
 * elsewhere in this file.
 *
 * Returns `timeSeries: []` and `activeCustomers: 0` on every currency — those
 * aren't persisted in this table (rolling-window and distinct-count metrics
 * are deliberately never snapshotted).
 *
 * Callers that DO need the per-bucket series ask the `recurring` endpoint for
 * `series=1`, which routes to `buildSnapshotPartnerRecurringSeries` instead —
 * Overview does, for its sparklines. (This used to say Overview was the only
 * caller and read neither field; it reads the series now.)
 */
export async function buildSnapshotPartnerRecurring(params: {
  readyAppIds: string[];
  range: ResolvedAnalyticsRange;
  now?: Date;
}): Promise<SnapshotPartnerRecurring | null> {
  const { readyAppIds: appIds, range } = params;
  if (appIds.length === 0) return null;
  const now = params.now ?? new Date();
  const todayStart = startOfUtcDay(now);
  const rangeStart = startOfUtcDay(range.start);
  const rangeEndExclusive = new Date(
    Math.min(startOfUtcDay(range.end).getTime(), todayStart.getTime()),
  );
  const lastCoveredDay = addUtcDays(rangeEndExclusive, -1);
  if (lastCoveredDay.getTime() < rangeStart.getTime()) return null;

  const [startingRows, currentRows] = await Promise.all([
    prisma.partnerDailyMrrSnapshot.findMany({
      where: { appId: { in: appIds }, snapshotDate: rangeStart },
    }),
    prisma.partnerDailyMrrSnapshot.findMany({
      where: { appId: { in: appIds }, snapshotDate: lastCoveredDay },
    }),
  ]);

  // Re-verify against the actual rows, same belt-and-suspenders as
  // `buildSnapshotPartnerAnalytics` — without this, an app missing a
  // boundary day's row would silently read as $0 instead of falling back to
  // live.
  const startingAppIds = new Set(startingRows.map((row) => row.appId));
  const currentAppIds = new Set(currentRows.map((row) => row.appId));
  for (const appId of appIds) {
    if (!startingAppIds.has(appId) || !currentAppIds.has(appId)) return null;
  }

  const startingByCurrency = aggregateSnapshotDay(startingRows);
  const currentByCurrency = aggregateSnapshotDay(currentRows);
  const zero = {
    mrr: 0,
    monthlySubscriptions: 0,
    annualSubscriptions: 0,
    trialSubscriptions: 0,
    usageCharges: 0,
    activeSubscriptions: 0,
  };
  const currencyCodes = [
    ...new Set([...startingByCurrency.keys(), ...currentByCurrency.keys()]),
  ].sort();

  const currencies: RecurringCurrencySummary[] = currencyCodes.map(
    (currency) => {
      const starting = startingByCurrency.get(currency) ?? zero;
      const current = currentByCurrency.get(currency) ?? zero;
      const mrr = round(current.mrr);
      const startingMrr = round(starting.mrr);
      const netMrrGrowth = round(mrr - startingMrr);
      return {
        currency,
        mrr,
        arr: round(mrr * 12),
        monthlySubscriptions: round(current.monthlySubscriptions),
        annualSubscriptions: round(current.annualSubscriptions),
        usageCharges: round(current.usageCharges),
        trialSubscriptions: round(current.trialSubscriptions),
        startingMrr,
        netMrrGrowth,
        growthRate: startingMrr > 0 ? round(netMrrGrowth / startingMrr, 6) : 0,
        activeSubscriptions: current.activeSubscriptions,
        activeCustomers: 0,
      };
    },
  );

  return { currencies, timeSeries: [] };
}

interface TodayRecurringDelta {
  mrr: number;
  monthlySubscriptions: number;
  annualSubscriptions: number;
  trialSubscriptions: number;
  activeSubscriptions: number;
}

interface TodayRecurringTopUp {
  /** currency -> delta, for the MRR summary and time series. */
  byCurrency: Map<string, TodayRecurringDelta>;
  /**
   * `planMrrKey` -> MRR delta, for "Top plans by MRR". Built in the same walk:
   * the contributions it already resolved carry the plan, so this costs nothing
   * extra and keeps the plan card's trailing bucket on today rather than
   * yesterday. Trials are excluded, matching every other plan-MRR path.
   */
  byPlan: Map<string, number>;
}

/**
 * Live top-up for the trailing "today" bucket of `buildSnapshotPartnerRecurringSeries`.
 * MRR is a stock, so unlike revenue's flow-based top-up (sum today's rows),
 * this needs to know whether each charge touched today is *currently active*
 * — which requires that charge's full history, not just today's rows.
 *
 * Stays cheap by scoping to only the charges that actually changed today:
 * (1) find which `(appId, chargePlatformId)` pairs have any event/sale since
 * `todayStart` (indexed single-day scan), (2) fetch only those charges' full
 * history (indexed per-charge scan, no lower bound), (3) reuse
 * `contributionAt` at the instant the cached snapshot row represents and at
 * `now` to get each charge's delta. Returns `null` when no charge could have
 * changed today, so the caller can skip everything else.
 *
 * That baseline instant is `todayStart - 1ms`, NOT `todayStart`, and the
 * difference is not academic. A snapshot row is measured at `dayEnd - 1ms`
 * (see `buildDailySnapshotRows`), so measuring the delta from `todayStart`
 * leaves a one-millisecond hole between the two — and that hole is exactly
 * where midnight-dated transitions live. Shopify's `billingOn` is normally
 * date-only, so a trial ending "today" ends at `00:00:00.000`: at
 * `23:59:59.999` it is still a trial, at `00:00:00.000` it is paying. Billing
 * the delta from `todayStart` put those conversions on neither side of the
 * seam. Total MRR
 * hid it, because `summarizeContributions` counts trials in `mrr`; only the
 * trial/paid split and the per-plan figures moved.
 *
 * "Could have changed" spans two sources, and the second is easy to forget:
 * charges with activity since midnight, AND charges that cross a clock-driven
 * threshold today with no activity at all (see
 * `clockTransitionBillingOnWindows`).
 */
async function buildTodayRecurringTopUp(
  appIds: string[],
  todayStart: Date,
  now: Date,
): Promise<TodayRecurringTopUp | null> {
  if (appIds.length === 0 || now.getTime() <= todayStart.getTime()) return null;
  /** The instant the snapshot row actually represents — see the doc comment. */
  const snapshotAt = new Date(todayStart.getTime() - 1);

  const [todayEvents, todaySales, clockEvents] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      // From `snapshotAt`, not `todayStart`, for the same reason the baseline
      // is: anything landing in that millisecond belongs on today's side.
      where: { appId: { in: appIds }, occurredAt: { gt: snapshotAt, lt: now } },
      select: { appId: true, chargePlatformId: true },
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { appId: { in: appIds }, occurredAt: { gt: snapshotAt, lt: now } },
      select: { appId: true, chargePlatformId: true },
    }),
    /* Charges that change today with no event and no sale — a trial whose
       billing date simply arrives, an unpaid charge aging past its grace
       period. Activity alone cannot find these: the transition IS the absence
       of an event. Left out, the trailing bucket kept converted trials out of
       plan MRR and kept past-due charges
       in it. Indexed by `partner_sub_event_app_billing_on_idx`. */
    prisma.partnerSubscriptionEvent.findMany({
      where: {
        appId: { in: appIds },
        OR: clockTransitionBillingOnWindows(snapshotAt, now).map((window) => ({
          billingOn: window,
        })),
      },
      select: { appId: true, chargePlatformId: true },
    }),
  ]);

  const idsByApp = new Map<string, Set<string>>();
  for (const row of [...todayEvents, ...todaySales, ...clockEvents]) {
    if (!row.chargePlatformId) continue;
    const set = idsByApp.get(row.appId) ?? new Set<string>();
    set.add(row.chargePlatformId);
    idsByApp.set(row.appId, set);
  }
  if (idsByApp.size === 0) return null;

  const chargeFilter = [...idsByApp].map(([appId, ids]) => ({
    appId,
    chargePlatformId: { in: [...ids] },
  }));

  const [historyEvents, historySales] = await Promise.all([
    prisma.partnerSubscriptionEvent.findMany({
      where: { OR: chargeFilter },
      orderBy: { occurredAt: "asc" },
    }),
    prisma.partnerSubscriptionSaleFact.findMany({
      where: { OR: chargeFilter },
      orderBy: { occurredAt: "asc" },
    }),
  ]);

  const topUpOfferPins = await resolveOfferCadencePins(historyEvents, historySales);
  const topUpLiveDiscountChecks = await loadLiveDiscountChecks(appIds, now);
  const histories = historiesFromFacts(
    historyEvents,
    historySales,
    topUpOfferPins,
    topUpLiveDiscountChecks,
  );
  const deltas = new Map<string, TodayRecurringDelta>();
  const planDeltas = new Map<string, number>();
  const zeroDelta = (): TodayRecurringDelta => ({
    mrr: 0,
    monthlySubscriptions: 0,
    annualSubscriptions: 0,
    trialSubscriptions: 0,
    activeSubscriptions: 0,
  });
  const appNames = new Map(
    (
      await prisma.app.findMany({
        where: { id: { in: appIds } },
        select: { id: true, name: true },
      })
    ).map((app) => [app.id, app.name] as const),
  );
  const addPlanDelta = (
    appId: string,
    contribution: ChargeContribution,
    sign: 1 | -1,
  ) => {
    if (contribution.kind === "trial") return;
    const plan = mantlePlanLabel(appNames.get(appId), contribution);
    if (!plan) return;
    const key = planMrrKey(contribution.currency, appId, plan);
    planDeltas.set(key, (planDeltas.get(key) ?? 0) + sign * contribution.amount);
  };

  for (const history of histories) {
    const before = contributionAt(history, snapshotAt);
    const after = contributionAt(history, now);
    if (!before && !after) continue;

    if (before) {
      const entry = deltas.get(before.currency) ?? zeroDelta();
      entry.mrr -= before.amount;
      entry.activeSubscriptions -= 1;
      if (before.kind === "monthly") entry.monthlySubscriptions -= before.amount;
      else if (before.kind === "annual") entry.annualSubscriptions -= before.amount;
      else entry.trialSubscriptions -= before.amount;
      deltas.set(before.currency, entry);
      addPlanDelta(history.appId, before, -1);
    }
    if (after) {
      const entry = deltas.get(after.currency) ?? zeroDelta();
      entry.mrr += after.amount;
      entry.activeSubscriptions += 1;
      if (after.kind === "monthly") entry.monthlySubscriptions += after.amount;
      else if (after.kind === "annual") entry.annualSubscriptions += after.amount;
      else entry.trialSubscriptions += after.amount;
      deltas.set(after.currency, entry);
      addPlanDelta(history.appId, after, 1);
    }
  }

  return { byCurrency: deltas, byPlan: planDeltas };
}

/**
 * The full per-bucket counterpart to `buildSnapshotPartnerRecurring` — same
 * table and boundary-summary logic, but also builds `RecurringPoint[]` for
 * every bucket in `range`, needed by Reports' `mrr`/`portfolio`/`ltv`
 * metrics. `buildSnapshotPartnerRecurring` stays a cheap 2-day fetch for the
 * Dashboard's summary cards, which never need a time series.
 *
 * Bucket-to-day mapping: for bucket `b`, the picked day is
 * `min(b.end, rangeEndExclusive) - 1 day` — `b.end`'s own last day for a
 * past bucket, or `rangeEndExclusive - 1 day` for the trailing bucket
 * containing "today" (same "current = yesterday" convention
 * `buildSnapshotPartnerRecurring` uses). The trailing bucket additionally
 * gets a live top-up from `buildTodayRecurringTopUp` — see that function's
 * doc comment for why this needs more than "sum today's rows."
 */
export async function buildSnapshotPartnerRecurringSeries(params: {
  readyAppIds: string[];
  range: ResolvedAnalyticsRange;
  now?: Date;
}): Promise<SnapshotPartnerRecurring | null> {
  const { readyAppIds: appIds, range } = params;
  if (appIds.length === 0) return null;
  const now = params.now ?? new Date();
  const todayStart = startOfUtcDay(now);
  const rangeStart = startOfUtcDay(range.start);
  const rangeEndExclusive = new Date(
    Math.min(startOfUtcDay(range.end).getTime(), todayStart.getTime()),
  );
  if (rangeEndExclusive.getTime() <= rangeStart.getTime()) return null;

  const rows = await prisma.partnerDailyMrrSnapshot.findMany({
    where: {
      appId: { in: appIds },
      /* 30 days BEFORE the range too, purely as the base for the
         trailing-30-day growth rate below. Coverage is still only required
         across the range itself (the loop after this) — a missing day in the
         lead-in makes one bucket's rate null, which the chart handles, and must
         not fail the whole report to the live path. */
      snapshotDate: {
        gte: addUtcDays(rangeStart, -MONTHLY_GROWTH_LOOKBACK_DAYS),
        lt: rangeEndExclusive,
      },
    },
  });

  // Re-verify every expected day is covered for every app — same
  // belt-and-suspenders as the other snapshot builders; a partial gap must
  // fail closed to the live path, not silently under-report a day.
  const coveredByApp = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = coveredByApp.get(row.appId) ?? new Set<number>();
    set.add(row.snapshotDate.getTime());
    coveredByApp.set(row.appId, set);
  }
  for (
    let day = rangeStart;
    day.getTime() < rangeEndExclusive.getTime();
    day = addUtcDays(day, 1)
  ) {
    for (const appId of appIds) {
      if (!coveredByApp.get(appId)?.has(day.getTime())) return null;
    }
  }

  const byDay = new Map<number, (typeof rows)[number][]>();
  for (const row of rows) {
    const list = byDay.get(row.snapshotDate.getTime());
    if (list) list.push(row);
    else byDay.set(row.snapshotDate.getTime(), [row]);
  }
  const zero = {
    mrr: 0,
    monthlySubscriptions: 0,
    annualSubscriptions: 0,
    trialSubscriptions: 0,
    usageCharges: 0,
    activeSubscriptions: 0,
  };
  const aggregateForDay = (dayMs: number) =>
    aggregateSnapshotDay(byDay.get(dayMs) ?? []);

  // The trailing bucket (today, carried forward from yesterday's snapshot
  // row) gets a live top-up when the range actually reaches "now" — see
  // `buildTodayRecurringTopUp` for why this needs more than "sum today's
  // rows." `null` (no touched charges, or range doesn't reach today) means
  // no adjustment is needed anywhere below.
  const trailingDayMs = rangeEndExclusive.getTime() - DAY_MS;
  const includesToday = rangeEndExclusive.getTime() < range.end.getTime();
  const topUpDeltas = includesToday
    ? await buildTodayRecurringTopUp(appIds, rangeEndExclusive, now)
    : null;
  const applyTopUp = <
    T extends {
      mrr: number;
      monthlySubscriptions: number;
      annualSubscriptions: number;
      trialSubscriptions: number;
      activeSubscriptions: number;
    },
  >(
    currency: string,
    point: T,
  ): T => {
    const delta = topUpDeltas?.byCurrency.get(currency);
    if (!delta) return point;
    return {
      ...point,
      mrr: point.mrr + delta.mrr,
      monthlySubscriptions: point.monthlySubscriptions + delta.monthlySubscriptions,
      annualSubscriptions: point.annualSubscriptions + delta.annualSubscriptions,
      trialSubscriptions: point.trialSubscriptions + delta.trialSubscriptions,
      activeSubscriptions: point.activeSubscriptions + delta.activeSubscriptions,
    };
  };

  const buckets = buildUtcBuckets(range);
  const currencyCodes = [
    ...new Set([
      ...rows.map((row) => row.currencyCode),
      ...(topUpDeltas ? [...topUpDeltas.byCurrency.keys()] : []),
    ]),
  ].sort();
  const timeSeries: RecurringPoint[] = [];
  for (const bucket of buckets) {
    const pickedDayMs =
      Math.min(bucket.end.getTime(), rangeEndExclusive.getTime()) - DAY_MS;
    // `pickedDayMs` alone isn't a safe trailing-bucket test: the last
    // *finalized* bucket can clamp to the same picked day as the actual
    // trailing bucket (both reduce to yesterday's snapshot row under the
    // carry-forward convention above), which would apply the live top-up to
    // a finalized day too. `bucket.provisional` is the real signal.
    const isTrailingBucket = bucket.provisional;
    const byCurrency = aggregateForDay(pickedDayMs);
    const baseByCurrency = aggregateForDay(
      pickedDayMs - MONTHLY_GROWTH_LOOKBACK_DAYS * DAY_MS,
    );
    for (const currency of currencyCodes) {
      const rawPoint = byCurrency.get(currency) ?? zero;
      const base = baseByCurrency.get(currency) ?? zero;
      const point = isTrailingBucket ? applyTopUp(currency, rawPoint) : rawPoint;
      timeSeries.push({
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        currency,
        monthlySubscriptions: round(point.monthlySubscriptions),
        annualSubscriptions: round(point.annualSubscriptions),
        usageCharges: round(point.usageCharges),
        trialSubscriptions: round(point.trialSubscriptions),
        mrr: round(point.mrr),
        arr: round(point.mrr * 12),
        activeSubscriptions: point.activeSubscriptions,
        activeCustomers: 0,
        mrrThirtyDaysAgo: round(base.mrr),
        /* Same definition the live path computes from `subscriptionChurnAt`'s
           30-day-back pass, so the growth-rate chart reads identically whichever
           path served the page. Verified against Mantle's own CSV export to
           ~0.1pt on consecutive days. */
        monthlyMrrGrowthRate:
          base.mrr > 0
            ? round((point.mrr - base.mrr) / base.mrr, 6)
            : null,
        provisional: bucket.provisional,
      });
    }
  }

  const startingByCurrency = aggregateForDay(rangeStart.getTime());
  const currentByCurrency = aggregateForDay(trailingDayMs);
  const currencies: RecurringCurrencySummary[] = currencyCodes.map((currency) => {
    const starting = startingByCurrency.get(currency) ?? zero;
    const current = applyTopUp(currency, currentByCurrency.get(currency) ?? zero);
    const mrr = round(current.mrr);
    const startingMrr = round(starting.mrr);
    const netMrrGrowth = round(mrr - startingMrr);
    return {
      currency,
      mrr,
      arr: round(mrr * 12),
      monthlySubscriptions: round(current.monthlySubscriptions),
      annualSubscriptions: round(current.annualSubscriptions),
      usageCharges: round(current.usageCharges),
      trialSubscriptions: round(current.trialSubscriptions),
      startingMrr,
      netMrrGrowth,
      growthRate: startingMrr > 0 ? round(netMrrGrowth / startingMrr, 6) : 0,
      activeSubscriptions: current.activeSubscriptions,
      activeCustomers: 0,
    };
  });

  /* The same rows this function already proved cover every day in range, read
     again as a FLOW. Its own coverage check is therefore redundant here and
     cheap — and it keeps `buildSnapshotMrrMovement` usable on its own. */
  const movement = await buildSnapshotMrrMovement({
    readyAppIds: appIds,
    range,
    now,
  });

  const planSeries = await buildSnapshotPlanSeries({
    appIds,
    buckets,
    rangeEndExclusive,
    topUp: topUpDeltas,
  });

  return {
    currencies,
    timeSeries,
    movement: movement ?? undefined,
    planSeries,
  };
}

/**
 * "Top plans by MRR" from `PartnerDailyPlanMrrSnapshot`.
 *
 * Reads only the days the buckets actually land on — one per bucket under the
 * same carry-forward convention `timeSeries` uses above — rather than every day
 * in range. A plan series is a STOCK sampled per bucket, so intermediate days
 * carry no information the chart shows, and at a month interval over all time
 * that is ~60 days read instead of ~1,800.
 *
 * Ranking, labelling and the cap all come from `rankPlanMrrSeries`, shared with
 * the live reconstruction, so the card cannot differ by which path served it.
 */
async function buildSnapshotPlanSeries(params: {
  appIds: string[];
  buckets: Array<{ start: Date; end: Date; provisional: boolean }>;
  rangeEndExclusive: Date;
  topUp: TodayRecurringTopUp | null;
}): Promise<PlanMrrSeries[] | undefined> {
  const { appIds, buckets, rangeEndExclusive } = params;
  if (buckets.length === 0) return undefined;

  const pickedDays = buckets.map(
    (bucket) =>
      new Date(
        Math.min(bucket.end.getTime(), rangeEndExclusive.getTime()) - DAY_MS,
      ),
  );
  const rows = await prisma.partnerDailyPlanMrrSnapshot.findMany({
    where: {
      appId: { in: appIds },
      snapshotDate: { in: pickedDays },
    },
    select: {
      appId: true,
      snapshotDate: true,
      currencyCode: true,
      plan: true,
      mrr: true,
    },
  });
  /* No rows at all means this table has not been backfilled for the range —
     report nothing so the caller can hide the card, rather than publishing an
     empty chart that reads as "no plans have revenue". A range where plans
     genuinely earned nothing produces no rows either, and hiding the card is
     the right answer there too. */
  if (rows.length === 0) return undefined;

  /* Day -> EVERY bucket that reads it, not one. The trailing bucket and the
     last finalized bucket both clamp to yesterday, and `timeSeries` reads that
     day for both — so a day->single-index map silently left one of those two
     buckets at zero, drawing a cliff at the right-hand edge of the chart. */
  const bucketIndexesByDay = new Map<number, number[]>();
  pickedDays.forEach((day, index) => {
    const existing = bucketIndexesByDay.get(day.getTime());
    if (existing) existing.push(index);
    else bucketIndexesByDay.set(day.getTime(), [index]);
  });

  const planMrr = new Map<string, Float64Array>();
  const seriesFor = (currency: string, appId: string, plan: string) => {
    const key = planMrrKey(currency, appId, plan);
    const existing = planMrr.get(key);
    if (existing) return existing;
    const created = new Float64Array(buckets.length);
    planMrr.set(key, created);
    return created;
  };
  for (const row of rows) {
    const indexes = bucketIndexesByDay.get(row.snapshotDate.getTime());
    if (!indexes) continue;
    const series = seriesFor(row.currencyCode, row.appId, row.plan);
    for (const index of indexes) series[index] = Number(row.mrr);
  }

  /* The provisional bucket carries today, whose plan rows do not exist yet —
     snapshots are only ever written for finalized days. Without this the card
     would show yesterday's figures while the MRR chart beside it shows today's,
     and the two would visibly disagree. `buildTodayRecurringTopUp` already
     resolved today's contributions for every charge touched since midnight, so
     the per-plan deltas are free. */
  let trailingIndex = -1;
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    if (buckets[index]?.provisional) {
      trailingIndex = index;
      break;
    }
  }
  if (trailingIndex >= 0 && params.topUp) {
    for (const [key, delta] of params.topUp.byPlan) {
      const existing = planMrr.get(key);
      if (existing) {
        existing[trailingIndex] += delta;
        continue;
      }
      /* A plan whose first-ever charge activated today has no snapshot row to
         add to — it still belongs on the chart, so start a series for it. */
      const created = new Float64Array(buckets.length);
      created[trailingIndex] = delta;
      planMrr.set(key, created);
    }
  }

  const appNames = new Map(
    (
      await prisma.app.findMany({
        where: { id: { in: appIds } },
        select: { id: true, name: true },
      })
    ).map((app) => [app.id, app.name] as const),
  );
  return rankPlanMrrSeries({ planMrr, buckets, appNames });
}

/**
 * Additive merge for `buildSnapshotPartnerRecurring`'s output with a live
 * reconstruction covering the remaining apps — same partial-coverage shape
 * as `mergeRevenueReports`, but per-currency summaries instead of a bucketed
 * time series. `netMrrGrowth`/`growthRate` are recomputed from the merged
 * `mrr`/`startingMrr` rather than summed directly — recomputing from the
 * merged stock values is the only obviously-correct operation here.
 */
/** The money categories, so a merge cannot silently miss one. */
const MOVEMENT_MERGE_KEYS = [
  "new",
  "reactivation",
  "expansion",
  "contraction",
  "churn",
  "frozen",
  "unfrozen",
  "earlyPlanChange",
] as const;

/**
 * Adds two partial-coverage movement reports into one.
 *
 * Both sides describe the same buckets over different apps, so the categories
 * are plain sums and `net` is recomputed from them rather than added — adding
 * two nets would be right today and wrong the moment `mrrMovementNet`'s
 * definition changes.
 *
 * Returns `undefined` unless BOTH sides have movement. A movement figure is a
 * FLOW, and one side's flow presented as the whole is not a smaller truth, it
 * is a wrong number — the same reason `buildSnapshotMrrMovement` returns null
 * on a partly-covered range instead of a short total. The caller hides the
 * table, which is the honest outcome.
 */
function mergeMrrMovementSummaries(
  a: MrrMovementSummary[] | undefined,
  b: MrrMovementSummary[] | undefined,
): MrrMovementSummary[] | undefined {
  if (!a || !b) return undefined;

  const currencies = [
    ...new Set([...a.map((entry) => entry.currency), ...b.map((entry) => entry.currency)]),
  ].sort();

  return currencies.map((currency) => {
    const sides = [a, b].map((side) => side.find((entry) => entry.currency === currency));
    const byStart = new Map<string, MrrMovementBucket>();
    const order: string[] = [];
    for (const side of sides) {
      for (const bucket of side?.buckets ?? []) {
        const key = bucket.periodStart ?? "";
        let merged = byStart.get(key);
        if (!merged) {
          merged = { ...EMPTY_MRR_MOVEMENT_BUCKET, ...{ periodStart: bucket.periodStart, periodEnd: bucket.periodEnd } };
          byStart.set(key, merged);
          order.push(key);
        }
        for (const field of MOVEMENT_MERGE_KEYS) merged[field] += bucket[field];
      }
    }
    const buckets = order
      .sort()
      .map((key) => byStart.get(key)!)
      .map((bucket) => ({ ...bucket, net: mrrMovementNet(bucket) }));

    const total: MrrMovementBucket = { ...EMPTY_MRR_MOVEMENT_BUCKET };
    for (const bucket of buckets) {
      for (const field of MOVEMENT_MERGE_KEYS) total[field] += bucket[field];
    }
    total.net = mrrMovementNet(total);
    return { currency, buckets, total };
  });
}

export function mergeRecurringReports(
  a: SnapshotPartnerRecurring,
  b: SnapshotPartnerRecurring,
): SnapshotPartnerRecurring {
  const currencyCodes = [
    ...new Set([...a.currencies.map((c) => c.currency), ...b.currencies.map((c) => c.currency)]),
  ].sort();

  const currencies: RecurringCurrencySummary[] = currencyCodes.map((currency) => {
    const left = a.currencies.find((c) => c.currency === currency);
    const right = b.currencies.find((c) => c.currency === currency);
    const mrr = round((left?.mrr ?? 0) + (right?.mrr ?? 0));
    const startingMrr = round((left?.startingMrr ?? 0) + (right?.startingMrr ?? 0));
    const netMrrGrowth = round(mrr - startingMrr);
    return {
      currency,
      mrr,
      arr: round(mrr * 12),
      monthlySubscriptions: round(
        (left?.monthlySubscriptions ?? 0) + (right?.monthlySubscriptions ?? 0),
      ),
      annualSubscriptions: round(
        (left?.annualSubscriptions ?? 0) + (right?.annualSubscriptions ?? 0),
      ),
      usageCharges: round((left?.usageCharges ?? 0) + (right?.usageCharges ?? 0)),
      trialSubscriptions: round(
        (left?.trialSubscriptions ?? 0) + (right?.trialSubscriptions ?? 0),
      ),
      startingMrr,
      netMrrGrowth,
      growthRate: startingMrr > 0 ? round(netMrrGrowth / startingMrr, 6) : 0,
      activeSubscriptions: (left?.activeSubscriptions ?? 0) + (right?.activeSubscriptions ?? 0),
      activeCustomers: (left?.activeCustomers ?? 0) + (right?.activeCustomers ?? 0),
    };
  });

  /* Both sides can carry movement now — the live reconstruction folds it too
     (see `buildMrrMovementFromHistories`'s call site) — so this is a sum, not
     the hand-off it used to be. `a.movement ?? b.movement` silently published
     one side's apps as the whole business. */
  return {
    currencies,
    timeSeries: [],
    movement: mergeMrrMovementSummaries(a.movement, b.movement),
  };
}

/**
 * Same currency-summary merge as `mergeRecurringReports`, plus a bucket-for-
 * bucket, currency-for-currency merge of `timeSeries` — needed by `mrr`/
 * `portfolio`/`ltv`, which render the full per-bucket chart. Points are
 * matched by `(periodStart, currency)` rather than array position/length,
 * since the two sides can have different currency sets or bucket counts.
 * Every merged point zeroes `activeCustomers` and omits the other distinct-
 * count/rolling-window fields — they have no meaningful "sum of a
 * snapshot-served app plus a live-served app" value, and no Reports panel
 * reads them.
 */
export function mergeRecurringSeriesReports(
  a: SnapshotPartnerRecurring,
  b: SnapshotPartnerRecurring,
): SnapshotPartnerRecurring {
  const { currencies, movement } = mergeRecurringReports(a, b);

  interface MergedPointKey {
    periodStart: string;
    periodEnd: string;
    currency: string;
    provisional: boolean;
    left?: RecurringPoint;
    right?: RecurringPoint;
  }
  const byKey = new Map<string, MergedPointKey>();
  for (const point of a.timeSeries) {
    const key = `${point.periodStart}|${point.currency}`;
    byKey.set(key, {
      periodStart: point.periodStart,
      periodEnd: point.periodEnd,
      currency: point.currency,
      provisional: point.provisional,
      left: point,
    });
  }
  for (const point of b.timeSeries) {
    const key = `${point.periodStart}|${point.currency}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      periodStart: point.periodStart,
      periodEnd: point.periodEnd,
      currency: point.currency,
      provisional: (existing?.provisional ?? false) || point.provisional,
      left: existing?.left,
      right: point,
    });
  }

  const timeSeries: RecurringPoint[] = [...byKey.values()]
    .sort(
      (x, y) =>
        x.periodStart.localeCompare(y.periodStart) ||
        x.currency.localeCompare(y.currency),
    )
    .map(({ periodStart, periodEnd, currency, provisional, left, right }) => {
      const mrr = round((left?.mrr ?? 0) + (right?.mrr ?? 0));
      const mrrThirtyDaysAgo = round(
        (left?.mrrThirtyDaysAgo ?? 0) + (right?.mrrThirtyDaysAgo ?? 0),
      );
      return {
        periodStart,
        periodEnd,
        currency,
        monthlySubscriptions: round(
          (left?.monthlySubscriptions ?? 0) + (right?.monthlySubscriptions ?? 0),
        ),
        annualSubscriptions: round(
          (left?.annualSubscriptions ?? 0) + (right?.annualSubscriptions ?? 0),
        ),
        usageCharges: round((left?.usageCharges ?? 0) + (right?.usageCharges ?? 0)),
        trialSubscriptions: round(
          (left?.trialSubscriptions ?? 0) + (right?.trialSubscriptions ?? 0),
        ),
        mrr,
        arr: round(mrr * 12),
        activeSubscriptions:
          (left?.activeSubscriptions ?? 0) + (right?.activeSubscriptions ?? 0),
        activeCustomers: 0,
        mrrThirtyDaysAgo,
        /* RECOMPUTED from the merged level, never averaged: a growth rate is a
           ratio, and the mean of two ratios over different denominators is not
           the ratio of the sums. Dropping these two fields entirely — which is
           what this merge did before — left `monthlyMrrGrowthRate` undefined,
           and the panel reads it as `?? 0`, so the growth-rate chart drew a
           flat 0% line and headlined 0% whenever coverage was partial. */
        monthlyMrrGrowthRate:
          mrrThirtyDaysAgo > 0
            ? round((mrr - mrrThirtyDaysAgo) / mrrThirtyDaysAgo, 6)
            : null,
        provisional,
      };
    });

  /* Plan series are re-ranked across BOTH sides rather than concatenated: each
     side's list is already capped at the top few of its own apps, so appending
     them would publish up to twice the cap and rank two independently-truncated
     lists against each other. Summing per (currency, app, plan) and re-ranking
     is the same answer a single-path run would give. A plan appearing on only
     one side keeps its own points, since the other side never carried it. */
  const planMrr = new Map<string, Float64Array>();
  const bucketStarts = [
    ...new Set(
      [...(a.planSeries ?? []), ...(b.planSeries ?? [])].flatMap((series) =>
        series.points.map((point) => point.periodStart),
      ),
    ),
  ].sort();
  const indexByStart = new Map(
    bucketStarts.map((start, index) => [start, index] as const),
  );
  for (const series of [...(a.planSeries ?? []), ...(b.planSeries ?? [])]) {
    /* The app id is not carried on a published series — only the label is, and
       that label is already app-disambiguated where it needed to be. Keying on
       it alone is therefore exactly as precise as the label the chart shows. */
    const key = planMrrKey(series.currency, "", series.plan);
    const totals =
      planMrr.get(key) ?? new Float64Array(bucketStarts.length);
    for (const point of series.points) {
      const index = indexByStart.get(point.periodStart);
      if (index === undefined) continue;
      totals[index] += point.mrr;
    }
    planMrr.set(key, totals);
  }
  const planSeries =
    planMrr.size > 0
      ? rankPlanMrrSeries({
          planMrr,
          buckets: bucketStarts.map((start) => ({ start: new Date(start) })),
        })
      : undefined;

  return { currencies, timeSeries, movement, planSeries };
}

/**
 * Pure bucketing step, split out from `buildSnapshotPartnerAnalytics` so it
 * can be unit-tested without a live database. Revenue is a flow field: a
 * bucket's value is the sum of every snapshotted day's `revenueGross` inside
 * it, mirroring `buildPartnerRevenueFromFacts`'s own per-bucket summation.
 * (If ever extended to a stock field like `mrr`, that MUST use the bucket's
 * last day, never a sum — the easiest correctness bug to introduce here.)
 *
 * The trailing bucket (today, or an in-progress week/month) is never built
 * from snapshot rows — readiness already excludes "today", so `rows` never
 * includes it; the caller's own live fallback supplies that one bucket.
 */
export function bucketDailySnapshotRevenue(
  rows: Array<Pick<DailySnapshotRow, "snapshotDate" | "currencyCode"> & {
    revenueGross: number | { toString(): string };
  }>,
  range: ResolvedAnalyticsRange,
): ReturnType<typeof buildPartnerRevenueFromFacts> {
  const buckets = buildUtcBuckets({
    start: range.start,
    end: range.end,
    interval: range.interval,
  });

  const currencies = [...new Set(rows.map((row) => row.currencyCode))].sort();
  const grossByCurrency = new Map<string, number[]>();
  for (const currency of currencies) {
    grossByCurrency.set(currency, new Array(buckets.length).fill(0));
  }
  for (const row of rows) {
    const totals = grossByCurrency.get(row.currencyCode);
    if (!totals) continue;
    const occurredAt = row.snapshotDate.getTime();
    let low = 0;
    let high = buckets.length - 1;
    let index = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (buckets[middle].start.getTime() <= occurredAt) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (index < 0 || occurredAt >= buckets[index].end.getTime()) continue;
    totals[index] += Number(row.revenueGross);
  }

  return {
    period: range.period,
    periodStart: range.start.toISOString(),
    periodEnd: range.end.toISOString(),
    interval: range.interval,
    currencies: currencies.map((currency) => {
      const totals = grossByCurrency.get(currency)!;
      const timeSeries = buckets.map((bucket, index) => {
        const gross = round(totals[index]);
        return {
          periodStart: bucket.start.toISOString(),
          periodEnd: bucket.end.toISOString(),
          gross,
          credits: 0,
          net: gross,
          provisional: bucket.provisional,
        };
      });
      const gross = round(
        timeSeries.reduce((sum, point) => sum + point.gross, 0),
      );
      return {
        currency,
        value: { gross, credits: 0, net: gross },
        timeSeries,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Churn read path
// ---------------------------------------------------------------------------

/**
 * Readiness check for the ORG-WIDE logo-churn scope
 * (`PartnerDailyLogoChurnSnapshot` rows with `appId = ORG_WIDE_LOGO_SCOPE_ID`)
 * — reuses `evaluateSnapshotCompleteness` by treating the whole org as a
 * single pseudo-app entry. "Dirty" means ANY enabled app in the org has a
 * `logoSnapshotDirtyFrom` older than the requested range's end.
 */
export async function orgWideLogoSnapshotReadiness(params: {
  organizationId: string;
  appIds: string[];
  range: Pick<ResolvedAnalyticsRange, "start" | "end">;
  now?: Date;
}): Promise<PartnerSnapshotReadiness> {
  const { organizationId, appIds, range } = params;
  if (appIds.length === 0) {
    return { applied: false, appIds: [ORG_WIDE_LOGO_SCOPE_ID], readyAppIds: [], liveAppIds: [], missingDays: -1 };
  }
  const todayStart = startOfUtcDay(params.now ?? new Date());
  const rangeStart = startOfUtcDay(range.start);
  const rangeEndExclusive = new Date(
    Math.min(startOfUtcDay(range.end).getTime(), todayStart.getTime()),
  );
  const [rows, apps] =
    rangeEndExclusive.getTime() > rangeStart.getTime()
      ? await Promise.all([
          prisma.partnerDailyLogoChurnSnapshot.findMany({
            where: {
              organizationId,
              appId: ORG_WIDE_LOGO_SCOPE_ID,
              snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
            },
            select: { appId: true, snapshotDate: true },
          }),
          prisma.app.findMany({
            where: { id: { in: appIds } },
            select: { logoSnapshotDirtyFrom: true },
          }),
        ])
      : [[], []];
  const dirtyValues = apps
    .map((app) => app.logoSnapshotDirtyFrom)
    .filter((value): value is Date => value !== null);
  const minDirty =
    dirtyValues.length > 0
      ? new Date(Math.min(...dirtyValues.map((value) => value.getTime())))
      : null;
  return evaluateSnapshotCompleteness({
    appIds: [ORG_WIDE_LOGO_SCOPE_ID],
    rangeStart,
    rangeEndExclusive,
    rows,
    dirtyFromByApp: new Map([[ORG_WIDE_LOGO_SCOPE_ID, minDirty]]),
  });
}

/**
 * Snapshot-backed `ChurnReport`, mirroring
 * `buildSnapshotPartnerRecurringSeries`'s fail-closed shape.
 * `subscription`/`grossRevenue` are served from `PartnerDailyMrrSnapshot`
 * (proven equivalent to live `buildPartnerChurnFromFacts` output — see
 * `tests/partner-mrr-snapshot-churn.test.ts`), scoped to `mrrReadyAppIds`.
 * `logo` is served from `PartnerDailyLogoChurnSnapshot`, scoped to EITHER one
 * real `appId` OR `ORG_WIDE_LOGO_SCOPE_ID` — never both/summed, since a shop
 * active in multiple apps must never be double-counted.
 *
 * Returns `null` (fail closed to live) if `mrrReadyAppIds` is empty or
 * either table has a day-coverage gap for the requested scope.
 */
export async function buildSnapshotPartnerChurnSeries(params: {
  organizationId: string;
  mrrReadyAppIds: string[];
  logoScope: { kind: "single"; appId: string } | { kind: "all" };
  range: ResolvedAnalyticsRange;
  now?: Date;
}): Promise<ChurnReport | null> {
  const { organizationId, mrrReadyAppIds, logoScope, range } = params;
  if (mrrReadyAppIds.length === 0) return null;
  const now = params.now ?? new Date();
  const todayStart = startOfUtcDay(now);
  const rangeStart = startOfUtcDay(range.start);
  const rangeEndExclusive = new Date(
    Math.min(startOfUtcDay(range.end).getTime(), todayStart.getTime()),
  );
  if (rangeEndExclusive.getTime() <= rangeStart.getTime()) return null;

  const mrrRows = await prisma.partnerDailyMrrSnapshot.findMany({
    where: {
      appId: { in: mrrReadyAppIds },
      snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
    },
    select: {
      appId: true,
      snapshotDate: true,
      currencyCode: true,
      mrr: true,
      activeSubscriptions: true,
      subscriptionChurnedCount: true,
      subscriptionRecoveredCount: true,
      churnedRevenueLost: true,
    },
  });
  const mrrCoveredByApp = new Map<string, Set<number>>();
  for (const row of mrrRows) {
    const set = mrrCoveredByApp.get(row.appId) ?? new Set<number>();
    set.add(row.snapshotDate.getTime());
    mrrCoveredByApp.set(row.appId, set);
  }
  for (
    let day = rangeStart;
    day.getTime() < rangeEndExclusive.getTime();
    day = addUtcDays(day, 1)
  ) {
    for (const appId of mrrReadyAppIds) {
      if (!mrrCoveredByApp.get(appId)?.has(day.getTime())) return null;
    }
  }

  const logoAppId =
    logoScope.kind === "single" ? logoScope.appId : ORG_WIDE_LOGO_SCOPE_ID;
  const logoRows = await prisma.partnerDailyLogoChurnSnapshot.findMany({
    where: {
      organizationId,
      appId: logoAppId,
      snapshotDate: { gte: rangeStart, lt: rangeEndExclusive },
    },
    select: { snapshotDate: true, activeShops: true, churnedShops: true, recoveredShops: true },
  });
  const logoCoveredDays = new Set(logoRows.map((row) => row.snapshotDate.getTime()));
  for (
    let day = rangeStart;
    day.getTime() < rangeEndExclusive.getTime();
    day = addUtcDays(day, 1)
  ) {
    if (!logoCoveredDays.has(day.getTime())) return null;
  }

  // Subscription-level counts are written identically onto every currency
  // row for a given (appId, day), so they must be deduped per (appId, day)
  // before summing, or an app billing in 2 currencies double-counts churn.
  const subCountsByAppDay = new Map<string, { churned: number; recovered: number }>();
  for (const row of mrrRows) {
    const key = `${row.appId}:${row.snapshotDate.getTime()}`;
    if (!subCountsByAppDay.has(key)) {
      subCountsByAppDay.set(key, {
        churned: row.subscriptionChurnedCount,
        recovered: row.subscriptionRecoveredCount,
      });
    }
  }
  const subCountsByDay = new Map<number, { churned: number; recovered: number }>();
  for (const [key, value] of subCountsByAppDay) {
    const day = Number(key.slice(key.lastIndexOf(":") + 1));
    const entry = subCountsByDay.get(day) ?? { churned: 0, recovered: 0 };
    entry.churned += value.churned;
    entry.recovered += value.recovered;
    subCountsByDay.set(day, entry);
  }
  // activeSubscriptions IS partitioned per currency (unlike the counts
  // above), so summing every row's value for a day recovers the true
  // cross-currency, cross-app total with no dedup needed.
  const activeSubsByDay = new Map<number, number>();
  const mrrByDayAndCurrency = new Map<string, number>();
  const revenueLostByDayAndCurrency = new Map<string, number>();
  const currencyCodes = new Set<string>();
  for (const row of mrrRows) {
    const day = row.snapshotDate.getTime();
    activeSubsByDay.set(day, (activeSubsByDay.get(day) ?? 0) + row.activeSubscriptions);
    currencyCodes.add(row.currencyCode);
    const key = `${day}:${row.currencyCode}`;
    mrrByDayAndCurrency.set(key, (mrrByDayAndCurrency.get(key) ?? 0) + Number(row.mrr));
    revenueLostByDayAndCurrency.set(
      key,
      (revenueLostByDayAndCurrency.get(key) ?? 0) + Number(row.churnedRevenueLost),
    );
  }
  const logoCountsByDay = new Map<number, { activeShops: number; churned: number; recovered: number }>();
  for (const row of logoRows) {
    logoCountsByDay.set(row.snapshotDate.getTime(), {
      activeShops: row.activeShops,
      churned: row.churnedShops,
      recovered: row.recoveredShops,
    });
  }

  const buckets = buildUtcBuckets(range);

  function sumInBucket(
    bucket: { start: Date; end: Date },
    byDay: Map<number, { churned: number; recovered: number }>,
    field: "churned" | "recovered",
  ): number {
    let sum = 0;
    for (
      let day = bucket.start.getTime();
      day < bucket.end.getTime();
      day += DAY_MS
    ) {
      sum += byDay.get(day)?.[field] ?? 0;
    }
    return sum;
  }

  const subscriptionTimeSeries: CountChurnPoint[] = buckets.map((bucket) => {
    const lost = sumInBucket(bucket, subCountsByDay, "churned");
    const recovered = sumInBucket(bucket, subCountsByDay, "recovered");
    const netLost = lost - recovered;
    const denominator = activeSubsByDay.get(bucket.start.getTime()) ?? 0;
    return {
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      lost,
      recovered,
      netLost,
      denominator,
      rate: denominator ? round(netLost / denominator, 6) : 0,
      provisional: bucket.provisional,
    };
  });
  const logoTimeSeries: CountChurnPoint[] = buckets.map((bucket) => {
    const lost = sumInBucket(bucket, logoCountsByDay, "churned");
    const recovered = sumInBucket(bucket, logoCountsByDay, "recovered");
    const netLost = lost - recovered;
    const denominator = logoCountsByDay.get(bucket.start.getTime())?.activeShops ?? 0;
    return {
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      lost,
      recovered,
      netLost,
      denominator,
      rate: denominator ? round(netLost / denominator, 6) : 0,
      provisional: bucket.provisional,
    };
  });
  const revenueCurrencies: RevenueChurnCurrencyReport[] = [...currencyCodes]
    .sort()
    .map((currency) => {
      const timeSeries: RevenueChurnPoint[] = buckets.map((bucket) => {
        let lostMrr = 0;
        for (
          let day = bucket.start.getTime();
          day < bucket.end.getTime();
          day += DAY_MS
        ) {
          lostMrr += revenueLostByDayAndCurrency.get(`${day}:${currency}`) ?? 0;
        }
        const startMrr = mrrByDayAndCurrency.get(`${bucket.start.getTime()}:${currency}`) ?? 0;
        return {
          periodStart: bucket.start.toISOString(),
          periodEnd: bucket.end.toISOString(),
          lostMrr: round(lostMrr),
          startMrr: round(startMrr),
          rate: startMrr ? round(lostMrr / startMrr, 6) : 0,
          provisional: bucket.provisional,
        };
      });
      const lostMrr = round(timeSeries.reduce((sum, point) => sum + point.lostMrr, 0));
      const startMrr = timeSeries[0]?.startMrr ?? 0;
      return {
        currency,
        value: { lostMrr, startMrr, rate: startMrr ? round(lostMrr / startMrr, 6) : 0 },
        timeSeries,
      };
    });

  const subNet = subscriptionTimeSeries.reduce((sum, point) => sum + point.netLost, 0);
  const logoNet = logoTimeSeries.reduce((sum, point) => sum + point.netLost, 0);
  const subDenominator = subscriptionTimeSeries[0]?.denominator ?? 0;
  const logoDenominator = logoTimeSeries[0]?.denominator ?? 0;

  return {
    period: range.period,
    periodStart: range.start.toISOString(),
    periodEnd: range.end.toISOString(),
    interval: range.interval,
    logo: {
      value: logoDenominator ? round(logoNet / logoDenominator, 6) : 0,
      netLost: logoNet,
      denominator: logoDenominator,
      timeSeries: logoTimeSeries,
    },
    subscription: {
      value: subDenominator ? round(subNet / subDenominator, 6) : 0,
      netLost: subNet,
      denominator: subDenominator,
      timeSeries: subscriptionTimeSeries,
    },
    grossRevenue: { currencies: revenueCurrencies },
  };
}
