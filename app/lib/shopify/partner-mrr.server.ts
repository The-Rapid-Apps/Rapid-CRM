import type {
  PartnerSubscriptionEvent,
  PartnerSubscriptionSaleFact,
  Prisma,
} from "../../../generated/prisma/client";
import { cachedWithRedis, invalidateRedisCachePrefix } from "../cache/redis-cache.server";
import { prisma } from "../db.server";
import { resolveCustomerNames } from "../customer-name.server";
import { logger } from "../logger.server";
import {
  buildUtcBuckets,
  type ChurnReport,
  type PortfolioReport,
  type RecurringCurrencySummary,
  type RecurringPoint,
  RANGE_QUANTUM_MS,
  type ResolvedAnalyticsRange,
  type RevenueReport,
  type MrrMovementSummary,
  type MrrMovementBucket,
  type PlanMrrSeries,
  EMPTY_MRR_MOVEMENT_BUCKET,
  mrrMovementNet,
} from "../reports/analytics.server";

export type EventFact = Pick<
  PartnerSubscriptionEvent,
  | "appId"
  | "type"
  | "occurredAt"
  | "shopDomain"
  | "chargePlatformId"
  | "chargeName"
  | "amount"
  | "currencyCode"
  | "billingOn"
  | "test"
>;

export type SaleFact = Pick<
  PartnerSubscriptionSaleFact,
  | "appId"
  | "chargePlatformId"
  | "occurredAt"
  | "billingInterval"
  | "grossAmount"
  | "currencyCode"
>;

export interface PartnerMrrCoverage {
  provider: "shopify_partner_lifecycle";
  applied: boolean;
  complete: boolean;
  eventsComplete: boolean;
  salesComplete: boolean;
  appsReady: number;
  appsTotal: number;
  notes: string[];
}

export interface ChargeHistory {
  appId: string;
  chargePlatformId: string;
  events: EventFact[];
  /**
   * `events` filtered to ACTIVATED/CANCELED/EXPIRED/DECLINED only, order
   * preserved — the events that decide whether this charge is
   * fundamentally alive. See `isChargeActive`'s doc comment for why
   * FROZEN/UNFROZEN are deliberately excluded here.
   */
  lifecycleEvents: EventFact[];
  /** `events` filtered to FROZEN/UNFROZEN only, order preserved. */
  freezeEvents: EventFact[];
  sales: SaleFact[];
  inferredInterval: "EVERY_30_DAYS" | "ANNUAL" | null;
  inferredEffectiveAmount: number | null;
  activatedAt: Date | null;
  /** Timestamp of the final event, so "is this charge still in play?" is O(1). */
  lastEventAt: Date | null;
  /**
   * True when the final event leaves the charge contributing nothing forever
   * (deactivating, test, or non-activating type) — `contributionAt` returns
   * null from `lastEventAt` onward. See `liveHistoriesSince`.
   */
  terminal: boolean;
  /**
   * True when this (appId, shopDomain) has been billed at least once before
   * — on ANY charge for this app, not just this one. Distinguishes a plan
   * change on an existing payer (a new charge with no sale yet, but a real
   * payment history elsewhere) from a genuinely brand-new subscriber who has
   * never paid a cent. See `contributionAt`'s trial inference — only the
   * latter is a trial candidate, no matter how far out `billingOn` is.
   */
  shopHasPriorSale: boolean;
  /**
   * A confirmed-live discount amount from `PartnerChargeLiveDiscountCheck`
   * (background job, `syncLiveDiscountChecksForApp`), monthly-normalized and
   * ready to use as-is. Resolves an ambiguous discount or a charge with no
   * sale yet, including one that would otherwise hit an unpaid fallback.
   * `null` when the job has no recent, conclusive price for this charge.
   */
  liveDiscountEffectiveAmount: number | null;
  /**
   * Set when `syncLiveDiscountChecksForApp`'s live Shopify check found NO
   * active subscription at all for this charge — the timestamp is when we
   * confirmed it, not when it actually happened. `isChargeActive` only
   * treats the charge as dead for `at >= liveSubscriptionInactiveSince`,
   * deliberately never retroactive: a live check only proves the
   * subscription is gone as of the moment we checked it, not when it
   * actually ended, so applying it to a historical `at` before that would
   * silently zero out genuinely real past revenue in daily charts. `null`
   * when never checked, or last checked and still active.
   */
  liveSubscriptionInactiveSince: Date | null;
  /**
   * Shopify's own trial end for this charge, from the live check. Ground truth,
   * as against the activation-to-`billingOn` window `contributionAt` infers.
   */
  liveTrialEndsAt: Date | null;
  /**
   * Whether `liveTrialEndsAt` is an ANSWER rather than an absence.
   *
   * The column is null both for "this subscription has no trial" and for "the job
   * has not reached this charge", so null alone proves nothing and must never be
   * read as "no trial". True means a check ran with a build that selects the
   * field, so null genuinely means no trial — which is the only way the
   * heuristic's false positives can be corrected downwards.
   */
  liveTrialEndKnown: boolean;
}

export interface ChargeContribution {
  currency: string;
  amount: number;
  kind: "monthly" | "annual" | "trial";
  shopDomain: string;
  /**
   * The plan name Shopify reported on the event in force at this instant, so a
   * charge that changed plan mid-range attributes to the right plan per bucket.
   *
   * Carried here rather than re-resolved by the caller: `contributionAt` already
   * has the event, and asking `isChargeActive` a second time per charge per
   * bucket would add a full extra pass to the most expensive loop in the
   * reports (dozens of buckets x tens of thousands of charges).
   */
  planName: string;
  /**
   * The plan's LIST price as the in-force event stated it, before any discount
   * — NOT `amount`, which is what the merchant actually pays. Monthly-normalized
   * the same way `amount` is, so an annual plan reports a twelfth.
   *
   * Needed because `planName` alone is not a plan identity: a plan is keyed by
   * (name, price, interval), and one charge name can cover several plans at
   * different prices. Discounts must not enter the key or every discounted
   * merchant would split off into a phantom plan of their own.
   *
   * Carried here rather than re-derived by the caller for the reason `planName`
   * is: `contributionAt` already holds the event, and asking `isChargeActive`
   * again per charge per bucket is a full extra pass over the most expensive
   * loop in the reports.
   */
  planListedAmount: number;
  /**
   * The charge's billing cadence at this instant.
   *
   * Carried for the same reason as `planName` and `planListedAmount`: it
   * completes Mantle's plan identity (name, list price, cadence), and
   * `contributionAt` has already computed it — re-deriving it per charge in a
   * caller would add a pass over the most expensive loop in the reports.
   *
   * Distinct from `kind`, which collapses to `"trial"` while a trial is
   * running and so cannot say whether that trial is on a monthly or annual
   * plan. A plan whose only members are trialists still needs a row.
   */
  interval: "EVERY_30_DAYS" | "ANNUAL";
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  firstSaleAt: Date | null;
}

interface InferredTrialLifecycle {
  startedAt: Date;
  expiresAt: Date;
  convertedAt: Date | null;
  canceledAt: Date | null;
  /**
   * The trial's monthly-normalized plan price, carried so the trials REPORT
   * can value a converted or lost trial — an active one is already valued by
   * `contributionAt`'s `trial` kind, but a trial that ended has no
   * contribution left to read.
   *
   * ADDITIVE ONLY. Nothing in the MRR fold reads this; it exists so the
   * Overview's trials table can show money instead of bare counts.
   */
  monthlyAmount: number;
}

const log = logger.scope("partner-mrr");

const DAY_MS = 86_400_000;
// `billingOn` is Shopify's next billing date, not an explicit trial end.
//
// This used to be a tight 8-day cap on the assumption every plan trials for
// 7 days — wrong in production: real trial lengths vary by plan (14, 30+
// days aren't unusual), and anyone past the cap got counted as full paying
// MRR despite never having been billed. The cap isn't what protects against
// misclassifying an ordinary payer as a trial anymore — `shopHasPriorSale`
// does (a plan change on an existing payer has no sale on its NEW charge
// either, but the shop has paid before, so it's excluded from trial
// inference regardless of this window). This is now just a sanity bound
// against a corrupt/absurd `billingOn` value turning into a trial that
// silently suppresses revenue forever.
const MAX_INFERRED_TRIAL_WINDOW_MS = 90 * DAY_MS;

/**
 * How long a charge gets the benefit of the doubt after its due date passes
 * with still no sale, before its amount stops being trusted. Confirmed
 * 2026-08-26 against live Shopify Partner data: one app grants some
 * shops a manual permanent discount (observed down to $0/yr) that produces
 * no event of its own — a $0 charge never creates a sale either, so those
 * shops looked identical to "first invoice just hasn't landed yet" and were
 * still being counted at full price hundreds of days later. But a much
 * larger, distinctly-shaped population of recently-overdue charges (most
 * within days to low weeks) turned out to be ordinary billing-cycle/webhook
 * lag, not discounts — zeroing those overcorrected Monthly MRR well past
 * the real number. One full billing cycle is the dividing line a real
 * payment attempt (success or decline) should resolve within; past that,
 * an unpaid charge isn't a timing artifact anymore.
 */
const NEVER_BILLED_GRACE_MS = 30 * DAY_MS;

/**
 * Same idea as `NEVER_BILLED_GRACE_MS`, but for a shop that has paid before
 * on an earlier charge (`shopHasPriorSale`) and is now silent on a newer
 * one. That used to be an unconditional, permanent exemption — plausible
 * when it was added, since a plan-change's first invoice can genuinely take
 * weeks — but confirmed 2026-08-31 against live Shopify data as a real gap:
 * shops that later receive a manual permanent 100% discount on their new
 * charge stayed counted at full price indefinitely, because nothing ever
 * re-checked them. Three times the ordinary grace period, not the same one,
 * because a plan-change's first invoice really does land later on average
 * than a fresh trial's — see the days-to-first-sale distribution gathered
 * the same day (most genuine delays resolve well under 90 days; the shops
 * still silent past that are the ones actually worth zeroing).
 */
const PLAN_CHANGE_NEVER_BILLED_GRACE_MS = 90 * DAY_MS;

/**
 * How far out `billingOn` has to sit for an as-yet-unbilled charge to be read
 * as annual rather than monthly. An active trial has no sale to infer cadence
 * from, so the distance to Shopify's next billing date is the only evidence
 * there is, and this is where the two cadences separate.
 */
const TRIAL_HORIZON_MS = 180 * DAY_MS;

/**
 * Windows of `billingOn` for charges whose contribution can change between
 * `from` and `to` WITHOUT any event or sale arriving — purely because the clock
 * moved past a threshold.
 *
 * Exists for the snapshot read path's "today" top-up, which finds the charges
 * it needs to re-evaluate by looking for activity since midnight. That misses
 * every clock-driven transition, and those are not rare: trial conversions
 * alone move plan MRR every morning, and they are invisible to an activity scan because a trial ending is the absence
 * of an event, not the presence of one.
 *
 * Lives here, beside the thresholds themselves, so a change to any of them
 * cannot silently stop being topped up — the alternative was re-declaring
 * `NEVER_BILLED_GRACE_MS` and friends in the snapshot module, where they would
 * quietly drift out of step.
 *
 * Each window is the set of `billingOn` values that sit on the far side of a
 * threshold at `to` but not at `from`:
 *
 *   1. `billingOn <= at` ends a trial, moving a charge from `trialSubscriptions`
 *      into real plan MRR.
 *   2/3. `billingOn < at - grace` with no sale ever makes a charge past due, so
 *      it stops contributing. Two windows, because the grace period depends on
 *      whether the shop has paid before on another charge.
 *   4. `billingOn - at > 180 days` is the cadence heuristic's annual boundary,
 *      so crossing it changes a charge's inferred interval and therefore the
 *      monthly value of its contribution.
 */
export function clockTransitionBillingOnWindows(
  from: Date,
  to: Date,
): Array<{ gte: Date; lt: Date }> {
  const offsets = [
    0,
    -NEVER_BILLED_GRACE_MS,
    -PLAN_CHANGE_NEVER_BILLED_GRACE_MS,
    TRIAL_HORIZON_MS,
  ];
  return offsets.map((offset) => ({
    gte: new Date(from.getTime() + offset),
    lt: new Date(to.getTime() + offset),
  }));
}

export function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function chargeKey(appId: string, chargePlatformId: string): string {
  return `${appId}\u001f${chargePlatformId}`;
}

export function eventActivates(type: string): boolean {
  return (
    type === "SUBSCRIPTION_CHARGE_ACTIVATED" ||
    type === "SUBSCRIPTION_CHARGE_UNFROZEN"
  );
}

function isLifecycleEvent(type: string): boolean {
  return (
    type === "SUBSCRIPTION_CHARGE_ACTIVATED" ||
    type === "SUBSCRIPTION_CHARGE_CANCELED" ||
    type === "SUBSCRIPTION_CHARGE_DECLINED" ||
    type === "SUBSCRIPTION_CHARGE_EXPIRED"
  );
}

export function lastAt<T extends { occurredAt: Date }>(
  values: T[],
  at: Date,
): T | undefined {
  let low = 0;
  let high = values.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle].occurredAt <= at) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match >= 0 ? values[match] : undefined;
}

/**
 * Same binary search as `lastAt`, but returns the index — so a caller can
 * also look at the element immediately before it (see `contributionAt`'s
 * sale-corroboration check).
 */
function lastIndexAt<T extends { occurredAt: Date }>(
  values: T[],
  at: Date,
): number {
  let low = 0;
  let high = values.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle].occurredAt <= at) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

/** Passed to `isChargeActive` when the caller wants "as of the end of known history," not a specific instant. */
const FAR_FUTURE_DATE = new Date(8640000000000000);

/**
 * Whether this charge is genuinely active as of `at`, and if so, the event
 * whose `amount`/`chargeName`/`billingOn`/`currencyCode`/`shopDomain` should
 * be used. Replaces a bug found 2026-09-01: naively taking "whichever event
 * is chronologically last" and checking only that one event's type let a
 * stray SUBSCRIPTION_CHARGE_FROZEN → SUBSCRIPTION_CHARGE_UNFROZEN pair
 * arriving *after* a real SUBSCRIPTION_CHARGE_CANCELED (confirmed live —
 * almost certainly a late payment-retry/freeze cycle finishing up after the
 * merchant already cancelled) make an already-dead charge look active again,
 * counting its full listed price as real MRR. This explained the majority
 * of "ghost" charges found across two apps (Shopify shows no subscription
 * at all, but we still counted them).
 *
 * Splits what used to be one conflated check into two: only a genuine
 * ACTIVATED/CANCELED/EXPIRED/DECLINED event decides whether the charge is
 * fundamentally alive (`history.lifecycleEvents` — FROZEN/UNFROZEN excluded
 * entirely, so a stray one can never look like a reactivation); only once
 * that's established does the most recent FROZEN/UNFROZEN *after* that
 * activation decide whether it's currently paused. This is the single
 * definition — `contributionAt`, `listNeverBilledPastDueCharges`,
 * `listAmbiguousDiscountCharges`, and `historiesFromFacts`'s `terminal`
 * field all call this instead of each re-deriving their own answer.
 */
function isChargeActive(history: ChargeHistory, at: Date): EventFact | null {
  const lifecycleEvent = lastAt(history.lifecycleEvents, at);
  if (
    !lifecycleEvent ||
    lifecycleEvent.test ||
    lifecycleEvent.type !== "SUBSCRIPTION_CHARGE_ACTIVATED"
  ) {
    return null;
  }
  // Confirmed-dead via a live Shopify check (see the field's own doc
  // comment) — never retroactive, only from the moment we verified it.
  if (
    history.liveSubscriptionInactiveSince &&
    at >= history.liveSubscriptionInactiveSince
  ) {
    return null;
  }
  const freezeEvent = lastAt(history.freezeEvents, at);
  const currentlyFrozen = Boolean(
    freezeEvent &&
      freezeEvent.type === "SUBSCRIPTION_CHARGE_FROZEN" &&
      freezeEvent.occurredAt > lifecycleEvent.occurredAt,
  );
  return currentlyFrozen ? null : lifecycleEvent;
}

const ANNUAL_NAME_PATTERN = /\b(annual|year|yearly)\b/i;
/** Memoized: the regex test ran millions of times per report over a tiny, fixed set of plan names. */
const annualNameCache = new Map<string, boolean>();

function nameSuggestsAnnual(chargeName: string): boolean {
  let known = annualNameCache.get(chargeName);
  if (known === undefined) {
    known = ANNUAL_NAME_PATTERN.test(chargeName);
    annualNameCache.set(chargeName, known);
  }
  return known;
}

function intervalForCharge(
  history: ChargeHistory,
  at: Date,
  currentEvent: EventFact,
): "EVERY_30_DAYS" | "ANNUAL" {
  const known = lastAt(history.sales, at)?.billingInterval;
  if (known === "ANNUAL" || known === "EVERY_30_DAYS") return known;
  if (history.inferredInterval) return history.inferredInterval;

  if (nameSuggestsAnnual(currentEvent.chargeName)) {
    return "ANNUAL";
  }

  // No sale yet, so the distance to Shopify's next billing date is the only
  // cadence evidence available — see `TRIAL_HORIZON_MS`.
  if (
    currentEvent.billingOn &&
    currentEvent.billingOn.getTime() - at.getTime() > TRIAL_HORIZON_MS
  ) {
    return "ANNUAL";
  }
  return "EVERY_30_DAYS";
}

// Shared by `contributionAt` (zeroes the contribution) and
// `listNeverBilledPastDueCharges` (surfaces exactly which charges that
// applies to) so the diagnostic view can never drift from what actually
// gets zeroed — one condition, two readers.
function isNeverBilledPastDue(
  history: ChargeHistory,
  at: Date,
  currentEvent: EventFact,
  latestSale: SaleFact | undefined,
): boolean {
  const graceMs = history.shopHasPriorSale
    ? PLAN_CHANGE_NEVER_BILLED_GRACE_MS
    : NEVER_BILLED_GRACE_MS;
  return Boolean(
    !latestSale &&
      currentEvent.billingOn &&
      currentEvent.billingOn.getTime() < at.getTime() - graceMs,
  );
}

const SALE_CORROBORATION_TOLERANCE = 0.02; // 2%, floored at $0.50

/**
 * A sale below the listed price is ambiguous on its own — it might be a
 * genuine discount, or a one-off prorated settle-up from a mid-cycle plan
 * change (see `contributionAt`'s own doc comment for the full story).
 * Returns the two numbers a caller needs to try to resolve that ambiguity
 * (e.g. `syncLiveDiscountChecksForApp`'s candidate list) when the sale isn't
 * already trustworthy on its own, or `null` when there's nothing ambiguous
 * to resolve (no sale, or the sale is already trusted). Shared by
 * `contributionAt` and `listAmbiguousDiscountCharges` so "what counts as
 * ambiguous" has exactly one definition — same reasoning as
 * `isNeverBilledPastDue` being shared with `listNeverBilledPastDueCharges`.
 */
function ambiguousDiscount(
  currentEvent: EventFact,
  latestSale: SaleFact | undefined,
  priorSale: SaleFact | undefined,
): { listedAmount: number; saleAmount: number } | null {
  const listedAmount = Number(currentEvent.amount);
  const saleAmount = latestSale ? Number(latestSale.grossAmount) : null;
  if (saleAmount === null) return null;
  const corroborated =
    priorSale &&
    Math.abs(saleAmount - Number(priorSale.grossAmount)) <=
      Math.max(0.5, saleAmount * SALE_CORROBORATION_TOLERANCE);
  const trusted = saleAmount >= listedAmount || corroborated;
  return trusted ? null : { listedAmount, saleAmount };
}

export function contributionAt(
  history: ChargeHistory,
  at: Date,
): ChargeContribution | null {
  const currentEvent = isChargeActive(history, at);
  if (!currentEvent) return null;

  const activatedAt = history.activatedAt ?? currentEvent.occurredAt;
  const interval = intervalForCharge(history, at, currentEvent);
  const cadenceDays = interval === "ANNUAL" ? 365 : 30;
  const firstSaleAt =
    history.sales[0]?.occurredAt && history.sales[0].occurredAt <= at
      ? history.sales[0].occurredAt
      : null;
  const saleIndex = lastIndexAt(history.sales, at);
  const latestSale = saleIndex >= 0 ? history.sales[saleIndex] : undefined;
  const priorSale = saleIndex >= 1 ? history.sales[saleIndex - 1] : undefined;
  // Before this shop's first-ever sale for this app (on ANY of its charges,
  // not just this one), billingOn is a real trial end date; once they've
  // paid at least once, a later charge's billingOn is just its next renewal
  // (or a plan-change's first invoice) and must not be read as a trial.
  const inferredTrialEnd =
    !history.shopHasPriorSale &&
    currentEvent.billingOn &&
    currentEvent.billingOn > at &&
    currentEvent.billingOn.getTime() - activatedAt.getTime() >
      12 * 60 * 60_000 &&
    currentEvent.billingOn.getTime() - activatedAt.getTime() <
      Math.min(cadenceDays * DAY_MS, MAX_INFERRED_TRIAL_WINDOW_MS)
      ? new Date(currentEvent.billingOn)
      : null;
  /*
    Shopify's own trial end wins wherever the job has recorded one; the inference
    chain above is the fallback for a charge it has not reached, and it is
    right about most of the band, not all of it.
  */
  const trialEndsAt = history.liveTrialEndKnown
    ? history.liveTrialEndsAt
    : inferredTrialEnd &&
        inferredTrialEnd.getTime() - activatedAt.getTime() > 12 * 60 * 60_000
      ? inferredTrialEnd
      : null;
  const activeTrial = Boolean(trialEndsAt && at < trialEndsAt);
  // Shopify lets a subscription's price be reduced after approval (a
  // partner/promotional discount, sometimes down to $0) with no event of
  // its own in this feed — and a $0 charge never produces a sale, so there
  // is nothing to read the real price from. Past one full billing cycle
  // overdue with still no sale ever, the approval-time amount is no longer
  // a safe guess — see `NEVER_BILLED_GRACE_MS`/`PLAN_CHANGE_NEVER_BILLED_GRACE_MS`.
  // Without a current live price, zero is the only supported amount. A
  // shop with prior payment history gets a longer grace period (a
  // plan-change's first invoice can genuinely take weeks) but not an
  // unlimited one — see `isNeverBilledPastDue`.
  const neverBilledPastDue = isNeverBilledPastDue(history, at, currentEvent, latestSale);
  /*
    An ended trial with no sale cannot establish a recurring price from payment
    history. Keep the conservative fallback when no live price is available.
    A recent Shopify check CAN establish that price: MRR measures the active
    contract, so a delayed first sale must not override a verified live amount.
    `billingOn` alone misses this case when Shopify rolls it into the next cycle.
    Plan changes keep their separate, longer never-billed grace period.
  */
  const trialEndedUnpaid =
    history.liveTrialEndKnown &&
    history.liveTrialEndsAt !== null &&
    history.liveTrialEndsAt <= at &&
    !history.shopHasPriorSale &&
    latestSale === undefined;
  // The event exposes the approved list amount; the sale fact is the
  // effective merchant-paid amount, capturing price reductions the event
  // doesn't expose. But a sale *below* the listed price is ambiguous on its
  // own — it might be a genuine discount, or it might be a one-off prorated
  // settle-up from a mid-cycle plan change (confirmed 2026-08-31 against
  // live data: often a fraction of the real recurring rate, and can be the
  // charge's only sale for weeks). Trust it immediately once it's at or
  // above the listed price (never ambiguous), or once a second, immediately
  // preceding sale on this same charge agrees with it (a confirmed,
  // repeating rate — not a one-off). Otherwise prefer a confirmed live
  // Shopify discount check if the background job has resolved this charge
  // already (see `liveDiscountEffectiveAmount`'s doc comment) — resolves the
  // ambiguity with ground truth instead of waiting for a real billing cycle.
  // Falls back through the existing chain when neither is available, same as
  // an uncorroborated charge always has.
  const ambiguous = ambiguousDiscount(currentEvent, latestSale, priorSale);
  const saleAmount = latestSale ? Number(latestSale.grossAmount) : null;
  const trustLatestSale = saleAmount !== null && ambiguous === null;
  const divisor = interval === "ANNUAL" ? 12 : 1;
  const liveMonthlyAmount = history.liveDiscountEffectiveAmount;
  // The live-check writer already normalizes annual prices. Event amounts,
  // sale amounts and offer inferences are per billing cycle, so normalize only
  // those sources. Applying the divisor after selecting a source divided live
  // annual amounts twice.
  const amount = (neverBilledPastDue || trialEndedUnpaid) && liveMonthlyAmount === null
    ? 0
    : trustLatestSale
      ? saleAmount / divisor
      : liveMonthlyAmount ??
        Number(history.inferredEffectiveAmount ?? currentEvent.amount) / divisor;
  if (!Number.isFinite(amount)) return null;

  return {
    currency: latestSale?.currencyCode ?? currentEvent.currencyCode,
    amount,
    kind: activeTrial ? "trial" : interval === "ANNUAL" ? "annual" : "monthly",
    shopDomain: currentEvent.shopDomain,
    planName: currentEvent.chargeName,
    planListedAmount:
      interval === "ANNUAL"
        ? Number(currentEvent.amount) / 12
        : Number(currentEvent.amount),
    interval,
    trialStartedAt: activeTrial ? activatedAt : null,
    trialEndsAt,
    firstSaleAt,
  };
}

export interface OfferCadencePin {
  interval: "EVERY_30_DAYS" | "ANNUAL" | null;
  effectiveAmount: number | null;
}

/**
 * MUST exactly match the grouping key `historiesFromFacts` uses (appId +
 * normalized chargeName + amount-to-6-decimals) — shared with
 * `PartnerOfferCadenceInference`'s primary key, or a pin silently never matches.
 */
function offerKeyFor(appId: string, normalizedChargeName: string, amount: number): string {
  return [appId, normalizedChargeName, amount.toFixed(6)].join("");
}

function latestByCharge<T extends { appId: string; chargePlatformId: string; occurredAt: Date }>(
  items: T[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = chargeKey(item.appId, item.chargePlatformId);
    const existing = result.get(key);
    if (!existing || item.occurredAt.getTime() > existing.occurredAt.getTime()) {
      result.set(key, item);
    }
  }
  return result;
}

/**
 * Cheap O(events + sales) pass identifying which offers need a cadence pin:
 * any charge whose sales never carry an explicit `billingInterval`. Mirrors
 * the same condition `historiesFromFacts`'s fallback loop gates on, kept in
 * sync deliberately so "needs inference" has one definition in this file.
 */
function offersNeedingInference(
  events: EventFact[],
  sales: SaleFact[],
): Map<string, { appId: string; chargeName: string; amount: number }> {
  const lastEventByCharge = latestByCharge(events);
  const explicitIntervalCharges = new Set<string>();
  for (const sale of sales) {
    if (sale.chargePlatformId && sale.billingInterval) {
      explicitIntervalCharges.add(chargeKey(sale.appId, sale.chargePlatformId));
    }
  }
  const offers = new Map<string, { appId: string; chargeName: string; amount: number }>();
  for (const [key, event] of lastEventByCharge) {
    if (explicitIntervalCharges.has(key)) continue;
    const chargeName = event.chargeName.trim().toLowerCase();
    const amount = Number(event.amount);
    const offerKey = offerKeyFor(event.appId, chargeName, amount);
    if (!offers.has(offerKey)) offers.set(offerKey, { appId: event.appId, chargeName, amount });
  }
  return offers;
}

/**
 * Same majority-vote/median computation this codebase always ran live, just
 * scoped to only the offers `neededKeys` asks for and run once per offer
 * instead of once per request.
 */
function computeOfferEvidence(
  events: EventFact[],
  sales: SaleFact[],
  neededKeys: Set<string>,
): Map<string, OfferCadencePin & { appId: string; chargeName: string; amount: number }> {
  const salesByCharge = new Map<string, SaleFact[]>();
  for (const sale of sales) {
    if (!sale.chargePlatformId) continue;
    const key = chargeKey(sale.appId, sale.chargePlatformId);
    const list = salesByCharge.get(key);
    if (list) list.push(sale);
    else salesByCharge.set(key, [sale]);
  }
  const lastEventByCharge = latestByCharge(events);

  const offerIntervals = new Map<string, { monthly: number; annual: number }>();
  const offerAmounts = new Map<string, number[]>();
  const offerMeta = new Map<string, { appId: string; chargeName: string; amount: number }>();

  for (const [chargeKeyStr, event] of lastEventByCharge) {
    const chargeSales = salesByCharge.get(chargeKeyStr) ?? [];
    let interval: "ANNUAL" | "EVERY_30_DAYS" | undefined;
    for (let cursor = chargeSales.length - 1; cursor >= 0; cursor -= 1) {
      const billingInterval = chargeSales[cursor].billingInterval;
      if (billingInterval === "ANNUAL" || billingInterval === "EVERY_30_DAYS") {
        interval = billingInterval;
        break;
      }
    }
    if (!interval) continue;
    const chargeName = event.chargeName.trim().toLowerCase();
    const amount = Number(event.amount);
    const key = offerKeyFor(event.appId, chargeName, amount);
    if (!neededKeys.has(key)) continue;
    offerMeta.set(key, { appId: event.appId, chargeName, amount });
    const current = offerIntervals.get(key) ?? { monthly: 0, annual: 0 };
    if (interval === "ANNUAL") current.annual++;
    else current.monthly++;
    offerIntervals.set(key, current);
    let amounts = offerAmounts.get(key);
    if (!amounts) {
      amounts = [];
      offerAmounts.set(key, amounts);
    }
    for (const sale of chargeSales) {
      const saleAmount = Number(sale.grossAmount);
      if (Number.isFinite(saleAmount)) amounts.push(saleAmount);
    }
  }

  const result = new Map<string, OfferCadencePin & { appId: string; chargeName: string; amount: number }>();
  for (const key of neededKeys) {
    const meta = offerMeta.get(key);
    // No evidence in this batch yet — leave unresolved (don't pin "null
    // forever") so a future request can still discover the real answer.
    if (!meta) continue;
    const votes = offerIntervals.get(key);
    const amounts = offerAmounts.get(key);
    let effectiveAmount: number | null = null;
    if (amounts && amounts.length > 0) {
      amounts.sort((left, right) => left - right);
      effectiveAmount = amounts[Math.floor(amounts.length / 2)];
    }
    result.set(key, {
      ...meta,
      interval: votes ? (votes.annual > votes.monthly ? "ANNUAL" : "EVERY_30_DAYS") : null,
      effectiveAmount,
    });
  }
  return result;
}

/**
 * Resolves the pinned cadence/amount inference for every offer this batch
 * needs — reading already-pinned offers from `PartnerOfferCadenceInference`,
 * and for any new offer, computing it once and persisting it so no future
 * call recomputes it. See that model's schema.prisma doc for why this table
 * is deliberately NOT rebuildable-to-the-same-value like this codebase's
 * other derived tables.
 *
 * Call this BEFORE `historiesFromFacts`, passing the result as `offerPins`.
 * Best-effort write: a persist failure never fails the caller's report — the
 * computed value is still used for this request and simply recomputed next time.
 */
export async function resolveOfferCadencePins(
  events: EventFact[],
  sales: SaleFact[],
): Promise<Map<string, OfferCadencePin>> {
  const needed = offersNeedingInference(events, sales);
  if (needed.size === 0) return new Map();

  const appIds = [...new Set([...needed.values()].map((offer) => offer.appId))];
  const existingRows = await prisma.partnerOfferCadenceInference.findMany({
    where: { appId: { in: appIds } },
  });
  const resolved = new Map<string, OfferCadencePin>();
  const existingKeys = new Set<string>();
  for (const row of existingRows) {
    const key = offerKeyFor(row.appId, row.chargeName, Number(row.amount));
    existingKeys.add(key);
    resolved.set(key, {
      interval: row.interval as "EVERY_30_DAYS" | "ANNUAL" | null,
      effectiveAmount: row.effectiveAmount !== null ? Number(row.effectiveAmount) : null,
    });
  }

  const missingKeys = new Set(
    [...needed.keys()].filter((key) => !existingKeys.has(key)),
  );
  if (missingKeys.size === 0) return resolved;

  const computed = computeOfferEvidence(events, sales, missingKeys);
  if (computed.size > 0) {
    try {
      await prisma.partnerOfferCadenceInference.createMany({
        data: [...computed.values()].map((pin) => ({
          appId: pin.appId,
          chargeName: pin.chargeName,
          amount: pin.amount,
          interval: pin.interval,
          effectiveAmount: pin.effectiveAmount,
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      log.warn("offer cadence pin write failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    for (const [key, pin] of computed) {
      resolved.set(key, { interval: pin.interval, effectiveAmount: pin.effectiveAmount });
    }
  }
  return resolved;
}

export function historiesFromFacts(
  events: EventFact[],
  sales: SaleFact[],
  /**
   * Pre-resolved cadence/amount pins from `resolveOfferCadencePins` — pass
   * whenever possible (every real report does). Omitted only falls back to
   * the original live majority-vote/median computation, kept for
   * pure-fixture tests with no database to resolve pins against.
   */
  offerPins?: Map<string, OfferCadencePin>,
  /**
   * Pre-resolved live checks from `PartnerChargeLiveDiscountCheck`
   * (populated by the `syncLiveDiscountChecksForApp` background job), keyed
   * by `chargeKey(appId, chargePlatformId)`. Optional — omitted just means
   * `contributionAt` falls back to its existing chain for any ambiguous
   * charge, and no charge is ever treated as live-confirmed-dead, same as
   * before this existed.
   */
  liveDiscountChecks?: Map<string, ResolvedLiveCheckValue>,
): ChargeHistory[] {
  const histories = new Map<string, ChargeHistory>();
  for (const event of events) {
    const key = chargeKey(event.appId, event.chargePlatformId);
    const history = histories.get(key) ?? {
      appId: event.appId,
      chargePlatformId: event.chargePlatformId,
      events: [],
      lifecycleEvents: [],
      freezeEvents: [],
      sales: [],
      inferredInterval: null,
      inferredEffectiveAmount: null,
      activatedAt: null,
      lastEventAt: null,
      terminal: false,
      shopHasPriorSale: false,
      liveDiscountEffectiveAmount: null,
      liveSubscriptionInactiveSince: null,
      liveTrialEndsAt: null,
      liveTrialEndKnown: false,
    };
    history.events.push(event);
    histories.set(key, history);
  }
  for (const sale of sales) {
    if (!sale.chargePlatformId) continue;
    const history = histories.get(chargeKey(sale.appId, sale.chargePlatformId));
    if (history) history.sales.push(sale);
  }
  for (const history of histories.values()) {
    history.events.sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
    // Filtering an already-sorted array preserves order — no separate sort
    // needed. See `isChargeActive`'s doc comment for why these are split.
    history.lifecycleEvents = history.events.filter((event) =>
      isLifecycleEvent(event.type),
    );
    history.freezeEvents = history.events.filter(
      (event) =>
        event.type === "SUBSCRIPTION_CHARGE_FROZEN" ||
        event.type === "SUBSCRIPTION_CHARGE_UNFROZEN",
    );
    // Secondary sort by grossAmount, ascending, for sales sharing the exact
    // same instant (Shopify sometimes emits a base charge and a proration
    // adjustment at the identical timestamp) — so `lastAt`'s "last matching
    // element" always resolves a tie to the larger of the two, not whichever
    // happened to load last. Confirmed 2026-08-31 against live data: the
    // smaller of a same-instant pair is consistently the adjustment line,
    // never the real recurring rate.
    history.sales.sort((left, right) => {
      const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      return Number(left.grossAmount ?? 0) - Number(right.grossAmount ?? 0);
    });
    history.activatedAt =
      history.events.find(
        (event) => event.type === "SUBSCRIPTION_CHARGE_ACTIVATED",
      )?.occurredAt ?? null;
    const finalEvent = history.events.at(-1);
    history.lastEventAt = finalEvent?.occurredAt ?? null;
    // Must happen before `terminal` is computed below, since `isChargeActive`
    // consults `liveSubscriptionInactiveSince` too.
    if (liveDiscountChecks) {
      const key = chargeKey(history.appId, history.chargePlatformId);
      const check = liveDiscountChecks.get(key);
      history.liveDiscountEffectiveAmount = check?.effectiveAmount ?? null;
      history.liveSubscriptionInactiveSince = check?.inactiveSince ?? null;
      history.liveTrialEndsAt = check?.trialEndsAt ?? null;
      history.liveTrialEndKnown = check?.trialEndKnown ?? false;
    }
    // Reuses `isChargeActive` (the same check `contributionAt` uses) so a
    // terminal charge provably contributes nothing from `lastEventAt`
    // onward — asked "as of the end of known history" via FAR_FUTURE_DATE,
    // since this field isn't tied to any specific `at`.
    history.terminal = isChargeActive(history, FAR_FUTURE_DATE) === null;
  }

  // A shop's payment history spans every charge it's ever had for this app,
  // not just the current one — a plan change opens a brand-new charge with
  // no sale of its own, but the shop plainly isn't a new trial. One pass to
  // find which (appId, shopDomain) pairs have a sale anywhere, then stamp
  // every one of that shop's charges with it.
  const shopsWithSale = new Set<string>();
  for (const history of histories.values()) {
    if (history.sales.length === 0) continue;
    const shopDomain = history.events[0]?.shopDomain;
    if (shopDomain) shopsWithSale.add(chargeKey(history.appId, shopDomain));
  }
  for (const history of histories.values()) {
    const shopDomain = history.events[0]?.shopDomain;
    history.shopHasPriorSale = Boolean(
      shopDomain && shopsWithSale.has(chargeKey(history.appId, shopDomain)),
    );
  }

if (offerPins) {
    // Fast path: every offer's cadence/amount was already resolved (and
    // persisted, for new offers) by `resolveOfferCadencePins` — just look
    // each one up, no per-request majority-vote/median computation.
    for (const history of histories.values()) {
      if (history.sales.some((sale) => sale.billingInterval)) continue;
      const event = history.events.at(-1);
      if (!event) continue;
      const key = offerKeyFor(
        history.appId,
        event.chargeName.trim().toLowerCase(),
        Number(event.amount),
      );
      const pin = offerPins.get(key);
      if (!pin) continue;
      history.inferredInterval = pin.interval;
      history.inferredEffectiveAmount = pin.effectiveAmount;
    }
    return [...histories.values()];
  }

  // No pins supplied (pure-fixture tests only) — fall back to the original
  // live majority-vote/median computation.
  const offerIntervals = new Map<string, { monthly: number; annual: number }>();
  const offerAmounts = new Map<string, number[]>();
  for (const history of histories.values()) {
    const event = history.events.at(-1);
    // Last sale carrying a known cadence, without allocating a reversed copy.
    let interval: "ANNUAL" | "EVERY_30_DAYS" | undefined;
    for (let cursor = history.sales.length - 1; cursor >= 0; cursor -= 1) {
      const billingInterval = history.sales[cursor].billingInterval;
      if (billingInterval === "ANNUAL" || billingInterval === "EVERY_30_DAYS") {
        interval = billingInterval;
        break;
      }
    }
    if (!event || !interval) continue;
    const key = offerKeyFor(
      history.appId,
      event.chargeName.trim().toLowerCase(),
      Number(event.amount),
    );
    const current = offerIntervals.get(key) ?? { monthly: 0, annual: 0 };
    if (interval === "ANNUAL") current.annual++;
    else current.monthly++;
    offerIntervals.set(key, current);
    let amounts = offerAmounts.get(key);
    if (!amounts) {
      amounts = [];
      offerAmounts.set(key, amounts);
    }
    for (const sale of history.sales) {
      const amount = Number(sale.grossAmount);
      if (Number.isFinite(amount)) amounts.push(amount);
    }
  }

  const offerMedians = new Map<string, number>();
  for (const [offerKey, values] of offerAmounts) {
    if (!values.length) continue;
    values.sort((left, right) => left - right);
    offerMedians.set(offerKey, values[Math.floor(values.length / 2)]);
  }
  for (const history of histories.values()) {
    if (history.sales.some((sale) => sale.billingInterval)) continue;
    const event = history.events.at(-1);
    if (!event) continue;
    const key = offerKeyFor(
      history.appId,
      event.chargeName.trim().toLowerCase(),
      Number(event.amount),
    );
    const evidence = offerIntervals.get(key);
    if (evidence) {
      history.inferredInterval =
        evidence.annual > evidence.monthly ? "ANNUAL" : "EVERY_30_DAYS";
    }
    const median = offerMedians.get(key);
    if (median !== undefined) history.inferredEffectiveAmount = median;
  }
  return [...histories.values()];
}

export function contributionsAt(
  histories: ChargeHistory[],
  at: Date,
): ChargeContribution[] {
  return histories.flatMap((history) => {
    const value = contributionAt(history, at);
    if (!value) return [];
    return [value];
  });
}

/**
 * Same computation as `contributionsAt`, but keyed by history so callers that
 * need "is this specific charge contributing at `at`?" can ask in O(1) instead
 * of recomputing `contributionAt` for the same instant.
 */
export function contributionMapAt(
  histories: ChargeHistory[],
  at: Date,
): Map<ChargeHistory, ChargeContribution> {
  const map = new Map<ChargeHistory, ChargeContribution>();
  for (const history of histories) {
    const value = contributionAt(history, at);
    if (value) map.set(history, value);
  }
  return map;
}

/**
 * Drops charges that cannot contribute at or after `earliest`. Once a
 * charge's final event leaves it `terminal`, every later `contributionAt`
 * call on it returns null, so iterating it per bucket is pure waste — on a
 * mature app most charges are terminally inactive, so most per-bucket work
 * would produce nothing but nulls.
 *
 * Callers that search for *evidence* rather than contribution (a replacement
 * activation, a shop's earlier activation) must keep using the full list —
 * see `buildChurnEvidenceIndex`.
 */
export function liveHistoriesSince(
  histories: ChargeHistory[],
  earliest: Date,
): ChargeHistory[] {
  return histories.filter(
    (history) =>
      !(
        history.terminal &&
        history.lastEventAt !== null &&
        history.lastEventAt <= earliest
      ),
  );
}

function bucketEndAt(start: Date, end: Date): Date {
  return new Date(Math.max(start.getTime(), end.getTime() - 1));
}

export function activePaidHistoryMap(histories: ChargeHistory[], at: Date) {
  const active = new Map<ChargeHistory, ChargeContribution>();
  for (const history of histories) {
    const contribution = contributionAt(history, at);
    if (contribution && contribution.kind !== "trial") {
      active.set(history, contribution);
    }
  }
  return active;
}

const REPLACEMENT_WINDOW_MS = 60_000;

/**
 * Lookup tables for two churn questions that used to be answered by scanning
 * every charge/event once per bucket: "was this cancellation immediately
 * replaced?" (activations for one (app, shop) within 60s) and "had this shop
 * ever activated before the bucket started?" (earliest activation per shop).
 * Built in one pass, answered in O(log n)/O(1) after. Indexes the FULL
 * history list on purpose — the evidence can live on a charge long dead and
 * pruned from the contribution loops.
 */
export interface ChurnEvidenceIndex {
  /** Activations per `appIdshopDomain`, ascending, with their owner. */
  activationsByAppShop: Map<string, Array<{ at: Date; owner: ChargeHistory }>>;
  /** Earliest activation per shop, matched on the shop of the FIRST event. */
  earliestActivationByShop: Map<string, Date>;
  /**
   * Cancellations per app+shop, ascending, with their owner — the mirror of
   * `activationsByAppShop`.
   *
   * `isReplacementCancellation` looks FORWARD from a cancel to decide it is
   * plan-change noise, and drops it. That leaves the other half of the plan
   * change unaccounted for: the replacing activation knows nothing about the
   * price it replaced, so the MRR delta between the two plans is discarded.
   * This index lets the activation look BACK and recover it — see
   * `replacedCancellation`, which is what makes expansion and contraction
   * derivable at all.
   */
  cancellationsByAppShop: Map<
    string,
    Array<{ at: Date; owner: ChargeHistory }>
  >;
}

export function buildChurnEvidenceIndex(
  histories: ChargeHistory[],
): ChurnEvidenceIndex {
  const activationsByAppShop = new Map<
    string,
    Array<{ at: Date; owner: ChargeHistory }>
  >();
  const earliestActivationByShop = new Map<string, Date>();
  const cancellationsByAppShop = new Map<
    string,
    Array<{ at: Date; owner: ChargeHistory }>
  >();

  for (const history of histories) {
    for (const event of history.events) {
      if (event.type !== "SUBSCRIPTION_CHARGE_CANCELED") continue;
      const key = `${history.appId}\u001f${event.shopDomain}`;
      const list = cancellationsByAppShop.get(key);
      if (list) list.push({ at: event.occurredAt, owner: history });
      else
        cancellationsByAppShop.set(key, [
          { at: event.occurredAt, owner: history },
        ]);
    }
  }

  for (const history of histories) {
    // `recoveredShops` attributes a history to the shop on its first event.
    const primaryShop = history.events[0]?.shopDomain;
    for (const event of history.events) {
      if (!eventActivates(event.type)) continue;
      if (event.type === "SUBSCRIPTION_CHARGE_ACTIVATED") {
        const key = `${history.appId}${event.shopDomain}`;
        const list = activationsByAppShop.get(key);
        if (list) list.push({ at: event.occurredAt, owner: history });
        else
          activationsByAppShop.set(key, [
            { at: event.occurredAt, owner: history },
          ]);
      }
      if (primaryShop) {
        const known = earliestActivationByShop.get(primaryShop);
        if (!known || event.occurredAt < known) {
          earliestActivationByShop.set(primaryShop, event.occurredAt);
        }
      }
    }
  }
  for (const list of activationsByAppShop.values()) {
    list.sort((left, right) => left.at.getTime() - right.at.getTime());
  }
  for (const list of cancellationsByAppShop.values()) {
    list.sort((left, right) => left.at.getTime() - right.at.getTime());
  }
  return {
    activationsByAppShop,
    earliestActivationByShop,
    cancellationsByAppShop,
  };
}

/**
 * The cancellation an activation replaces, if it replaces one.
 *
 * The exact mirror of `isReplacementCancellation` — same window, same
 * different-charge rule — written that way so the two can never disagree about
 * which pairs are plan changes. If that function suppresses a cancel, this one
 * must be able to find it from the other side, or the plan change's delta
 * simply vanishes, which is the state the platform is in today.
 *
 * Returns the replaced charge's contribution just before it was cancelled: the
 * "from" price of the swap. Null when this activation is an entry, not a swap.
 */
export function replacedCancellation(
  history: ChargeHistory,
  index: ChurnEvidenceIndex,
  at: Date,
): ChargeContribution | null {
  const event = lastAt(history.events, at);
  if (!event || event.type !== "SUBSCRIPTION_CHARGE_ACTIVATED") return null;
  const entries = index.cancellationsByAppShop.get(
    `${history.appId}\u001f${event.shopDomain}`,
  );
  if (!entries) return null;
  const activatedAtMs = event.occurredAt.getTime();
  /* Backwards from this activation: the nearest qualifying cancel wins, so a
     shop cancelling two plans in the same minute pairs each activation with the
     closest one rather than the oldest.
     
     `activatedAtMs + 1` so a cancel at the SAME instant is included. §4.a's
     window is [cancel, cancel + 60s) — closed at the cancel — and Shopify
     writes the pair atomically, so equal timestamps are the common case, not an
     edge one. Starting at `lowerBound(activatedAtMs)` skipped every one of
     them, which is what left expansion two thirds short and pushed the missed
     pairs into `reactivation` instead. */
  for (let i = lowerBound(entries, activatedAtMs + 1) - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (activatedAtMs - entry.at.getTime() >= REPLACEMENT_WINDOW_MS) return null;
    if (entry.owner === history) continue;
    // Valued the instant before it went away, exactly as
    // `subscriptionChurnTransitions` values a churn.
    return contributionAt(entry.owner, new Date(entry.at.getTime() - 1));
  }
  return null;
}

/** Index of the first entry whose timestamp is >= `from`. */
function lowerBound(
  entries: Array<{ at: Date }>,
  from: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].at.getTime() < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function isReplacementCancellation(
  history: ChargeHistory,
  index: ChurnEvidenceIndex,
  at: Date,
): boolean {
  const event = lastAt(history.events, at);
  if (!event || event.type !== "SUBSCRIPTION_CHARGE_CANCELED") return false;
  const entries = index.activationsByAppShop.get(
    `${history.appId}${event.shopDomain}`,
  );
  if (!entries) return false;
  const canceledAtMs = event.occurredAt.getTime();
  for (let i = lowerBound(entries, canceledAtMs); i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.at.getTime() - canceledAtMs >= REPLACEMENT_WINDOW_MS) return false;
    if (entry.owner !== history) return true;
  }
  return false;
}

/** Build gross subscription revenue from immutable Partner sale facts. */
export function buildPartnerRevenueFromFacts(params: {
  sales: SaleFact[];
  period: PortfolioReport["period"];
  periodStart: Date;
  periodEnd: Date;
  interval: "day" | "week" | "month";
}): RevenueReport {
  const buckets = buildUtcBuckets({
    start: params.periodStart,
    end: params.periodEnd,
    interval: params.interval,
  });
  const currencies = [
    ...new Set(
      params.sales
        .filter(
          (sale) =>
            sale.grossAmount != null &&
            sale.currencyCode &&
            sale.occurredAt >= params.periodStart &&
            sale.occurredAt < params.periodEnd,
        )
        .map((sale) => sale.currencyCode!),
    ),
  ].sort();

  // One pass over the sales instead of one per (currency, bucket). The filter
  // below used to re-scan every sale in the account for each cell of the grid.
  const grossByCurrency = new Map<string, number[]>();
  for (const currency of currencies) {
    grossByCurrency.set(currency, new Array(buckets.length).fill(0));
  }
  for (const sale of params.sales) {
    if (sale.grossAmount == null || !sale.currencyCode) continue;
    const totals = grossByCurrency.get(sale.currencyCode);
    if (!totals) continue;
    const occurredAt = sale.occurredAt.getTime();
    // Buckets are contiguous and ascending, so the last one starting at or
    // before the sale is the only candidate.
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
    totals[index] += Number(sale.grossAmount);
  }

  return {
    period: params.period,
    periodStart: params.periodStart.toISOString(),
    periodEnd: params.periodEnd.toISOString(),
    interval: params.interval,
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

/**
 * Reconstruct paid logo, subscription, and revenue churn from the same charge
 * state used by MRR. A replacement activation within 60 seconds suppresses
 * the old charge cancellation so plan changes are not reported as churn.
 */
export function buildPartnerChurnFromFacts(params: {
  events: EventFact[];
  sales: SaleFact[];
  period: PortfolioReport["period"];
  periodStart: Date;
  periodEnd: Date;
  interval: "day" | "week" | "month";
  /** Prebuilt histories, so one report does not group the same facts twice. */
  histories?: ChargeHistory[];
}): ChurnReport {
  const histories =
    params.histories ?? historiesFromFacts(params.events, params.sales);
  const buckets = buildUtcBuckets({
    start: params.periodStart,
    end: params.periodEnd,
    interval: params.interval,
  });
  // The earliest instant this builder ever asks about is the first bucket's
  // start, so anything terminally inactive by then can only ever answer null.
  const live = liveHistoriesSince(histories, params.periodStart);
  const evidence = buildChurnEvidenceIndex(histories);
  const movements = buckets.map((bucket) => {
    const endAt = bucketEndAt(bucket.start, bucket.end);
    const startActive = activePaidHistoryMap(live, bucket.start);
    const endActive = activePaidHistoryMap(live, endAt);
    const lost = [...startActive.entries()].filter(
      ([history]) =>
        !endActive.has(history) &&
        !isReplacementCancellation(history, evidence, endAt),
    );
    const recovered = [...endActive.keys()].filter(
      (history) =>
        !startActive.has(history) &&
        history.events.some(
          (event) =>
            eventActivates(event.type) && event.occurredAt < bucket.start,
        ),
    );
    const startShops = new Set(
      [...startActive.values()].map((value) => value.shopDomain),
    );
    const endShops = new Set(
      [...endActive.values()].map((value) => value.shopDomain),
    );
    const lostShops = [...startShops].filter((shop) => !endShops.has(shop));
    const recoveredShops = [...endShops].filter((shop) => {
      if (startShops.has(shop)) return false;
      const earliest = evidence.earliestActivationByShop.get(shop);
      return earliest !== undefined && earliest < bucket.start;
    });
    return {
      bucket,
      startActive,
      lost,
      recovered,
      startShops,
      lostShops,
      recoveredShops,
    };
  });

  const logoTimeSeries = movements.map((item) => {
    const netLost = item.lostShops.length - item.recoveredShops.length;
    return {
      periodStart: item.bucket.start.toISOString(),
      periodEnd: item.bucket.end.toISOString(),
      lost: item.lostShops.length,
      recovered: item.recoveredShops.length,
      netLost,
      denominator: item.startShops.size,
      rate: item.startShops.size ? round(netLost / item.startShops.size, 6) : 0,
      provisional: item.bucket.provisional,
    };
  });
  const subscriptionTimeSeries = movements.map((item) => {
    const netLost = item.lost.length - item.recovered.length;
    return {
      periodStart: item.bucket.start.toISOString(),
      periodEnd: item.bucket.end.toISOString(),
      lost: item.lost.length,
      recovered: item.recovered.length,
      netLost,
      denominator: item.startActive.size,
      rate: item.startActive.size
        ? round(netLost / item.startActive.size, 6)
        : 0,
      provisional: item.bucket.provisional,
    };
  });
  const currencies = [
    ...new Set(
      params.events
        .filter((event) => !event.test)
        .map((event) => event.currencyCode),
    ),
  ].sort();
  const revenueCurrencies = currencies.map((currency) => {
    const timeSeries = movements.map((item) => {
      const startMrr = round(
        [...item.startActive.values()]
          .filter((value) => value.currency === currency)
          .reduce((sum, value) => sum + value.amount, 0),
      );
      const lostMrr = round(
        item.lost
          .map(([, value]) => value)
          .filter((value) => value.currency === currency)
          .reduce((sum, value) => sum + value.amount, 0),
      );
      return {
        periodStart: item.bucket.start.toISOString(),
        periodEnd: item.bucket.end.toISOString(),
        lostMrr,
        startMrr,
        rate: startMrr ? round(lostMrr / startMrr, 6) : 0,
        provisional: item.bucket.provisional,
      };
    });
    const lostMrr = round(
      timeSeries.reduce((sum, point) => sum + point.lostMrr, 0),
    );
    const startMrr = timeSeries[0]?.startMrr ?? 0;
    return {
      currency,
      value: {
        lostMrr,
        startMrr,
        rate: startMrr ? round(lostMrr / startMrr, 6) : 0,
      },
      timeSeries,
    };
  });
  const logoNet = logoTimeSeries.reduce((sum, point) => sum + point.netLost, 0);
  const subNet = subscriptionTimeSeries.reduce(
    (sum, point) => sum + point.netLost,
    0,
  );
  const logoDenominator = logoTimeSeries[0]?.denominator ?? 0;
  const subDenominator = subscriptionTimeSeries[0]?.denominator ?? 0;

  return {
    period: params.period,
    periodStart: params.periodStart.toISOString(),
    periodEnd: params.periodEnd.toISOString(),
    interval: params.interval,
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

/**
 * Shopify exposes no explicit trial object — the initial ACTIVATED event's
 * first billing date plus the first sale/cancel event's outcome are all we
 * have. Kept in one helper so the current card and every chart bucket use
 * the same boundary rules.
 */
function inferredTrialLifecycle(
  history: ChargeHistory,
  asOf: Date,
): InferredTrialLifecycle | null {
  const activation = history.events.find(
    (event) =>
      event.type === "SUBSCRIPTION_CHARGE_ACTIVATED" && event.test === false,
  );
  if (!activation?.billingOn) return null;
  const duration =
    activation.billingOn.getTime() - activation.occurredAt.getTime();
  if (duration <= 12 * 60 * 60_000 || duration > MAX_INFERRED_TRIAL_WINDOW_MS) {
    return null;
  }

  const expiresAt = new Date(activation.billingOn);
  const cancellation = history.events.find(
    (event) =>
      event.occurredAt >= activation.occurredAt &&
      event.occurredAt <= expiresAt &&
      event.test === false &&
      (event.type === "SUBSCRIPTION_CHARGE_CANCELED" ||
        event.type === "SUBSCRIPTION_CHARGE_DECLINED" ||
        event.type === "SUBSCRIPTION_CHARGE_EXPIRED"),
  );
  /* Same normalization `contributionAt` applies: an annual plan's listed
     price is a year's worth, and a trials table in monthly terms must not mix
     the two. */
  const trialInterval = intervalForCharge(history, asOf, activation);
  const monthlyAmount =
    trialInterval === "ANNUAL"
      ? Number(activation.amount) / 12
      : Number(activation.amount);

  if (cancellation && cancellation.occurredAt <= asOf) {
    return {
      startedAt: activation.occurredAt,
      expiresAt,
      convertedAt: null,
      canceledAt: cancellation.occurredAt,
      monthlyAmount,
    };
  }

  const firstSale = history.sales.find(
    (sale) =>
      sale.occurredAt >= activation.occurredAt && sale.occurredAt <= asOf,
  );
  const paidContribution =
    asOf >= expiresAt ? contributionAt(history, asOf) : null;
  return {
    startedAt: activation.occurredAt,
    expiresAt,
    convertedAt:
      firstSale?.occurredAt ??
      (paidContribution && paidContribution.kind !== "trial"
        ? expiresAt
        : null),
    canceledAt: null,
    monthlyAmount,
  };
}

export function subscriptionChurnAt(
  histories: ChargeHistory[],
  currency: string,
  at: Date,
  /**
   * Contributions already computed for this instant — avoids re-running
   * `contributionAt` over every charge a second time per bucket.
   */
  currentAt?: Map<ChargeHistory, ChargeContribution>,
): {
  denominator: number;
  churned: number;
  rate: number;
  /**
   * Non-trial MRR in this currency 30 days before `at`.
   *
   * Free: this function already evaluates `contributionAt` at `rollingStart`
   * for every history to build the churn denominator, and simply discarded the
   * amount. Returning it gives the reports a trailing-30-day base — the only
   * honest way to plot a MONTHLY growth rate on a daily series — without a
   * second pass over 60k+ charges per bucket.
   */
  startMrr: number;
} {
  const rollingStart = new Date(at.getTime() - 30 * 86_400_000);
  let denominator = 0;
  let churned = 0;
  let startMrr = 0;

  for (const history of histories) {
    const startContribution = contributionAt(history, rollingStart);
    if (
      !startContribution ||
      startContribution.kind === "trial" ||
      startContribution.currency !== currency
    ) {
      continue;
    }
    denominator++;
    startMrr += startContribution.amount;

    // A later activation/unfreeze means the charge recovered inside the
    // window, so this is net subscription churn rather than raw event volume.
    const stillContributing = currentAt
      ? currentAt.has(history)
      : Boolean(contributionAt(history, at));
    if (stillContributing) continue;
    const endEvent = lastAt(history.events, at);
    if (
      !endEvent ||
      endEvent.occurredAt <= rollingStart ||
      endEvent.test ||
      endEvent.type === "SUBSCRIPTION_CHARGE_FROZEN"
    ) {
      continue;
    }
    if (
      endEvent.type === "SUBSCRIPTION_CHARGE_CANCELED" ||
      endEvent.type === "SUBSCRIPTION_CHARGE_DECLINED" ||
      endEvent.type === "SUBSCRIPTION_CHARGE_EXPIRED"
    ) {
      churned++;
    }
  }

  return {
    denominator,
    churned,
    rate: denominator > 0 ? round(churned / denominator, 6) : 0,
    startMrr: round(startMrr),
  };
}

/**
 * Totals for one currency at one instant.
 *
 * `mrr` here is the GROSS run rate: monthly + annual + trial. That is
 * deliberate and it is what `PartnerDailyMrrSnapshot.mrr` stores — the
 * snapshot is a record of every component, so a reader can compose whichever
 * definition it needs without a rebuild.
 *
 * It is NOT the figure the dashboard headlines. Reports compose COMMITTED MRR
 * (trials excluded by default) from the components — see `composeMrr` in
 * `routes/app/reports.tsx`, the single place that rule lives. Anyone
 * reconciling this number against another tool must know which of the two they
 * are holding: they differ by the whole trial band, which was ~6% of the run
 * rate on 2026-09-09 and ~2% a month earlier.
 */
export function summarizeContributions(
  contributions: ChargeContribution[],
  currency: string,
) {
  const selected = contributions.filter(
    (contribution) => contribution.currency === currency,
  );
  const monthlySubscriptions = round(
    selected
      .filter((contribution) => contribution.kind === "monthly")
      .reduce((sum, contribution) => sum + contribution.amount, 0),
  );
  const annualSubscriptions = round(
    selected
      .filter((contribution) => contribution.kind === "annual")
      .reduce((sum, contribution) => sum + contribution.amount, 0),
  );
  const trialSubscriptions = round(
    selected
      .filter((contribution) => contribution.kind === "trial")
      .reduce((sum, contribution) => sum + contribution.amount, 0),
  );
  const activeSubscriptions = selected.filter(
    (contribution) => contribution.kind !== "trial",
  ).length;
  return {
    monthlySubscriptions,
    annualSubscriptions,
    trialSubscriptions,
    mrr: round(monthlySubscriptions + annualSubscriptions + trialSubscriptions),
    activeSubscriptions,
    activeCustomers: new Set(
      selected.map((contribution) => contribution.shopDomain),
    ).size,
    activePayingCustomers: new Set(
      selected
        .filter((contribution) => contribution.kind !== "trial")
        .map((contribution) => contribution.shopDomain),
    ).size,
  };
}

/** Mantle's card shows 6-7 lines; more than this is unreadable by color. */
const TOP_PLANS_LIMIT = 8;

/**
 * Optional display labels for plans, keyed by app display name, then by
 * `<charge name>|<LIST price>|<cadence>` (e.g. `"Starter|9.99|annual"`).
 *
 * Why all three parts of the key are needed:
 *
 *   - NAME alone is not a plan. One charge name can cover several plans sold
 *     at different prices.
 *   - LIST price, never the charged amount. A discount must not create a plan.
 *   - CADENCE, because the same tier is often sold both monthly and annually.
 *
 * Map the monthly and annual variants of a tier to the SAME label to merge them
 * into one series.
 *
 * An unmapped charge passes straight through under whatever Shopify called it,
 * so a newly launched plan shows up as itself rather than being folded into an
 * existing label. Empty by default.
 */
const MANTLE_PLAN_LABELS: Record<string, Record<string, string>> = {};

/**
 * The plan label to display for one contribution — Mantle's name when the
 * catalogue above knows this plan, otherwise the raw charge name.
 *
 * Exported for `PartnerDailyPlanMrrSnapshot`'s writer, which must resolve
 * labels the same way this file's live reconstruction does or the two report
 * paths would group revenue differently.
 */
export function mantlePlanLabel(
  appName: string | undefined,
  contribution: ChargeContribution,
): string {
  const plan = contribution.planName.trim();
  if (!appName) return plan;
  const key =
    `${plan}|${contribution.planListedAmount.toFixed(2)}|${contribution.kind}`;
  return MANTLE_PLAN_LABELS[appName]?.[key] ?? plan;
}

/** The key `planMrr` is built under, shared by both report paths. */
export function planMrrKey(currency: string, appId: string, plan: string): string {
  return `${currency}\u001f${appId}\u001f${plan}`;
}

/**
 * Turns per-bucket plan MRR into the ranked, capped "Top plans by MRR" series.
 *
 * Shared by the live reconstruction and the snapshot read path so the two
 * cannot rank, label or cap differently — the card must not change shape
 * depending on which path served the request.
 *
 * Ranked by the LAST bucket's value, which is what "top plans" means: the plans
 * carrying the business now, not the ones that carried it once. Capped because
 * the chart is read by colour and a legend of twenty plan names is unreadable —
 * the tail is genuinely long, since per-merchant custom charge names each
 * become their own series.
 */
export function rankPlanMrrSeries(params: {
  /** `planMrrKey` -> MRR per bucket, positionally aligned with `buckets`. */
  planMrr: Map<string, Float64Array>;
  buckets: Array<{ start: Date }>;
  appNames?: Map<string, string>;
}): PlanMrrSeries[] {
  /* Two steps, because the label depends on which series SURVIVE. A plan name
     is only ambiguous if two apps both still carry revenue on it — if one of
     them contributes $0 today, suffixing it with an app name would only add
     noise. */
  const candidates = [...params.planMrr.entries()]
    .map(([key, byBucket]) => {
      const [currency, appId, rawPlan] = key.split("\u001f") as [
        string,
        string,
        string,
      ];
      const points = params.buckets.map((bucket, index) => ({
        periodStart: bucket.start.toISOString(),
        mrr: round(byBucket[index] ?? 0),
      }));
      const current = points.at(-1)?.mrr ?? 0;
      return {
        appId,
        rawPlan,
        currency,
        points,
        current,
        change: round(current - (points[0]?.mrr ?? 0)),
      };
    })
    .filter((series) => series.current > 0 || series.change !== 0);

  const appsByPlanName = new Map<string, Set<string>>();
  for (const series of candidates) {
    const set = appsByPlanName.get(series.rawPlan) ?? new Set<string>();
    set.add(series.appId);
    appsByPlanName.set(series.rawPlan, set);
  }

  return candidates
    .map((series) => {
      const shared = (appsByPlanName.get(series.rawPlan)?.size ?? 1) > 1;
      const appName = params.appNames?.get(series.appId);
      return {
        plan: shared && appName ? `${series.rawPlan} · ${appName}` : series.rawPlan,
        currency: series.currency,
        points: series.points,
        current: series.current,
        change: series.change,
      };
    })
    .sort((left, right) => right.current - left.current)
    .slice(0, TOP_PLANS_LIMIT);
}

export function buildPartnerRecurringFromFacts(params: {
  events: EventFact[];
  sales: SaleFact[];
  periodStart: Date;
  periodEnd: Date;
  interval: "day" | "week" | "month";
  /** Prebuilt histories, so one report does not group the same facts twice. */
  histories?: ChargeHistory[];
  /**
   * appId -> display name. Selects the app's entry in `MANTLE_PLAN_LABELS`, and
   * disambiguates a label two apps both use. Omitted means plans are grouped
   * under their raw Shopify charge names.
   */
  appNames?: Map<string, string>;
}): {
  currencies: RecurringCurrencySummary[];
  timeSeries: RecurringPoint[];
  trials: PortfolioReport["trials"];
  /** Filled in by the caller that has the range — see the live path below. */
  movement?: MrrMovementSummary[];
  /** Top plans by MRR, ranked by their value at the last bucket. */
  planSeries?: PlanMrrSeries[];
} {
  const histories =
    params.histories ?? historiesFromFacts(params.events, params.sales);
  const buckets = buildUtcBuckets({
    start: params.periodStart,
    end: params.periodEnd,
    interval: params.interval,
  });
  // `subscriptionChurnAt` looks back 30 days from the earliest bucket, so that
  // is the earliest instant anything here is asked about.
  const live = liveHistoriesSince(
    histories,
    new Date(params.periodStart.getTime() - 30 * DAY_MS),
  );
  const currencies = [
    ...new Set(
      params.events.filter((event) => !event.test).map((e) => e.currencyCode),
    ),
  ].sort();
  const timeSeries: RecurringPoint[] = [];
  /* `${currency}\u001f${plan}` -> MRR per bucket. A typed array because this is
     one slot per bucket per plan and it is written once per charge per bucket —
     the hottest allocation in the loop below. */
  const planMrr = new Map<string, Float64Array>();

  // [DIAG] dominant period-scaling cost (2s+ at 90 days vs ~500ms at 30) —
  // kept permanently, same convention as other [DIAG] checkpoints here.
  const bucketLoopStartedAt = Date.now();
  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
    const bucket = buckets[bucketIndex]!;
    const at = new Date(
      Math.max(bucket.start.getTime(), bucket.end.getTime() - 1),
    );
    // Subscription charge lifecycle is the billing source of truth — do not
    // gate it with the install mirror, which drops valid charges when backfill lags.
    const currentAt = contributionMapAt(live, at);
    const contributions = [...currentAt.values()];
    /* Accumulated inside the EXISTING bucket loop rather than in a second pass.
       This loop is already O(buckets x charges) and is the most expensive thing
       in the report; walking it twice to group the same contributions by plan
       would double that for a chart, which is not a trade worth making.

       The plan name is read from the event `isChargeActive` picked for this
       instant, so a charge that changed plan mid-range is attributed to
       whichever plan it was actually on in each bucket. */
    for (const [history, contribution] of currentAt) {
      if (contribution.kind === "trial") continue;
      /* Labelled HERE, at accumulation, not when reading the map back: renaming
         after the fact would leave two entries wearing the same label instead
         of one merged series. */
      const plan = mantlePlanLabel(
        params.appNames?.get(history.appId),
        contribution,
      );
      if (!plan) continue;
      /* Keyed by APP as well as plan. Two apps can each have a plan called
         "Monthly Plan", and they are different plans at different prices.
         Merging them on name alone would sum both under one label. */
      const key = planMrrKey(contribution.currency, history.appId, plan);
      const byBucket =
        planMrr.get(key) ??
        (() => {
          const created = new Float64Array(buckets.length);
          planMrr.set(key, created);
          return created;
        })();
      byBucket[bucketIndex] += contribution.amount;
    }
    for (const currency of currencies) {
      const summary = summarizeContributions(contributions, currency);
      const churn = subscriptionChurnAt(live, currency, at, currentAt);
      timeSeries.push({
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        currency,
        monthlySubscriptions: summary.monthlySubscriptions,
        annualSubscriptions: summary.annualSubscriptions,
        usageCharges: 0,
        trialSubscriptions: summary.trialSubscriptions,
        mrr: summary.mrr,
        arr: round(summary.mrr * 12),
        activeSubscriptions: summary.activeSubscriptions,
        activeCustomers: summary.activeCustomers,
        activePayingCustomers: summary.activePayingCustomers,
        subscriptionChurnDenominator: churn.denominator,
        churnedSubscriptions: churn.churned,
        monthlySubscriptionChurnRate: churn.rate,
        mrrThirtyDaysAgo: churn.startMrr,
        monthlyMrrGrowthRate:
          churn.startMrr > 0
            ? round((summary.mrr - churn.startMrr) / churn.startMrr, 6)
            : null,
        provisional: bucket.provisional,
      });
    }
  }

  console.log(
    `[DIAG] recurring bucket loop buckets=${buckets.length} charges=${live.length}: ${Date.now() - bucketLoopStartedAt}ms`,
  );

  const startContributions = contributionsAt(live, params.periodStart);
  const currentAt = new Date(
    Math.max(params.periodStart.getTime(), params.periodEnd.getTime() - 1),
  );
  const currentContributions = contributionsAt(live, currentAt);
  const currencySummaries = currencies.map(
    (currency): RecurringCurrencySummary => {
      const starting = summarizeContributions(startContributions, currency);
      const current = summarizeContributions(currentContributions, currency);
      return {
        currency,
        mrr: current.mrr,
        arr: round(current.mrr * 12),
        monthlySubscriptions: current.monthlySubscriptions,
        annualSubscriptions: current.annualSubscriptions,
        usageCharges: 0,
        trialSubscriptions: current.trialSubscriptions,
        startingMrr: starting.mrr,
        netMrrGrowth: round(current.mrr - starting.mrr),
        growthRate:
          starting.mrr > 0
            ? round((current.mrr - starting.mrr) / starting.mrr, 6)
            : 0,
        activeSubscriptions: current.activeSubscriptions,
        activeCustomers: current.activeCustomers,
      };
    },
  );

  const trials = buildPartnerTrialsFromFacts({
    histories,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    buckets,
    currentAt,
  });

  const planSeries = rankPlanMrrSeries({
    planMrr,
    buckets,
    appNames: params.appNames,
  });

  return {
    currencies: currencySummaries,
    timeSeries,
    trials,
    planSeries,
  };
}

/**
 * Extracted from `buildPartnerRecurringFromFacts` so callers that only need
 * trial-lifecycle data (e.g. once `.recurring`/`.revenue` come from
 * `PartnerDailyMrrSnapshot`) skip the per-bucket `contributionMapAt`/
 * `subscriptionChurnAt` loop — the dominant period-scaling cost (2s+ at 90
 * days vs ~500ms at 30). Trial-window inference is a single pass over
 * `histories` (once per charge) and stays live permanently: it needs full
 * per-charge event sequences, not a persistable stock/flow, so
 * `loadPartnerFacts` is still required upstream.
 */
export function buildPartnerTrialsFromFacts(params: {
  histories: ChargeHistory[];
  periodStart: Date;
  periodEnd: Date;
  buckets: ReturnType<typeof buildUtcBuckets>;
  /** The instant "now" resolves to — pass the same value
   * `buildPartnerRecurringFromFacts` computes so both stay consistent. */
  currentAt: Date;
}): PortfolioReport["trials"] {
  const { histories, periodStart, periodEnd, buckets, currentAt } = params;
  const allTrialLifecycles = histories.flatMap((history) => {
    const lifecycle = inferredTrialLifecycle(history, currentAt);
    return lifecycle ? [lifecycle] : [];
  });

  /* The whole report over whatever slice of trials it is handed, so the
     paid-only variant is the SAME code on a smaller list rather than a second
     set of counters kept in step by hand. Nothing below changed when this
     wrapper was introduced. */
  const fold = (trialLifecycles: InferredTrialLifecycle[]) => {
    const periodTrialLifecycles = trialLifecycles.filter(
      (trial) => trial.startedAt >= periodStart && trial.startedAt < periodEnd,
    );
    const converted = periodTrialLifecycles.filter(
      (trial) => trial.convertedAt && trial.convertedAt <= currentAt,
    ).length;
    const canceled = periodTrialLifecycles.filter(
      (trial) => trial.canceledAt && trial.canceledAt <= currentAt,
    ).length;
    const activeInPeriodCohort = periodTrialLifecycles.filter(
      (trial) =>
        trial.startedAt <= currentAt &&
        trial.expiresAt > currentAt &&
        (!trial.canceledAt || trial.canceledAt > currentAt),
    ).length;
    const unresolved = Math.max(
      periodTrialLifecycles.length -
        converted -
        canceled -
        activeInPeriodCohort,
      0,
    );
    const trialTimeSeries = buckets.map((bucket) => {
      const at = new Date(
        Math.max(bucket.start.getTime(), bucket.end.getTime() - 1),
      );
      const startedTrials = trialLifecycles.filter(
        (trial) =>
          trial.startedAt >= bucket.start && trial.startedAt < bucket.end,
      );
      const started = startedTrials.length;
      /* Kept as the matching ROWS, not just counts, so each figure can be
       reported either way — the table shows money, the pills show counts. */
      const convertedTrials = trialLifecycles.filter(
        (trial) =>
          trial.convertedAt &&
          trial.convertedAt >= bucket.start &&
          trial.convertedAt < bucket.end,
      );
      const canceledTrials = trialLifecycles.filter(
        (trial) =>
          trial.canceledAt &&
          trial.canceledAt >= bucket.start &&
          trial.canceledAt < bucket.end,
      );
      const activeTrials = trialLifecycles.filter(
        (trial) =>
          trial.startedAt <= at &&
          trial.expiresAt > at &&
          (!trial.canceledAt || trial.canceledAt > at),
      );
      const bucketConverted = convertedTrials.length;
      const bucketCanceled = canceledTrials.length;
      const active = activeTrials.length;
      const sumAmount = (trials: InferredTrialLifecycle[]) =>
        trials.reduce((total, trial) => total + trial.monthlyAmount, 0);
      return {
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        startedValue: sumAmount(startedTrials),
        activeValue: sumAmount(activeTrials),
        convertedValue: sumAmount(convertedTrials),
        canceledValue: sumAmount(canceledTrials),
        started,
        converted: bucketConverted,
        canceled: bucketCanceled,
        active,
        conversionRate:
          bucketConverted + bucketCanceled > 0
            ? round(bucketConverted / (bucketConverted + bucketCanceled), 6)
            : 0,
        provisional: bucket.provisional,
      };
    });
    return {
      started: periodTrialLifecycles.length,
      converted,
      canceled,
      completed: converted + canceled,
      unresolved,
      conversionRate:
        converted + canceled > 0
          ? round(converted / (converted + canceled), 6)
          : 0,
      activeNow: trialLifecycles.filter(
        (trial) =>
          trial.startedAt <= currentAt &&
          trial.expiresAt > currentAt &&
          (!trial.canceledAt || trial.canceledAt > currentAt) &&
          /*
          A trial that has already been PAID is not an active trial, it is a
          customer. Without this the same subscription is counted as a live trial
          and as paying revenue at once, for the whole remainder of the window its
          `billingOn` describes — which is how a charge that was billed on day one
          kept showing up under "trials active now" three weeks later.
        */
          (!trial.convertedAt || trial.convertedAt > currentAt),
      ).length,
      timeSeries: trialTimeSeries,
    };
  };

  const all = fold(allTrialLifecycles);
  return {
    ...all,
    source: "shopify_partner_inferred",
    historyComplete: all.unresolved === 0,
    /* "Free" is a $0 plan — the same test the trial history table applies to
       `monthlyAmount`, so the toolbar toggle and the table agree. */
    paidOnly: fold(
      allTrialLifecycles.filter((trial) => trial.monthlyAmount > 0),
    ),
  };
}

export interface PersistedPartnerAnalytics {
  recurring: ReturnType<typeof buildPartnerRecurringFromFacts>;
  revenue: RevenueReport;
  churn: ChurnReport;
}

/**
 * Value-cached in Redis (`recurring:` prefix) so cluster workers share one
 * reconstruction; same-worker concurrent callers on a cold miss additionally
 * share one in-flight promise via `cachedWithRedis`.
 * Must stay equal to `RANGE_QUANTUM_MS` — see the note on that constant.
 */
const RECURRING_CACHE_MS = RANGE_QUANTUM_MS;

export interface PartnerFactsBundle {
  events: EventFact[];
  sales: SaleFact[];
  histories: ChargeHistory[];
}

/**
 * The raw-facts read and the grouping/inference pass in `historiesFromFacts`
 * — the two most expensive steps in the reconstruction — depend only on
 * `appIds` and `periodEnd`. Every relative period (`last_30_days`,
 * `last_90_days`, etc.) resolves `periodEnd` to the same quantized "now"
 * (see `rangeFor`), so this bundle is identical across all of them even
 * though `buildPersistedPartnerAnalytics`'s `recurring:` cache keys on the
 * full period/interval and would otherwise rebuild it per period.
 *
 * Cached separately on just the shared part, so the first caller in a
 * quantum pays for the read+grouping once and every other period in the
 * same window reuses it, paying only its own fast bucket walk.
 *
 * Deliberately NOT keyed on `syncStamp` and NOT cleared by
 * `invalidatePersistedPartnerMrrCache`: near-continuous sync churn would
 * otherwise mean this bundle rarely survives long enough to be shared.
 * `FACTS_CACHE_MS` is its own longer TTL, trading facts lagging the latest
 * sync by up to that long for far fewer full rebuilds — the UI's freshness
 * badge reflects the sync, not this cache, so a number can trail "just
 * synced" briefly. Acceptable for an internal dashboard, not customer-facing.
 */
const FACTS_CACHE_MS = 10 * 60_000;

function factsCacheKey(appIds: string[], periodEnd: Date) {
  // Sorted: `apps.findMany` has no `orderBy`, so two callers can legitimately
  // get the same app set back in different row order. Unsorted, `JSON.stringify`
  // would treat those as different keys and the paths would never share a cache entry.
  return JSON.stringify({
    appIds: [...appIds].sort(),
    periodEnd: periodEnd.toISOString(),
  });
}

export function loadPartnerFacts(
  appIds: string[],
  periodEnd: Date,
): Promise<PartnerFactsBundle> {
  const key = `facts:${factsCacheKey(appIds, periodEnd)}`;
  return cachedWithRedis(key, FACTS_CACHE_MS, async (): Promise<PartnerFactsBundle> => {
    const [events, sales] = await Promise.all([
      prisma.partnerSubscriptionEvent.findMany({
        where: {
          appId: { in: appIds },
          occurredAt: { lt: periodEnd },
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
        where: {
          appId: { in: appIds },
          occurredAt: { lt: periodEnd },
        },
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
    // Group and sort the facts ONCE — the recurring and churn builders used
    // to each do this independently, re-grouping/re-sorting ~100k events
    // a second time per report.
    const offerPins = await resolveOfferCadencePins(events, sales);
    const liveDiscountChecks = await loadLiveDiscountChecks(appIds, periodEnd);
    const histories = historiesFromFacts(events, sales, offerPins, liveDiscountChecks);
    return { events, sales, histories };
  });
}

/**
 * How long a persisted check's discount amount stays trusted. A check is a
 * READING of a live subscription, so it's only as good as its last refresh:
 * a discount ends, a merchant changes plan, and the recorded amount silently
 * stops being true. Past this window we'd rather fall back to event/sale
 * data — which is at least self-consistent — than keep asserting a number
 * nothing has re-verified.
 *
 * Deliberately many multiples of the job's own `STALE_MS` (24h) so a few
 * missed cron ticks can't make the reported MRR flap; reaching it at all
 * means the refresh path is broken, which is exactly when trusting the old
 * value is most dangerous. Found the hard way 2026-09-09: every one of 359
 * rows still carried a `checkedAt` from a single manual run a week earlier,
 * and they had been holding committed MRR down the entire time with nothing
 * anywhere reporting a problem.
 *
 * Applies ONLY to the discount amount, never to `inactiveSince` — see the
 * asymmetry note in `loadLiveDiscountChecks`.
 */
const LIVE_CHECK_TRUST_MS = 7 * DAY_MS;

/**
 * The day `activeSubscription.trialEndsAt` was added to the live check's query.
 *
 * A row written before this cannot carry a trial end, so its null is an absence
 * rather than an answer. Gating on `checkedAt` is what lets a null be read as
 * "Shopify says no trial" for rows written after — see `liveTrialEndKnown`. The
 * 359 rows that predate it all date from 2026-09-02, and every one is excluded.
 */
const TRIAL_END_RECORDED_FROM = new Date("2026-09-09T00:00:00.000Z");

/** What one persisted live check contributes to the reconstruction. */
export interface ResolvedLiveCheckValue {
  effectiveAmount: number | null;
  inactiveSince: Date | null;
  trialEndsAt: Date | null;
  trialEndKnown: boolean;
}

/**
 * Read-only lookup of already-persisted live-discount checks — never calls
 * Shopify itself (that only ever happens in `syncLiveDiscountChecksForApp`,
 * the background job). A stale/never-checked charge just means this map has
 * nothing for it, and `contributionAt` falls back exactly as it did before
 * this feature existed.
 */
export async function loadLiveDiscountChecks(
  appIds: string[],
  at: Date = new Date(),
): Promise<Map<string, ResolvedLiveCheckValue>> {
  const rows = await prisma.partnerChargeLiveDiscountCheck.findMany({
    where: { appId: { in: appIds } },
    select: {
      appId: true,
      chargePlatformId: true,
      effectiveAmount: true,
      subscriptionActive: true,
      trialEndsAt: true,
      checkedAt: true,
    },
  });
  const result = new Map<string, ResolvedLiveCheckValue>();
  for (const row of rows) {
    result.set(chargeKey(row.appId, row.chargePlatformId), resolveLiveCheck(row, at));
  }
  return result;
}

/**
 * What one persisted check is still worth as of `at`. Split out from
 * `loadLiveDiscountChecks` so the trust rule is testable without a database.
 *
 * Asymmetric on purpose. A discount amount describes the subscription as it
 * was when we looked, so it expires (`LIVE_CHECK_TRUST_MS`) and the caller
 * falls back to event/sale data. "Shopify has no active subscription for
 * this charge" describes a charge that has ENDED — a fact about the past
 * that only gets truer with age. Expiring that would resurrect
 * subscriptions we've already confirmed are gone and overstate MRR.
 */
export function resolveLiveCheck(
  row: {
    effectiveAmount: Prisma.Decimal | number | null;
    subscriptionActive: boolean;
    trialEndsAt: Date | null;
    checkedAt: Date;
  },
  at: Date = new Date(),
): ResolvedLiveCheckValue {
  const staleMs = at.getTime() - row.checkedAt.getTime();
  return {
    effectiveAmount:
      row.effectiveAmount !== null && staleMs <= LIVE_CHECK_TRUST_MS
        ? Number(row.effectiveAmount)
        : null,
    inactiveSince: row.subscriptionActive ? null : row.checkedAt,
    trialEndsAt: row.trialEndsAt,
    /*
      Not expired by `LIVE_CHECK_TRUST_MS` the way `effectiveAmount` is, and the
      asymmetry is deliberate: a discount can end after we looked, so a stale
      amount is a guess again — but "when did this charge's trial end" is a fixed
      fact about that charge, and a date in the past stays in the past. Expiring
      it would flip the charge back to the heuristic and make the band oscillate
      with the job's schedule.
    */
    trialEndKnown: row.checkedAt >= TRIAL_END_RECORDED_FROM,
  };
}

export interface NeverBilledCharge {
  shopDomain: string;
  chargePlatformId: string;
  chargeName: string;
  billingOn: Date;
  listedAmount: number;
  currencyCode: string;
  daysOverdue: number;
}

/**
 * Every currently-active charge `contributionAt` is zeroing to $0 right now
 * because its shop has never paid on any charge for this app and it's more
 * than `NEVER_BILLED_GRACE_MS` past due with still no sale — indistinguishable
 * from event data alone between "a real first invoice is just slow" and "a
 * manual permanent discount that never bills." Read-only: doesn't change what
 * `contributionAt` returns, just makes the population it's zeroing visible so
 * it can be reviewed against Shopify's own Partner Dashboard instead of only
 * ever showing up as a gap in an aggregate.
 */
export async function listNeverBilledPastDueCharges(
  appId: string,
  at: Date = new Date(),
): Promise<NeverBilledCharge[]> {
  const { histories } = await loadPartnerFacts([appId], at);
  const results: NeverBilledCharge[] = [];
  for (const history of histories) {
    const currentEvent = isChargeActive(history, at);
    if (!currentEvent) continue;
    const latestSale = lastAt(history.sales, at);
    if (
      !isNeverBilledPastDue(history, at, currentEvent, latestSale) ||
      history.liveDiscountEffectiveAmount !== null
    ) continue;
    results.push({
      shopDomain: currentEvent.shopDomain,
      chargePlatformId: history.chargePlatformId,
      chargeName: currentEvent.chargeName,
      billingOn: currentEvent.billingOn as Date,
      listedAmount: Number(currentEvent.amount),
      currencyCode: currentEvent.currencyCode,
      daysOverdue: Math.floor(
        (at.getTime() - (currentEvent.billingOn as Date).getTime()) / DAY_MS,
      ),
    });
  }
  return results.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

interface LivePriceCheckCandidate {
  shopDomain: string;
  chargePlatformId: string;
}

/**
 * No sale means neither the event's list price nor a past-due zero establishes
 * the current contract price. Check both, including annual subscriptions,
 * without waiting for the monthly-only stale-activity threshold.
 */
export async function listUnverifiedChargePrices(
  appId: string,
  at: Date = new Date(),
): Promise<LivePriceCheckCandidate[]> {
  const { histories } = await loadPartnerFacts([appId], at);
  return unverifiedChargePricesFromHistories(histories, at);
}

export function unverifiedChargePricesFromHistories(
  histories: ChargeHistory[],
  at: Date,
): LivePriceCheckCandidate[] {
  const results: LivePriceCheckCandidate[] = [];
  for (const history of histories) {
    if (history.liveDiscountEffectiveAmount !== null || lastAt(history.sales, at)) {
      continue;
    }
    const event = isChargeActive(history, at);
    if (event) {
      results.push({
        shopDomain: event.shopDomain,
        chargePlatformId: history.chargePlatformId,
      });
    }
  }
  return results;
}

/**
 * A newly approved native discount may have neither a trial nor a sale yet.
 * Its activation event carries the list price, so none of the trial, stale,
 * or ambiguous-sale selectors can discover its actual recurring price.
 * Use the redemption only to select the exact charge for a Shopify check;
 * the redemption's original price is not a lasting pricing authority.
 */
export async function listNativeDiscountCharges(
  appId: string,
  at: Date = new Date(),
): Promise<LivePriceCheckCandidate[]> {
  const [{ histories }, redemptions] = await Promise.all([
    loadPartnerFacts([appId], at),
    prisma.discountRedemption.findMany({
      where: { appId, status: "APPLIED", shopifySubscriptionId: { not: null } },
      select: { appId: true, shopDomain: true, shopifySubscriptionId: true },
    }),
  ]);
  return nativeDiscountChargesFromHistories(histories, redemptions, at);
}

export function nativeDiscountChargesFromHistories(
  histories: ChargeHistory[],
  redemptions: Array<{
    appId: string;
    shopDomain: string;
    shopifySubscriptionId: string | null;
  }>,
  at: Date,
): LivePriceCheckCandidate[] {
  // Partner charge GIDs and Admin AppSubscription GIDs have different
  // namespaces/type names, but identify the same numeric subscription.
  const key = (appId: string, domain: string, gid: string) =>
    JSON.stringify([appId, domain, gid.split("/").at(-1)]);
  const applied = new Set(
    redemptions.flatMap((row) =>
      row.shopifySubscriptionId
        ? [key(row.appId, row.shopDomain, row.shopifySubscriptionId)]
        : [],
    ),
  );
  const results: LivePriceCheckCandidate[] = [];
  for (const history of histories) {
    const event = isChargeActive(history, at);
    if (
      !event ||
      !applied.has(key(history.appId, event.shopDomain, history.chargePlatformId))
    ) {
      continue;
    }
    results.push({
      shopDomain: event.shopDomain,
      chargePlatformId: history.chargePlatformId,
    });
  }
  return results;
}

export interface AmbiguousDiscountCharge {
  appId: string;
  shopDomain: string;
  chargePlatformId: string;
  chargeName: string;
  listedAmount: number;
  saleAmount: number;
  currencyCode: string;
}

/**
 * Every currently-active charge whose latest sale is below its listed price
 * without a second sale to corroborate it yet — see `ambiguousDiscount`'s
 * doc comment. This is the candidate list `syncLiveDiscountChecksForApp`
 * resolves against Shopify's live `activeSubscription` query; sharing this
 * function with `contributionAt`'s own `ambiguousDiscount` call means "what
 * counts as ambiguous" can never drift between the two.
 */
export async function listAmbiguousDiscountCharges(
  appId: string,
  at: Date = new Date(),
): Promise<AmbiguousDiscountCharge[]> {
  const { histories } = await loadPartnerFacts([appId], at);
  const results: AmbiguousDiscountCharge[] = [];
  for (const history of histories) {
    const currentEvent = isChargeActive(history, at);
    if (!currentEvent) continue;
    const saleIndex = lastIndexAt(history.sales, at);
    const latestSale = saleIndex >= 0 ? history.sales[saleIndex] : undefined;
    const priorSale = saleIndex >= 1 ? history.sales[saleIndex - 1] : undefined;
    if (isNeverBilledPastDue(history, at, currentEvent, latestSale)) continue;
    const ambiguous = ambiguousDiscount(currentEvent, latestSale, priorSale);
    if (!ambiguous) continue;
    results.push({
      appId: history.appId,
      shopDomain: currentEvent.shopDomain,
      chargePlatformId: history.chargePlatformId,
      chargeName: currentEvent.chargeName,
      listedAmount: ambiguous.listedAmount,
      saleAmount: ambiguous.saleAmount,
      currencyCode: latestSale?.currencyCode ?? currentEvent.currencyCode,
    });
  }
  return results;
}

export interface StaleActiveCharge {
  appId: string;
  shopDomain: string;
  chargePlatformId: string;
  chargeName: string;
  listedAmount: number;
  currencyCode: string;
  daysSinceActivity: number;
}

/**
 * Every currently-active, monthly-cadence charge that's gone quiet for
 * longer than a healthy one ever should — no new event or sale in
 * `staleDays`. Confirmed 2026-09-01: this is the population where the
 * subscription-events feed sometimes never receives a terminal event at
 * all (e.g. an uninstall that doesn't produce a matching cancel), so we
 * keep counting a charge Shopify itself has no record of. Deliberately
 * scoped to `EVERY_30_DAYS` charges only — an `ANNUAL` charge legitimately
 * goes quiet for up to a year, so a day-threshold tuned for monthly cadence
 * would misfire constantly on those; not covered by this pass.
 */
export async function listStaleActiveCharges(
  appId: string,
  at: Date = new Date(),
  staleDays: number,
): Promise<StaleActiveCharge[]> {
  const { histories } = await loadPartnerFacts([appId], at);
  const staleMs = staleDays * DAY_MS;
  const results: StaleActiveCharge[] = [];
  for (const history of histories) {
    const currentEvent = isChargeActive(history, at);
    if (!currentEvent) continue;
    if (intervalForCharge(history, at, currentEvent) !== "EVERY_30_DAYS") continue;
    const lastEvent = lastAt(history.events, at);
    const lastSale = lastAt(history.sales, at);
    const lastActivityAt = [lastEvent?.occurredAt, lastSale?.occurredAt]
      .filter((d): d is Date => Boolean(d))
      .reduce((max, d) => (d > max ? d : max));
    const quietMs = at.getTime() - lastActivityAt.getTime();
    if (quietMs < staleMs) continue;
    results.push({
      appId: history.appId,
      shopDomain: currentEvent.shopDomain,
      chargePlatformId: history.chargePlatformId,
      chargeName: currentEvent.chargeName,
      listedAmount: Number(currentEvent.amount),
      currencyCode: currentEvent.currencyCode,
      daysSinceActivity: Math.floor(quietMs / DAY_MS),
    });
  }
  return results.sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);
}

export interface InferredTrialCharge {
  appId: string;
  shopDomain: string;
  chargePlatformId: string;
  chargeName: string;
  listedAmount: number;
  currencyCode: string;
  /** What the heuristic guessed, so a run can be compared against Shopify's answer. */
  inferredTrialEndsAt: Date | null;
}

/**
 * Every charge `contributionAt` is currently calling an ACTIVE TRIAL.
 *
 * The one population in this ledger whose *classification* — not just its amount —
 * is a guess. Shopify exposes no trial object on the subscription-events feed, so
 * `contributionAt` infers a trial from the distance between activation and
 * `billingOn`, gated on the shop having never paid. `activeSubscription.trialEndsAt`
 * is the real answer, and this job is the only thing that can fetch it.
 *
 * The reason this list exists: the other three candidate
 * classes describe charges that are uncertain about PRICE — an ambiguous discount, a
 * charge gone quiet, an override being consumed. Not one of them can select a fresh
 * trial: it has no sale to be ambiguous about, and days-old activity is the opposite
 * of stale. So every inferred trial — the entire Trials band — sat
 * permanently outside the candidate set, and no amount of fixing the job would ever
 * have reached them.
 *
 * Deliberately keyed off `contributionAt` rather than re-deriving the window here, so
 * the candidate set is exactly the population being guessed at. If the heuristic
 * changes, this follows it for free; re-implementing the condition would let the two
 * drift, and the half that drifts is the one nobody re-reads.
 */
export async function listInferredTrialCharges(
  appId: string,
  at: Date = new Date(),
): Promise<InferredTrialCharge[]> {
  const { histories } = await loadPartnerFacts([appId], at);
  const results: InferredTrialCharge[] = [];
  for (const history of histories) {
    const currentEvent = isChargeActive(history, at);
    if (!currentEvent) continue;
    const contribution = contributionAt(history, at);
    if (contribution?.kind !== "trial") continue;
    results.push({
      appId: history.appId,
      shopDomain: currentEvent.shopDomain,
      chargePlatformId: history.chargePlatformId,
      chargeName: currentEvent.chargeName,
      listedAmount: Number(currentEvent.amount),
      currencyCode: currentEvent.currencyCode,
      inferredTrialEndsAt: contribution.trialEndsAt,
    });
  }
  return results;
}

export interface OverriddenActiveCharge {
  appId: string;
  shopDomain: string;
  chargePlatformId: string;
  chargeName: string;
  listedAmount: number;
  overrideAmount: number;
  currencyCode: string;
}

/**
 * Every currently-active charge whose amount is currently being supplied by
 * a persisted live check rather than by event/sale data — i.e. everything
 * `loadLiveDiscountChecks` is feeding to `contributionAt` right now.
 *
 * The other two candidate lists describe charges that are *uncertain today*
 * (ambiguous discount, gone quiet). That was the whole candidate set until
 * 2026-09-09, and it left the job unable to refresh its own output: the
 * moment a charge stopped being uncertain — a corroborating sale arrives, a
 * fresh event lands — it dropped off the candidate list, while its check row
 * stayed in the table and kept overriding the amount forever. A scheduled
 * run reported `checked: 0` against 359 rows last touched a week earlier,
 * every one of them still in use.
 *
 * So: an override stays a candidate for as long as it is consumed. Charges a
 * check has confirmed dead are excluded, because `isChargeActive` reads
 * `liveSubscriptionInactiveSince` — a cancelled subscription is terminal and
 * re-asking Shopify about it forever would just burn API budget.
 */
export async function listOverriddenActiveCharges(
  appId: string,
  at: Date = new Date(),
): Promise<OverriddenActiveCharge[]> {
  // Read the persisted rows directly rather than
  // `history.liveDiscountEffectiveAmount`: that field is already filtered by
  // `LIVE_CHECK_TRUST_MS`, so keying off it would hide an override from the
  // refresher at exactly the moment it went stale — the two halves of this
  // feature would deadlock and no expired override could ever be renewed.
  const [{ histories }, overrides] = await Promise.all([
    loadPartnerFacts([appId], at),
    prisma.partnerChargeLiveDiscountCheck.findMany({
      where: { appId, effectiveAmount: { not: null } },
      select: { chargePlatformId: true, effectiveAmount: true },
    }),
  ]);
  const historyByCharge = new Map(
    histories.map((history) => [history.chargePlatformId, history]),
  );
  const results: OverriddenActiveCharge[] = [];
  for (const override of overrides) {
    const history = historyByCharge.get(override.chargePlatformId);
    if (!history) continue;
    const currentEvent = isChargeActive(history, at);
    if (!currentEvent) continue;
    results.push({
      appId: history.appId,
      shopDomain: currentEvent.shopDomain,
      chargePlatformId: history.chargePlatformId,
      chargeName: currentEvent.chargeName,
      listedAmount: Number(currentEvent.amount),
      overrideAmount: Number(override.effectiveAmount),
      currencyCode: currentEvent.currencyCode,
    });
  }
  return results;
}

/**
 * Clear derived report snapshots after new immutable facts land.
 *
 * `facts:*` is deliberately NOT cleared here (see `factsCacheKey`/
 * `loadPartnerFacts` above) — it's allowed to lag a sync by up to
 * `FACTS_CACHE_MS` so it isn't wiped on every small change the way
 * `recurring:*` (the actual report output) still is.
 */
export async function invalidatePersistedPartnerMrrCache(): Promise<void> {
  await invalidateRedisCachePrefix("recurring:");
}

export interface PartnerLifecycleReadiness {
  coverage: PartnerMrrCoverage;
  appIds: string[];
}

/** The `apps` columns `partnerLifecycleReadiness` needs to reach its verdict. */
export interface AppLifecycleSyncRow {
  id: string;
  billingEventsBackfillCompletedAt: Date | null;
  billingSalesBackfillCompletedAt: Date | null;
}

/**
 * The cheap half of the lifecycle read: answers "can persisted Partner facts
 * serve this report at all?" from rows the caller already fetched. Kept pure
 * and separate from `buildPersistedPartnerAnalytics`'s expensive
 * reconstruction so it can ride along on the `apps` query every metrics
 * request already makes.
 */
export function partnerLifecycleReadiness(
  apps: AppLifecycleSyncRow[],
): PartnerLifecycleReadiness {
  const appIds = apps.map((app) => app.id);
  const eventsComplete =
    apps.length > 0 &&
    apps.every((app) => Boolean(app.billingEventsBackfillCompletedAt));
  const salesComplete =
    apps.length > 0 &&
    apps.every((app) => Boolean(app.billingSalesBackfillCompletedAt));
  const complete = eventsComplete && salesComplete;

  return {
    appIds,
    coverage: {
      provider: "shopify_partner_lifecycle",
      applied: complete && appIds.length > 0,
      complete,
      eventsComplete,
      salesComplete,
      appsReady: apps.filter(
        (app) =>
          app.billingEventsBackfillCompletedAt &&
          app.billingSalesBackfillCompletedAt,
      ).length,
      appsTotal: apps.length,
      notes: complete
        ? [
            "MRR is reconstructed from persisted Shopify subscription lifecycle state.",
            "Partner sale facts supply cadence; calculated MRR is not stored.",
          ]
        : [
            "Lifecycle synchronization is incomplete, so the fast transaction estimate remains active.",
          ],
    },
  };
}

/**
 * The expensive half: rebuilds recurring revenue, revenue, and churn for one
 * window from persisted facts. Only call when `readiness.coverage.applied`.
 * `range` is already quantized by `resolveReportRange`, so repeat loads of
 * the same view within a minute collapse onto one reconstruction.
 */
export async function buildPersistedPartnerAnalytics(params: {
  readiness: PartnerLifecycleReadiness;
  range: ResolvedAnalyticsRange;
}): Promise<PersistedPartnerAnalytics> {
  const { appIds } = params.readiness;
  const { start: periodStart, end: periodEnd, interval, period } = params.range;
  // Sorted for the same reason as `factsCacheKey` — `apps.findMany` has no
  // `orderBy`.
  //
  // Deliberately NOT keyed on a sync watermark (2026-08-16): sync timestamps
  // advance on every tick regardless of new facts, so a watermark-keyed entry
  // would almost never survive to be reused. `periodEnd`'s 5-minute
  // quantization already matches `RECURRING_CACHE_MS`, which is the real
  // freshness bound instead.
  const cacheKey = `recurring:${JSON.stringify({
    appIds: [...appIds].sort(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    interval,
    period,
  })}`;

  return cachedWithRedis(
    cacheKey,
    RECURRING_CACHE_MS,
    async (): Promise<PersistedPartnerAnalytics> => {
      // [DIAG] kept permanently — fallback path for apps not covered by
      // PartnerDailyMrrSnapshot; worth tracking how often/long it runs.
      const factsStartedAt = Date.now();
      const { events, sales, histories } = await loadPartnerFacts(
        appIds,
        periodEnd,
      );
      console.log(
        `[DIAG] loadPartnerFacts appIds=${appIds.length} events=${events.length} sales=${sales.length}: ${Date.now() - factsStartedAt}ms`,
      );
      const recurringStartedAt = Date.now();
      /* Names are only needed to label a plan shared by two apps; a handful of
         rows, inside an already Redis-cached builder. */
      const appNames = new Map(
        (
          await prisma.app.findMany({
            where: { id: { in: appIds } },
            select: { id: true, name: true },
          })
        ).map((app) => [app.id, app.name]),
      );
      const recurring = buildPartnerRecurringFromFacts({
        events,
        sales,
        periodStart,
        periodEnd,
        interval,
        histories,
        appNames,
      });
      /* Folded here so the LIVE/exact path carries movement too. Without it the
         MRR-changes table vanished whenever the page was not snapshot-served —
         which is most of the time in `mode=exact`, and was exactly the reported
         symptom. Costs one extra walk over histories already in memory. */
      recurring.movement = buildMrrMovementFromHistories(
        histories,
        buildUtcBuckets({ start: periodStart, end: periodEnd, interval } as never),
      );
      console.log(
        `[DIAG] buildPartnerRecurringFromFacts interval=${interval} buckets=${recurring.timeSeries.length}: ${Date.now() - recurringStartedAt}ms`,
      );
      const revenueStartedAt = Date.now();
      const revenue = buildPartnerRevenueFromFacts({
        sales,
        period,
        periodStart,
        periodEnd,
        interval,
      });
      console.log(
        `[DIAG] buildPartnerRevenueFromFacts: ${Date.now() - revenueStartedAt}ms`,
      );
      const churnStartedAt = Date.now();
      const churn = buildPartnerChurnFromFacts({
        events,
        sales,
        period,
        periodStart,
        periodEnd,
        interval,
        histories,
      });
      console.log(
        `[DIAG] buildPartnerChurnFromFacts: ${Date.now() - churnStartedAt}ms`,
      );
      return { recurring, revenue, churn };
    },
  );
}

/**
 * Trials-only counterpart to `buildPersistedPartnerAnalytics`, for callers
 * whose `.recurring`/`.revenue` already come from `PartnerDailyMrrSnapshot`
 * and only need `PortfolioReport["trials"]`. Still pays `loadPartnerFacts`'s
 * fixed cost but skips the expensive per-bucket recurring/churn loop, and
 * shares its Redis cache key with sibling `revenue`/`ltv` requests.
 */
/** One day of the forward trial pipeline. */
export interface TrialExpiryPoint {
  /** UTC day the trials in this bucket are due to bill. */
  date: string;
  /** Value still open and expected to convert on that day. */
  activeValue: number;
  /** Value already cancelled that would otherwise have billed that day. */
  lostValue: number;
  activeCount: number;
  lostCount: number;
  /** The two counts above with $0 plans excluded, for "Paid plans only".
   * The value fields need no twin: a free plan contributes 0 to them. */
  activeCountPaid: number;
  lostCountPaid: number;
}

/**
 * Open trials bucketed by WHEN THEY EXPIRE, looking forward from now.
 *
 * This is what Mantle's "Active" trials table actually shows, confirmed by
 * reading it: its rows start TOMORROW and run into the future, and its total
 * equals the "active trials" headline. A backward-looking table of trials
 * STARTED per day can't do either — it answers "what did we take on?" where
 * this answers "what is about to bill, and what have we already lost from
 * it?".
 *
 * Each trial lands in exactly one bucket, so the column sums honestly.
 */
export async function buildTrialExpirySchedule(params: {
  appIds: string[];
  days?: number;
  now?: Date;
}): Promise<TrialExpiryPoint[]> {
  const now = params.now ?? new Date();
  const days = params.days ?? 14;
  if (params.appIds.length === 0) return [];
  const { histories } = await loadPartnerFacts(params.appIds, now);

  const horizon = new Date(now.getTime() + days * DAY_MS);
  const byDay = new Map<string, TrialExpiryPoint>();
  for (const history of histories) {
    const trial = inferredTrialLifecycle(history, now);
    /* Converted trials have left the pipeline: they already billed. Only
       trials whose expiry is still ahead of us are "about to bill". */
    if (!trial || trial.convertedAt) continue;
    if (trial.expiresAt <= now || trial.expiresAt > horizon) continue;
    const date = trial.expiresAt.toISOString().slice(0, 10);
    const point =
      byDay.get(date) ??
      ({
        date,
        activeValue: 0,
        lostValue: 0,
        activeCount: 0,
        lostCount: 0,
        activeCountPaid: 0,
        lostCountPaid: 0,
      } satisfies TrialExpiryPoint);
    const paid = trial.monthlyAmount > 0;
    if (trial.canceledAt) {
      point.lostValue += trial.monthlyAmount;
      point.lostCount += 1;
      if (paid) point.lostCountPaid += 1;
    } else {
      point.activeValue += trial.monthlyAmount;
      point.activeCount += 1;
      if (paid) point.activeCountPaid += 1;
    }
    byDay.set(date, point);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** One merchant's trial, as Mantle's "Trial history" table lists them. */
/**
 * A trial row as the fold produces it, WITHOUT customer or app display names.
 *
 * The names are the fat fields and the only ones needing extra queries, so
 * they are resolved for the page being shown rather than for the whole period
 * — `all_time` is ~41k trials across ~26k distinct shops, which is why the
 * table used to be capped at 200 rows and its search quietly saw only those.
 */
export interface TrialHistoryFact {
  appId: string;
  shopDomain: string;
  planName: string;
  /** Monthly-normalized plan price, so annual and monthly sit on one scale. */
  monthlyAmount: number;
  currency: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  startedAt: string;
  /** When the trial was due to end. */
  expiresAt: string;
  /** When it actually ended early, if the merchant cancelled first — Mantle
   * strikes through the scheduled date and shows this beside it. */
  endedAt: string | null;
  status: "on_trial" | "paying" | "churned_during_trial";
}

/** A `TrialHistoryFact` with identity attached, ready to render. */
export interface TrialHistoryRow extends TrialHistoryFact {
  appName: string;
  appLogoUrl: string | null;
  /** Store name where one is known, else the bare shop. */
  customerName: string;
}

/**
 * Every trial that STARTED in the range, newest first — the row-level list
 * behind the trials charts.
 *
 * Status mirrors what Mantle shows: a trial that converted is `paying`, one
 * cancelled before its expiry is `churned_during_trial`, and one still running
 * is `on_trial`. A trial that simply expired with no sale and no cancellation
 * is the "unresolved" case the report's banner already explains, and is
 * reported as `churned_during_trial` only when there IS cancellation evidence.
 */
export async function buildTrialHistoryFacts(params: {
  appIds: string[];
  range: ResolvedAnalyticsRange;
}): Promise<TrialHistoryFact[]> {
  if (params.appIds.length === 0) return [];
  const { start: periodStart, end: periodEnd } = params.range;
  const { histories } = await loadPartnerFacts(params.appIds, periodEnd);
  const now = new Date();

  const rows: TrialHistoryFact[] = [];
  for (const history of histories) {
    const trial = inferredTrialLifecycle(history, now);
    if (!trial) continue;
    if (trial.startedAt < periodStart || trial.startedAt >= periodEnd) continue;

    const activation = history.events.find(
      (event) =>
        event.type === "SUBSCRIPTION_CHARGE_ACTIVATED" && event.test === false,
    );
    if (!activation) continue;

    rows.push({
      appId: history.appId,
      shopDomain: activation.shopDomain,
      planName: activation.chargeName,
      monthlyAmount: trial.monthlyAmount,
      currency: activation.currencyCode,
      interval: intervalForCharge(history, now, activation),
      startedAt: trial.startedAt.toISOString(),
      expiresAt: trial.expiresAt.toISOString(),
      endedAt: trial.canceledAt ? trial.canceledAt.toISOString() : null,
      status: trial.canceledAt
        ? "churned_during_trial"
        : trial.convertedAt
          ? "paying"
          : "on_trial",
    });
  }

  rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return rows;
}

/**
 * Attaches customer and app identity to the rows about to be rendered.
 *
 * Deliberately separate from the fold: it runs on ONE page, so the period's
 * whole trial list can be held and searched without resolving ~26k store
 * names to show 25 of them.
 */
export async function hydrateTrialHistory(
  facts: TrialHistoryFact[],
): Promise<TrialHistoryRow[]> {
  if (facts.length === 0) return [];
  const [names, apps] = await Promise.all([
    resolveCustomerNames(facts.map((row) => row.shopDomain)),
    prisma.app.findMany({
      where: { id: { in: [...new Set(facts.map((row) => row.appId))] } },
      select: { id: true, name: true, logoUrl: true },
    }) as Promise<Array<{ id: string; name: string; logoUrl: string | null }>>,
  ]);
  const appById = new Map(apps.map((app) => [app.id, app]));

  return facts.map((row) => ({
    ...row,
    appName: appById.get(row.appId)?.name ?? "Unknown app",
    appLogoUrl: appById.get(row.appId)?.logoUrl ?? null,
    customerName:
      names.get(row.shopDomain) ??
      row.shopDomain.replace(/\.myshopify\.com$/, ""),
  }));
}

export async function buildPartnerTrialsForRange(params: {
  appIds: string[];
  range: ResolvedAnalyticsRange;
}): Promise<PortfolioReport["trials"]> {
  const { appIds } = params;
  const { start: periodStart, end: periodEnd, interval } = params.range;
  const { histories } = await loadPartnerFacts(appIds, periodEnd);
  const buckets = buildUtcBuckets({ start: periodStart, end: periodEnd, interval });
  const currentAt = new Date(Math.max(periodStart.getTime(), periodEnd.getTime() - 1));
  return buildPartnerTrialsFromFacts({ histories, periodStart, periodEnd, buckets, currentAt });
}

/**
 * Overlay reconstructed recurring revenue and trials onto a locally computed
 * portfolio (installs/funnel/retention/usage still come from the local
 * mirror). Only reads `analytics.recurring`, narrowed to `Pick` so callers
 * with no `.revenue`/`.churn` don't have to fabricate them.
 */
export function mergePartnerAnalyticsIntoPortfolio(
  portfolio: PortfolioReport,
  /* `movement` only ever arrives from the snapshot path; the live
     reconstruction has no equivalent, hence optional rather than required. */
  analytics: {
    recurring: PersistedPartnerAnalytics["recurring"] & {
      movement?: MrrMovementSummary[];
      planSeries?: PlanMrrSeries[];
    };
  },
): PortfolioReport {
  const { recurring } = analytics;
  return {
    ...portfolio,
    recurring: {
      currencies: recurring.currencies,
      timeSeries: recurring.timeSeries,
      movement: recurring.movement,
      planSeries: recurring.planSeries,
    },
    trials: recurring.trials,
    sourceCoverage: {
      ...portfolio.sourceCoverage,
      subscriptions: recurring.currencies.reduce(
        (sum, currency) => sum + currency.activeSubscriptions,
        0,
      ),
      notes: [
        ...portfolio.sourceCoverage.notes,
        "Recurring revenue uses persisted Shopify lifecycle facts.",
      ],
    },
  };
}

/* ---------------------------------------------------------------------------
 * MRR movement — the seven-category decomposition.
 *
 * Lives here rather than in `partner-mrr-snapshot.server.ts` (where it was
 * built) because BOTH report paths need it: the snapshot path reads the
 * persisted columns, and the live/exact path has to fold it from facts. The
 * snapshot module imports this one, so the fold could not stay there without a
 * cycle — and it never needed anything from there, only `contributionAt`,
 * `isReplacementCancellation` and `ChargeHistory`, all defined above.
 * ------------------------------------------------------------------------- */

/**
 * Plan changes inside this window of a shop's FIRST activation are booked as
 * `new` rather than expansion or contraction.
 *
 * The analytics spec's "first-period recategorization", default on, and Mantle
 * evidently runs it too: roughly half of all plan changes fall inside this
 * window, which is why Mantle's expansion figure is a fraction of the raw pair total. Early plan-shopping is
 * a merchant settling on a plan, not a business expanding.
 */
const FIRST_PERIOD_MS = 30 * DAY_MS;

/**
 * The instant each shop FIRST had a paid contribution, across all its charges.
 *
 * New-versus-reactivation is a shop-level question and cannot be answered from
 * one charge's history. Shopify issues a NEW charge id when a merchant
 * resubscribes, so the returning charge's own history shows a first-ever
 * contribution and books as `new` — which is why reactivation measured exactly
 * $0.00 before this existed, with the missing amount hiding inside `new`.
 *
 * Deliberately keyed on the first PAID contribution rather than on
 * `earliestActivationByShop`: a shop whose first activation was a trial has
 * activated without ever having paid, and calling its first real subscription a
 * reactivation would be wrong. So this re-derives through `contributionAt` with
 * the same `kind !== "trial"` gate the walks use, rather than trusting the
 * event type.
 *
 * Shopify has no subscription-reactivation event to read instead — the
 * customer-events spec is explicit that `RELATIONSHIP_REACTIVATED` is
 * account-level and "does not move MRR". Mantle derives this the same way.
 */
export function buildFirstPaidContributionIndex(
  histories: ChargeHistory[],
): Map<string, Date> {
  const firstPaidByShop = new Map<string, Date>();
  const record = (appId: string, shopDomain: string, at: Date) => {
    const key = `${appId}\u001f${shopDomain}`;
    const known = firstPaidByShop.get(key);
    if (!known || at < known) firstPaidByShop.set(key, at);
  };
  for (const history of histories) {
    for (const event of history.events) {
      const contribution = contributionAt(history, event.occurredAt);
      if (!contribution) continue;
      if (contribution.kind !== "trial") {
        record(history.appId, event.shopDomain, event.occurredAt);
        // The charge's own first paid instant is enough; later ones cannot be
        // earlier, so the rest of this history's events add nothing.
        break;
      }
      /* A trial charge has no paid EVENT — it starts paying when the clock
         passes `billingOn`, which emits nothing (see `mrrMovementForShop`'s
         sampling note). Reading only event instants meant a shop whose first
         subscription was a converted trial had no first-paid instant recorded
         at all, so a later charge of theirs read as `new` rather than
         `reactivation`. The conversion instant is that shop's first paid
         moment, so it counts — but only once it has actually passed, which the
         caller decides by bucketing. */
      if (contribution.trialEndsAt) {
        record(history.appId, event.shopDomain, contribution.trialEndsAt);
      }
    }
  }
  return firstPaidByShop;
}

export const MRR_MOVEMENT_KINDS = [
  "new",
  "reactivation",
  "expansion",
  "contraction",
  "churn",
  "frozen",
  "unfrozen",
] as const;
export type MrrMovementKind = (typeof MRR_MOVEMENT_KINDS)[number];

export interface MrrMovementDelta {
  at: Date;
  kind: MrrMovementKind;
  currency: string;
  /**
   * Always POSITIVE. `churn`, `contraction` and `frozen` are losses; the reader
   * applies the sign. A figure that has to be read twice to know which way it
   * points is how sign errors get into money reporting.
   */
  amount: number;
  /** A plan change booked as `new` by the first-period rule above. */
  earlyPlanChange?: true;
  /**
   * The plan this movement belongs to, as the charge named it.
   *
   * Descriptive, like `fromTrialConversion`: no amount, kind or timestamp
   * depends on it, and every existing reader ignores it. It exists so a
   * per-plan breakdown can be COUNTED off the same fold that books the money,
   * rather than from a second walk over the events that would have to
   * re-derive plan-change suppression and disagree the first time one of them
   * changed.
   *
   * For a loss it names the plan being LEFT, not the one arriving — which is
   * the only reading under which a plan's gains and losses both refer to it.
   */
  plan?: string;
  /**
   * This delta was booked at a DERIVED trial-conversion instant rather than at
   * a Shopify event — the clock passed `billingOn` and the charge started
   * counting (see the sampling-point note in `mrrMovementForShop`).
   *
   * Purely descriptive: it changes no amount, kind or timestamp, and every
   * existing reader ignores it. It exists because the fold is the only place
   * that knows a conversion happened — Shopify emits nothing — so reporting
   * "Trial Converted" anywhere else would mean duplicating this logic.
   */
  fromTrialConversion?: true;
}

/**
 * One SHOP's MRR movement, decomposed into Mantle's seven categories.
 *
 * Per shop with ONE running amount, and that scalar is the whole point. The
 * customer-events spec models a single active subscription per install (§3.2):
 * `currentAmount` is a figure an activation REPLACES, never a sum over
 * concurrent charges. So an activation arriving while the install is already
 * paying is a plan change worth `contribution - currentAmount`, and the
 * superseded charge's own cancel later moves nothing — the replacement already
 * accounted for it.
 *
 * `partnerdex/src/sync/events.ts` (case `SUBSCRIPTION_CHARGE_ACTIVATED`) is the
 * reference implementation of exactly this fold, down to the `applies` guard on
 * the loss side. Two consequences of it are worth naming, because both look
 * like bugs until you see why they are not:
 *
 *   - **Order-independence.** Booking the delta on the activation side means a
 *     plan-change pair lands correctly whichever half is seen first. Cancel
 *     first: it is suppressed and leaves `currentAmount` alone for the
 *     activation to difference against. Activation first: it replaces
 *     `currentAmount`, so the cancel that follows is no longer the current
 *     charge and moves nothing. This replaced an explicit same-instant
 *     tie-break — most plan-change pairs share a timestamp —
 *     with a fold that does not need one.
 *
 *   - **This ledger is deliberately NOT the churn report.** A charge superseded
 *     by a replacement still cancels for real later, and the per-charge churn
 *     stream counts that as lost while this walk books nothing for it. That gap
 *     is intended: partnerdex's own README states it ("a movement view and a
 *     level are two different readings of the same facts"). Crucially,
 *     `churnedRevenueLost` is computed by `subscriptionChurnTransitions`, NOT by
 *     this function, so the published churn number cannot be moved from here.
 *
 * Deltas are bucketed by the SIGN OF THE MONEY, where partnerdex buckets by the
 * plan's list price and lets a negative land in its Upgraded column. The two
 * agree except on a plan change taken mid-trial, and a `ChargeContribution`
 * carries what is earned rather than what is listed, so the sign is the reading
 * this data actually supports. Net is identical either way.
 */
export function mrrMovementForShop(
  histories: ChargeHistory[],
  evidence: ChurnEvidenceIndex,
  /** From `buildFirstPaidContributionIndex` — whether this shop paid before. */
  firstPaidByShop?: Map<string, Date>,
): MrrMovementDelta[] {
  /* Sampling points, not events. `contributionAt` is what decides whether a
     charge is paying, and it changes its answer on two kinds of occasion: an
     event arriving, and the CLOCK passing a threshold. A trial ending is the
     second kind — Shopify emits nothing when `billingOn` arrives — so a walk
     over events alone can only notice it if some LATER event happens to
     re-sample that charge.

     For most charges no later event ever comes: the trial converts and the
     subscription simply bills, and billing lands in `sales`, not `events`. So
     the conversion stayed invisible forever, and when the charge eventually
     cancelled, `wasPaying` was still false and no churn was booked either.
     Both halves went missing together, which is why the all-time invariant
     still reconciled closely and hid this completely: trial conversions were
     booked as nothing at all, a steady daily undercount that added up to a
     large error across a 30-day window.

     So the conversion instant is added as its own sampling point. partnerdex
     merges a synthetic `trial_converted` into its stream for exactly this
     reason; this is the same idea with the timestamp derived rather than
     delivered. */
  const merged: Array<{
    history: ChargeHistory;
    event: EventFact;
    at: Date;
    /**
     * Absent for a real Shopify event. The two derived kinds are NOT
     * interchangeable, and treating them as one flag was a real bug: a
     * revaluation was being skipped by the trial guard below.
     *
     *  - `trial-conversion`: the clock passed `billingOn`. Read the value from
     *    one millisecond EARLIER (see the note below).
     *  - `revalue`: a sale settled and changed what the charge is worth.
     *    Read the value at the instant itself, like a real event.
     */
    reason?: "trial-conversion" | "revalue";
  }> = [];
  for (const history of histories) {
    const conversions = new Set<number>();
    for (const event of history.events) {
      merged.push({ history, event, at: event.occurredAt });
      /* `trialEndsAt` is only legible from INSIDE the trial — it is derived
         from `billingOn > at`, so once the date passes, `contributionAt` stops
         reporting it. Every event during the trial reports the same instant,
         hence the dedupe. */
      const trialEndsAt = contributionAt(history, event.occurredAt)?.trialEndsAt;
      if (!trialEndsAt || conversions.has(trialEndsAt.getTime())) continue;
      conversions.add(trialEndsAt.getTime());
      merged.push({ history, event, at: trialEndsAt, reason: "trial-conversion" });
    }
    /* Sales are sampling points too, and for the same reason. A charge's
       CADENCE is not knowable at activation — an annual plan announces itself
       only when its first payment settles with `billingInterval: ANNUAL`, and
       until then the heuristic reads it as monthly. So the level re-values the
       charge from $239.88 to $19.99 the moment that sale lands, with no event
       anywhere — over-booking by a ratio of exactly twelve. */
    const revalued = new Set<number>();
    for (const sale of history.sales) {
      const at = sale.occurredAt;
      if (revalued.has(at.getTime())) continue;
      revalued.add(at.getTime());
      const anchor = history.events[0];
      if (anchor) merged.push({ history, event: anchor, at, reason: "revalue" });
    }
  }
  merged.sort((left, right) => {
    const byTime = left.at.getTime() - right.at.getTime();
    if (byTime !== 0) return byTime;
    /* A conversion landing on the same instant as a real event is processed
       first, so a trial that ends and is cancelled in the same breath books
       the entry and then the churn — net zero, which is what the MRR level
       does — rather than silently booking neither. */
    return Number(Boolean(right.reason)) - Number(Boolean(left.reason));
  });

  const deltas: MrrMovementDelta[] = [];
  /**
   * Which charges read as paying, tracked per charge only to spot the
   * transitions — a trial converting fires no event of its own, so it is
   * visible as `contributionAt` changing its answer between two other events
   * and nowhere else. partnerdex merges a synthetic `trial_converted` into its
   * stream instead; we detect it.
   */
  const paying = new Set<ChargeHistory>();
  /** The one charge the ledger currently books money for, and its value. */
  let currentHistory: ChargeHistory | null = null;
  let currentAmount = 0;
  let currentCurrency = "";
  /* Tracked beside `currentAmount` for one reason: at a churn the contribution
     in hand is gone, so the plan being lost can only come from what the ledger
     was booking a moment ago. */
  let currentPlan = "";
  let everPaid = false;

  /** Set per iteration below, read by `push`, so the derived-conversion tag
   * lands on whichever delta that iteration books without threading a flag
   * through all nine call sites. */
  let convertingNow = false;
  /** The plan the next `push` should be attributed to. Set per booking rather
   * than threaded through all nine call sites, exactly like `convertingNow`. */
  let planNow = "";
  const push = (
    at: Date,
    kind: MrrMovementKind,
    currency: string,
    amount: number,
    early?: true,
  ) => {
    if (amount <= 0) return;
    deltas.push({
      at,
      kind,
      currency,
      amount,
      ...(early ? { earlyPlanChange: early } : {}),
      ...(convertingNow ? { fromTrialConversion: true as const } : {}),
      ...(planNow ? { plan: planNow } : {}),
    });
  };

  const shopKey = (history: ChargeHistory, event: EventFact) =>
    `${history.appId}\u001f${event.shopDomain}`;

  for (const { history, event, at, reason } of merged) {
    /* A synthetic sample sits exactly ON `billingOn` — and the cadence
       heuristic infers "annual" from how FAR AWAY `billingOn` is, so at that
       instant the distance is zero, an annual charge reads as monthly, and
       `contributionAt` hands back twelve times its real MRR. There is no sale
       yet to pin the cadence either; that only arrives with the first payment.
       Before this guard: $479.88 booked for a charge the level carries at
       $39.99, on every such shop.
       
       The trial's own contribution, one millisecond earlier, already carries
       the correct monthly-normalized value — converting changes whether it
       counts, not what it is worth. So the value is read from there, and the
       conversion instant is used only as the booking timestamp. */
    const converting = reason === "trial-conversion";
    convertingNow = converting;
    const contribution = converting
      ? contributionAt(history, new Date(at.getTime() - 1))
      : contributionAt(history, at);
    /* Gains and revaluations belong to the plan in hand. The one exception is
       a loss, which is re-pointed at `currentPlan` on that branch below. */
    planNow = contribution?.planName.trim() ?? "";
    /* Only a charge that really was still trialling converts here. Anything
       else — already paying, or already gone — must fall through untouched, or
       the sample would read as a transition to not-paying and book a phantom
       churn. */
    if (converting && contribution?.kind !== "trial") continue;
    const nowPaying = converting
      ? true
      : Boolean(contribution && contribution.kind !== "trial");
    const wasPaying = paying.has(history);
    if (nowPaying === wasPaying) {
      /* Same charge, still paying, but worth something different — a cadence
         finally revealed by a sale, or a discount resolving. The MRR level
         follows that immediately; without booking it the ledger drifts from
         the level permanently, since nothing later ever revisits it. */
      if (
        nowPaying &&
        history === currentHistory &&
        contribution &&
        Math.abs(contribution.amount - currentAmount) > 0.005
      ) {
        const delta = contribution.amount - currentAmount;
        currentAmount = contribution.amount;
        currentCurrency = contribution.currency;
        currentPlan = planNow;
        push(
          at,
          delta > 0 ? "expansion" : "contraction",
          contribution.currency,
          Math.abs(delta),
        );
      }
      continue;
    }

    if (nowPaying) {
      paying.add(history);
      const amount = contribution!.amount;
      const currency = contribution!.currency;
      // Already the charge being booked, at a real value: a freeze is the only
      // way to be current and worth nothing, and that is the branch below.
      if (history === currentHistory && currentAmount > 0) continue;

      const before = currentAmount;
      currentHistory = history;
      currentAmount = amount;
      currentCurrency = currency;
      currentPlan = planNow;
      everPaid = true;

      if (!reason && event.type === "SUBSCRIPTION_CHARGE_UNFROZEN") {
        // Restores only what the freeze actually took: a subscription frozen
        // while still trialling was contributing nothing.
        push(at, "unfrozen", currency, amount - before);
        continue;
      }

      if (before > 0) {
        // Already paying, and this is a different charge: Shopify models a plan
        // change as a new subscription, so this is the visible half of one.
        const delta = amount - before;
        const firstPaid = firstPaidByShop?.get(shopKey(history, event));
        const early =
          firstPaid !== undefined &&
          at.getTime() - firstPaid.getTime() < FIRST_PERIOD_MS;
        if (early) {
          push(at, "new", currency, Math.abs(delta), true);
        } else if (delta >= 0) {
          // `>=` is expansion (spec §3.2), so an equal-price swap emits nothing
          // rather than reading as a loss.
          push(at, "expansion", currency, delta);
        } else {
          push(at, "contraction", currency, -delta);
        }
        continue;
      }

      /* The shop was not paying, so this is an entry. Shop-level, because
         Shopify issues a new charge id on resubscribe and the returning
         charge's own history looks first-ever. Shopify has no
         subscription-reactivation event to read instead — the spec is explicit
         that RELATIONSHIP_REACTIVATED is account-level and "does not move
         MRR". */
      const firstPaid = firstPaidByShop?.get(shopKey(history, event));
      const returning =
        firstPaid !== undefined
          ? firstPaid.getTime() < at.getTime()
          : everPaid;
      push(
        at,
        returning ? "reactivation" : "new",
        currency,
        amount,
      );
      continue;
    }

    paying.delete(history);
    const frozen = !reason && event.type === "SUBSCRIPTION_CHARGE_FROZEN";
    /* partnerdex carries its `applies` guard on the CANCEL branch only, and the
       asymmetry is deliberate rather than an oversight. A cancel on a charge
       that is no longer the one being booked was already accounted for by the
       replacement that superseded it, so it moves no money. A FREEZE is the
       INSTALL stopping billing — its branch there books `-currentAmount`
       unconditionally — so it books whatever the install was earning, whichever
       charge id the event happens to name. Guarding freezes as well left most
       of `frozen` unbooked, the largest single category gap against Mantle. */
    if (!frozen && history !== currentHistory) continue;

    if (
      !reason &&
      event.type === "SUBSCRIPTION_CHARGE_CANCELED" &&
      isReplacementCancellation(history, evidence, at)
    ) {
      // Suppressed as plan-change noise: `currentAmount` is deliberately left
      // standing for the replacing activation to difference against. That
      // activation is guaranteed to exist — it is what made this a replacement.
      continue;
    }

    const amount = currentAmount;
    const currency = currentCurrency;
    /* A cancel's own event can name a different plan (Shopify models a plan
       change as a new charge), and a freeze carries no plan at all. What is
       being lost is what the ledger was booking. */
    planNow = currentPlan;
    /* A freeze does not end the subscription, so whatever was current stays
       current at zero: an unfreeze then restores it instead of reading as a new
       entry, and because `subscription_frozen` is one of partnerdex's
       NON_PAYING_STATES, an ACTIVATION arriving next is a full-value entry
       rather than a plan-change delta. */
    if (!frozen) {
      currentHistory = null;
      currentCurrency = "";
      currentPlan = "";
    }
    currentAmount = 0;
    push(at, frozen ? "frozen" : "churn", currency, amount);
  }

  return deltas;
}

/**
 * The five subscription-lifecycle funnel events Shopify never sends us.
 *
 * The Partner API's subscription feed carries exactly six event types —
 * ACTIVATED, CANCELED, EXPIRED, FROZEN, DECLINED, UNFROZEN (verified against
 * live data: those six and nothing else). There is no
 * trial event, and an activation does not say whether it raised or lowered
 * what the merchant pays. So every one of these has to be DERIVED from how a
 * charge's value changes over time — which is precisely what
 * `mrrMovementForShop` already does, and got reconciled against Mantle to do.
 *
 * Hence this reads that fold rather than re-deriving anything: `expansion`,
 * `contraction` and the trial-conversion tag are the same transitions, just
 * counted as events instead of summed as money. Only `trial_started` needs its
 * own look, because a trial starting moves no money (a trial contributes to
 * the MRR level but never counts as paying) and so books no delta.
 */
export type DerivedFunnelKind =
  | "trial_started"
  | "trial_converted"
  | "upgraded"
  | "downgraded"
  | "resubscribed";

export interface DerivedFunnelEvent {
  kind: DerivedFunnelKind;
  shopDomain: string;
  at: Date;
}

/** `expansion` is a plan getting more expensive and `contraction` less, which
 * is what upgraded/downgraded mean. Deliberately NOT mapping `new`/`churn`:
 * those are Subscribed/Unsubscribed, which come straight off the Partner feed
 * and are already reported from there. */
const FUNNEL_KIND_BY_MOVEMENT: Partial<Record<MrrMovementKind, DerivedFunnelKind>> =
  {
    expansion: "upgraded",
    contraction: "downgraded",
    reactivation: "resubscribed",
  };

/**
 * ONE shop's derived lifecycle events, in no particular order.
 *
 * Takes the same three arguments as `mrrMovementForShop` and must be given the
 * same complete per-shop history: the fold is stateful per shop (whether a
 * charge reads as an upgrade depends on what the shop was already paying, and
 * `firstPaidByShop` decides reactivation-vs-new), so passing a subset of a
 * shop's charges does not narrow the answer, it changes it.
 */
export function derivedFunnelEventsForShop(
  histories: ChargeHistory[],
  evidence: ChurnEvidenceIndex,
  firstPaidByShop?: Map<string, Date>,
): DerivedFunnelEvent[] {
  const shopDomain = histories[0]?.events[0]?.shopDomain;
  if (!shopDomain) return [];

  const events: DerivedFunnelEvent[] = [];

  for (const delta of mrrMovementForShop(histories, evidence, firstPaidByShop)) {
    if (delta.fromTrialConversion) {
      /* The conversion is the event, whatever money it happened to book. A
         converting trial reads as `new` for a first-time shop, `reactivation`
         for a returning one, and `expansion` when the shop was already paying
         for a different charge — reporting it by `kind` would scatter one
         real-world occurrence across three funnel events. */
      events.push({ kind: "trial_converted", shopDomain, at: delta.at });
      continue;
    }
    const kind = FUNNEL_KIND_BY_MOVEMENT[delta.kind];
    if (kind) events.push({ kind, shopDomain, at: delta.at });
  }

  for (const history of histories) {
    /* One trial per charge, at its earliest activation. A plan change during a
       trial fires another ACTIVATED whose contribution is still trialling, and
       counting that as a second trial start would inflate the funnel above the
       number of subscriptions that ever existed. */
    for (const event of history.events) {
      if (!eventActivates(event.type)) continue;
      const contribution = contributionAt(history, event.occurredAt);
      if (contribution?.kind !== "trial") continue;
      events.push({
        kind: "trial_started",
        shopDomain,
        at: event.occurredAt,
      });
      break;
    }
  }

  return events;
}

/**
 * Folds a set of histories into per-bucket movement figures, per currency.
 *
 * The LIVE/exact report path's entry point. The snapshot path reads the
 * persisted columns instead, but both end up in the same
 * `MrrMovementSummary[]` shape so the panel has one thing to render — and
 * because both ultimately run `mrrMovementForShop`, the two can only differ by
 * the day boundary the snapshot rounds to, never by classification.
 *
 * Grouped by shop before folding: an activation arriving while the SHOP is
 * already paying is a plan change, and a per-charge walk cannot see that.
 */
export function buildMrrMovementFromHistories(
  histories: ChargeHistory[],
  buckets: ReadonlyArray<{ start: Date; end: Date }>,
): MrrMovementSummary[] {
  if (buckets.length === 0) return [];
  const evidence = buildChurnEvidenceIndex(histories);
  /* Built from ALL histories, not just those live in range: a shop's earlier
     paid subscription can sit on a long-dead charge, and that is exactly the
     charge that makes today's activation a reactivation rather than new. */
  const firstPaidByShop = buildFirstPaidContributionIndex(histories);

  /* Walked over EVERY history, never a set pruned to the range, and the
     snapshot's movement loop does the same.
     
     The fold is stateful — whether an activation is an entry or a plan change
     depends on what the shop was paying beforehand — so pruning by range makes
     the ANSWER depend on the window you asked for. Pruning at the range start
     instead moved figures between churn and expansion versus the snapshot, which had been built over the app's full
     history. Deltas are filtered to the range after the fold, where filtering
     is safe. */
  const byShop = new Map<string, ChargeHistory[]>();
  for (const history of histories) {
    const shop = history.events[0]?.shopDomain;
    if (!shop) continue;
    const key = `${history.appId}\u001f${shop}`;
    const group = byShop.get(key);
    if (group) group.push(history);
    else byShop.set(key, [history]);
  }

  const rangeStart = buckets[0]!.start.getTime();
  const rangeEnd = buckets[buckets.length - 1]!.end.getTime();
  const byCurrency = new Map<string, MrrMovementSummary>();

  const blank = (): MrrMovementBucket => ({ ...EMPTY_MRR_MOVEMENT_BUCKET });
  const ensure = (currency: string): MrrMovementSummary => {
    const existing = byCurrency.get(currency);
    if (existing) return existing;
    const created: MrrMovementSummary = {
      currency,
      buckets: buckets.map((bucket) => ({
        periodStart: bucket.start.toISOString(),
        periodEnd: bucket.end.toISOString(),
        ...blank(),
      })),
      total: blank(),
    };
    byCurrency.set(currency, created);
    return created;
  };

  for (const group of byShop.values()) {
    for (const delta of mrrMovementForShop(group, evidence, firstPaidByShop)) {
      const at = delta.at.getTime();
      if (at < rangeStart || at >= rangeEnd) continue;
      // Linear scan would be O(deltas x buckets); ranges run to 60+ buckets
      // and an app can have tens of thousands of deltas, so bisect instead.
      let low = 0;
      let high = buckets.length - 1;
      let index = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const bucket = buckets[mid]!;
        if (at < bucket.start.getTime()) high = mid - 1;
        else if (at >= bucket.end.getTime()) low = mid + 1;
        else {
          index = mid;
          break;
        }
      }
      if (index === -1) continue;
      const summary = ensure(delta.currency);
      const cell = summary.buckets[index]!;
      cell[delta.kind] += delta.amount;
      summary.total[delta.kind] += delta.amount;
      if (delta.earlyPlanChange) {
        // In ADDITION to the `new` it was booked as, never instead: the
        // waterfall still has to sum to the MRR change.
        cell.earlyPlanChange += delta.amount;
        summary.total.earlyPlanChange += delta.amount;
      }
    }
  }

  for (const summary of byCurrency.values()) {
    for (const cell of summary.buckets) cell.net = round(mrrMovementNet(cell));
    summary.total.net = round(mrrMovementNet(summary.total));
  }
  return [...byCurrency.values()].sort(
    (left, right) => right.total.net - left.total.net,
  );
}

/**
 * A charge's plan, resolvable whether or not it is still alive.
 *
 * `contributionAt` answers this for ACTIVE charges only — it returns null the
 * moment a charge dies, which is right for MRR and wrong for anything
 * lifetime. This reads the same identity off the last activating event
 * instead, so a churned merchant's revenue still lands on the plan they were
 * paying for.
 */
function planIdentityForCharge(history: ChargeHistory): {
  plan: string;
  amount: number;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  currency: string;
} | null {
  let event: EventFact | undefined;
  for (let index = history.events.length - 1; index >= 0; index--) {
    const candidate = history.events[index]!;
    if (candidate.type === "SUBSCRIPTION_CHARGE_ACTIVATED" && candidate.chargeName) {
      event = candidate;
      break;
    }
  }
  if (!event || event.test) return null;
  const plan = event.chargeName.trim();
  if (!plan) return null;

  const at = history.lastEventAt ?? event.occurredAt;
  /* `event.amount` is already what the merchant is billed per cycle — the
     annual price for an annual charge — so it needs no scaling here, unlike
     `contribution.planListedAmount`, which is monthly-normalized. */
  return {
    plan,
    amount: round(Number(event.amount)),
    interval: intervalForCharge(history, at, event),
    currency: event.currencyCode,
  };
}

/** One day's gains and losses for a single plan. */
export interface PlanFlowPoint {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  plan: string;
  added: number;
  lost: number;
}

/**
 * Per-day, per-plan subscription gains and losses — Mantle's "New and lost
 * subscriptions by plan".
 *
 * COUNTED OFF THE MOVEMENT FOLD, not off the raw events, and that is the whole
 * point. Shopify models a plan change as a cancel plus a new charge, so
 * counting `SUBSCRIPTION_CHARGE_ACTIVATED` and `CANCELED` directly would report
 * every upgrade as one subscription lost and one gained — inventing churn for a
 * merchant who never left. The fold already suppresses that
 * (`isReplacementCancellation`) and now tags each delta with its plan, so this
 * chart and the MRR figures above it can only ever tell the same story.
 *
 * Which kinds count, per spec 4.6 / 7.8 ("per bucket = adds - removes"):
 *   - `new` and `reactivation` are adds: a shop that was not paying now is.
 *   - `churn` is a removal.
 *   - `expansion`/`contraction` are NEITHER. The subscription continues, at a
 *     different price; counting them would double the population.
 *   - `frozen`/`unfrozen` are NEITHER. A freeze is a payment failure rather
 *     than a decision to leave, and it reverses.
 */
export async function buildPlanSubscriptionFlow(params: {
  appId: string;
  start: Date;
  end: Date;
}): Promise<PlanFlowPoint[]> {
  const { appId, start, end } = params;

  /* Reads the SHARED facts cache rather than running its own narrowed load.
     This used to select the shops active in the window (three queries), load
     those shops completely (two more), then rebuild histories, cadence pins
     and live-discount checks from scratch — about a second per request, all
     of it work `loadPartnerFacts` had usually just done and cached for the
     trials and recurring builders on the same page.

     Narrowing is not cheaper here anyway: the fold is stateful per shop, so
     every selected shop has to be loaded COMPLETELY regardless, and the shop
     set for a busy app's 30-day window is most of the app. Sharing the one
     cached load makes this effectively free whenever anything else on the
     request needs facts, which on the dashboard is always. */
  const { histories } = await loadPartnerFacts([appId], end);

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

  const SEP = String.fromCharCode(31);
  const cells = new Map<string, PlanFlowPoint>();
  for (const group of byShop.values()) {
    for (const delta of mrrMovementForShop(group, evidence, firstPaid)) {
      if (delta.at < start || delta.at >= end) continue;
      const isAdd = delta.kind === "new" || delta.kind === "reactivation";
      const isLoss = delta.kind === "churn";
      if (!isAdd && !isLoss) continue;

      const day = delta.at.toISOString().slice(0, 10);
      /* A delta the fold could not attribute still belongs in the totals —
         bucketing it under a visible label beats dropping it silently. */
      const plan = delta.plan?.trim() || "Unknown plan";
      const key = day + SEP + plan;
      const cell = cells.get(key) ?? { day, plan, added: 0, lost: 0 };
      if (isAdd) cell.added += 1;
      else cell.lost += 1;
      cells.set(key, cell);
    }
  }

  return [...cells.values()].sort(
    (left, right) =>
      left.day.localeCompare(right.day) || left.plan.localeCompare(right.plan),
  );
}

/** One plan as the Partner charge data reveals it, with today's economics. */
export interface ObservedPlan {
  /** The charge name Shopify reports. */
  plan: string;
  currency: string;
  /** Billed price — the annual figure for an annual plan, not a twelfth. */
  amount: number;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  /** MRR from merchants past their trial. Annual plans count a twelfth. */
  mrr: number;
  /** Merchants paying on this plan. */
  customers: number;
  /** Merchants on this plan still inside a trial, so not yet in `mrr`. */
  trials: number;
  /**
   * Everything ever settled on every charge that was EVER on this plan —
   * including merchants who have since churned or moved to another tier.
   *
   * Counting only today's subscribers was measured wrong: most of what a
   * long-lived plan ever earned was paid by merchants no longer on it. A lifetime figure that
   * forgets everyone who left is not a lifetime figure.
   *
   * Still attributed to the plan a charge ENDED on rather than split across
   * the tiers it passed through: a merchant who spent a year on Starter before
   * upgrading brings that year with them to Pro. Splitting properly means
   * replaying each charge's plan history against its sale dates, which is a
   * different question — "what did this plan earn" rather than "what is this
   * plan worth" — and Mantle's own figure behaves this way too.
   */
  lifetimeValue: number;
}

/** A single merchant on a plan, for the plan's subscriber list. */
export interface ObservedPlanSubscriber {
  shopDomain: string;
  /**
   * AMR — average monthly revenue: `lifetimeValue / months billed`.
   *
   * NOT what they pay today. Reverse-engineered from Mantle's own Starter
   * list, where every single AMR divides its CLV to an exact integer (16.00,
   * 13.00, 25.00, 7.00 …) — that integer is the number of months billed. It
   * is why Mantle shows varied averages side by side on a $15 plan where we
   * showed a flat $15.00: a merchant who spent a year on Elite before
   * moving down averages well above the Starter price, and one with
   * discounted or unbilled months averages below it.
   *
   * Annual payments count as twelve months rather than one, so an annual
   * subscriber sits on the same scale as a monthly one instead of reporting
   * their whole year as a single month's revenue.
   */
  amount: number;
  /**
   * The merchant's lifetime value with this APP, across every charge they
   * have ever had on it — not just the charge that put them on this plan.
   *
   * Mantle's figure behaves this way: a subscriber's lifetime value only
   * reconciles with their AMR if spend from a higher tier is included. Counting one charge in isolation would reset a merchant's
   * history every time they changed plan.
   */
  lifetimeValue: number;
  currency: string;
  onTrial: boolean;
  since: Date | null;
}

/**
 * The plans an app actually bills on, read off Partner charges.
 *
 * Distinct from the local `Plan` table, which is the catalogue this tool
 * OFFERS. An app billing through Shopify directly has none of those — its
 * plans live in Shopify — so its Plans page was empty while Mantle's listed
 * fifteen. These are observed rather than owned: there is nothing to edit.
 *
 * KEYED BY (name, list price, cadence), which is Mantle's plan identity and
 * not ours elsewhere. `planSeries` on the dashboard groups by name, which is
 * right for a top-five card; here it would merge rows Mantle shows apart —
 * the same tier sold monthly and annually, or several distinct plans that
 * all share one charge name. `planListedAmount` is
 * the LIST price before discounts, so a discounted merchant stays on their
 * plan instead of splitting off into a phantom one of their own.
 *
 * NOT served from `PartnerDailyPlanMrrSnapshot`, which would be far cheaper:
 * that table keys on plan NAME alone and so cannot express this split. Serving
 * it from there would need an amount+interval column and a backfill; until
 * then this pays for the shared `loadPartnerFacts` load, which every other
 * Partner-backed page on the request already pays for anyway.
 */
export async function buildObservedPlans(params: {
  appId: string;
  at?: Date;
}): Promise<ObservedPlan[]> {
  const at = params.at ?? new Date();
  const { histories } = await loadPartnerFacts([params.appId], new Date(at.getTime() + 1));

  const SEP = String.fromCharCode(31);
  const rows = new Map<string, ObservedPlan>();

  for (const history of histories) {
    const contribution = contributionAt(history, at);
    if (!contribution) continue;
    const plan = contribution.planName.trim();
    if (!plan) continue;

    /* The list price as billed: `planListedAmount` is monthly-normalized so
       annual plans can be summed against monthly ones, but a plan row has to
       show what the merchant is actually charged — $119.88 a year, not $9.99. */
    const amount =
      contribution.interval === "ANNUAL"
        ? round(contribution.planListedAmount * 12)
        : round(contribution.planListedAmount);

    const key = [contribution.currency, plan, amount, contribution.interval].join(SEP);
    const row =
      rows.get(key) ??
      {
        plan,
        currency: contribution.currency,
        amount,
        interval: contribution.interval,
        mrr: 0,
        customers: 0,
        trials: 0,
        lifetimeValue: 0,
      };
    if (contribution.kind === "trial") {
      row.trials += 1;
    } else {
      row.customers += 1;
      row.mrr += contribution.amount;
    }
    rows.set(key, row);
  }

  /* Lifetime value walks EVERY charge, not just the live ones above — see
     `lifetimeValue`'s note. Charges whose plan has no current subscriber are
     skipped: this list is what the app bills on today, and a plan nobody is
     on is not one of them. */
  for (const history of histories) {
    if (history.sales.length === 0) continue;
    const identity = planIdentityForCharge(history);
    if (!identity) continue;
    const key = [identity.currency, identity.plan, identity.amount, identity.interval].join(SEP);
    const row = rows.get(key);
    if (!row) continue;
    for (const sale of history.sales) row.lifetimeValue += Number(sale.grossAmount);
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      mrr: round(row.mrr),
      lifetimeValue: round(row.lifetimeValue),
    }))
    .sort((left, right) => right.mrr - left.mrr || right.customers - left.customers);
}

/**
 * One observed plan's own page: its figures, and who is on it.
 *
 * Takes the plan's full identity rather than a name, for the same reason
 * `buildObservedPlans` groups by it — one name can be a monthly and an annual
 * plan, or several plans at different prices. A name alone would silently
 * merge them.
 */
export async function buildObservedPlanDetail(params: {
  appId: string;
  plan: string;
  /** The billed list price, as `buildObservedPlans` reports it. */
  amount: number;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  at?: Date;
}): Promise<{
  plan: ObservedPlan;
  subscribers: ObservedPlanSubscriber[];
} | null> {
  const at = params.at ?? new Date();
  const { histories } = await loadPartnerFacts(
    [params.appId],
    new Date(at.getTime() + 1),
  );

  const wanted = params.plan.trim();

  /* Per-SHOP totals, built once over every charge the app has: a merchant's
     lifetime value and months billed both span their whole relationship, and
     reading them off the single charge that happens to sit on this plan would
     forget everything before their last plan change. */
  const lifetimeByShop = new Map<string, { value: number; months: number }>();
  for (const history of histories) {
    const shop = history.events[0]?.shopDomain;
    if (!shop) continue;
    const totals = lifetimeByShop.get(shop) ?? { value: 0, months: 0 };
    for (const sale of history.sales) {
      totals.value += Number(sale.grossAmount);
      /* One annual payment buys twelve months. Counting it as one would
         report a $119.88 charge as $119.88 a month. */
      totals.months += sale.billingInterval === "ANNUAL" ? 12 : 1;
    }
    lifetimeByShop.set(shop, totals);
  }
  const row: ObservedPlan = {
    plan: wanted,
    currency: "USD",
    amount: params.amount,
    interval: params.interval,
    mrr: 0,
    customers: 0,
    trials: 0,
    lifetimeValue: 0,
  };
  const subscribers: ObservedPlanSubscriber[] = [];
  let matched = false;

  for (const history of histories) {
    const contribution = contributionAt(history, at);
    if (!contribution) continue;
    if (contribution.planName.trim() !== wanted) continue;
    if (contribution.interval !== params.interval) continue;
    const billed =
      contribution.interval === "ANNUAL"
        ? round(contribution.planListedAmount * 12)
        : round(contribution.planListedAmount);
    if (billed !== params.amount) continue;

    matched = true;
    row.currency = contribution.currency;
    const totals = lifetimeByShop.get(contribution.shopDomain);
    if (contribution.kind === "trial") {
      row.trials += 1;
    } else {
      row.customers += 1;
      row.mrr += contribution.amount;
    }
    subscribers.push({
      shopDomain: contribution.shopDomain,
      /* Falls back to what they pay now when nothing has settled yet — a
         trialist has no months to average over, and 0 would read as free. */
      amount:
        totals && totals.months > 0
          ? round(totals.value / totals.months)
          : round(contribution.amount),
      lifetimeValue: round(totals?.value ?? 0),
      currency: contribution.currency,
      onTrial: contribution.kind === "trial",
      since: history.activatedAt,
    });
  }

  if (!matched) return null;

  /* The plan's all-time figure counts everyone who ever paid on it, not only
     those still subscribed — same reason as `buildObservedPlans`. The
     subscriber list above stays current-only, because that is a list of who is
     on the plan now. */
  for (const history of histories) {
    if (history.sales.length === 0) continue;
    const identity = planIdentityForCharge(history);
    if (
      !identity ||
      identity.plan !== wanted ||
      identity.interval !== params.interval ||
      identity.amount !== params.amount
    ) {
      continue;
    }
    for (const sale of history.sales) row.lifetimeValue += Number(sale.grossAmount);
  }

  subscribers.sort((left, right) => right.lifetimeValue - left.lifetimeValue);
  return {
    plan: { ...row, mrr: round(row.mrr), lifetimeValue: round(row.lifetimeValue) },
    subscribers,
  };
}

/** What the Events tooltip needs to say about one shop, as of now. */
export interface ShopSubscriptionSummary {
  shopDomain: string;
  /** When their current trial ends, or ended. Null when they never had one. */
  trialEndsAt: Date | null;
  /** The plan they are on RIGHT NOW — which need not be the plan whose page
   * this is, since an event can be the moment they left it. */
  currentPlan: { plan: string; amount: number; interval: "EVERY_30_DAYS" | "ANNUAL" } | null;
}

/**
 * Current subscription state for a handful of shops.
 *
 * Reads the shared, already-cached fact load rather than querying per shop:
 * any page calling this has almost certainly folded the same app a moment
 * earlier, so the marginal cost is a walk over histories in memory. Scoped to
 * the shops asked for, because a page shows one screen of events at a time and
 * folding for all 4,000 to describe 15 of them is work nobody reads.
 */
export async function buildShopSubscriptionSummaries(params: {
  appId: string;
  shopDomains: string[];
  at?: Date;
}): Promise<Map<string, ShopSubscriptionSummary>> {
  const at = params.at ?? new Date();
  const wanted = new Set(params.shopDomains);
  const out = new Map<string, ShopSubscriptionSummary>();
  if (wanted.size === 0) return out;

  const { histories } = await loadPartnerFacts(
    [params.appId],
    new Date(at.getTime() + 1),
  );

  for (const history of histories) {
    const shop = history.events[0]?.shopDomain;
    if (!shop || !wanted.has(shop)) continue;

    const contribution = contributionAt(history, at);
    const existing = out.get(shop) ?? {
      shopDomain: shop,
      trialEndsAt: null,
      currentPlan: null,
    };

    /* A shop can hold several charges at once during a plan change. The live
       one describes them; a dead one only says where they have been. */
    if (contribution) {
      existing.currentPlan = {
        plan: contribution.planName.trim(),
        amount:
          contribution.interval === "ANNUAL"
            ? round(contribution.planListedAmount * 12)
            : round(contribution.planListedAmount),
        interval: contribution.interval,
      };
      if (contribution.trialEndsAt) existing.trialEndsAt = contribution.trialEndsAt;
    } else if (!existing.trialEndsAt) {
      /* No live charge, so fall back to the last trial we know of — the
         tooltip on a "Canceled" event should still say when their trial
         ended, which is often the more useful half. */
      const past = contributionAt(history, history.lastEventAt ?? at);
      if (past?.trialEndsAt) existing.trialEndsAt = past.trialEndsAt;
    }
    out.set(shop, existing);
  }

  return out;
}
