import type {
  FlexBillingEventType,
  PlanInterval,
} from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { toCents, type Numeric } from "../money.server";

const log = logger.scope("flex-events");

/**
 * Append-only audit writer (spec §1.5). This is OBSERVABILITY, not load-bearing
 * billing: every function swallows its own errors and never throws into the
 * charge/tier-change path. A failed audit write must never corrupt real money.
 */

async function safe<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log.error(`audit write failed: ${label}`, { err: String(err) });
    return null;
  }
}

/** Store a `subscribed` event when a flex subscription activates (spec §7). */
export function recordSubscribed(params: {
  organizationId: string;
  subscriptionId: string;
  amount: Numeric;
  currencyCode: string;
  interval: PlanInterval;
  test: boolean;
}): Promise<unknown> {
  return safe(async () => {
    const existing = await prisma.flexBillingEvent.findFirst({
      where: {
        subscriptionId: params.subscriptionId,
        type: "SUBSCRIBED",
      },
      select: { id: true },
    });
    if (existing) return existing;
    const created = await prisma.flexBillingEvent.create({
      data: {
        organizationId: params.organizationId,
        subscriptionId: params.subscriptionId,
        type: "SUBSCRIBED",
        amount: toCents(params.amount),
        currencyCode: params.currencyCode,
        interval: params.interval,
        test: params.test,
        completedAt: new Date(),
      },
    });
    return created;
  }, "recordSubscribed");
}

/** Record a recurring charge — amount is the ACTUAL charged amount (discounted). */
export function recordSubscriptionCharged(params: {
  organizationId: string;
  subscriptionId: string;
  amount: Numeric;
  currencyCode: string;
  interval: PlanInterval;
  test: boolean;
}): Promise<unknown> {
  return safe(async () => {
    const created = await prisma.flexBillingEvent.create({
      data: {
        organizationId: params.organizationId,
        subscriptionId: params.subscriptionId,
        type: "SUBSCRIPTION_CHARGED",
        amount: toCents(params.amount),
        currencyCode: params.currencyCode,
        interval: params.interval,
        test: params.test,
        proration: false,
        completedAt: new Date(),
      },
    });
    return created;
  }, "recordSubscriptionCharged");
}

/**
 * Create the upgrade/downgrade event at the START of a tier change. `amount` is
 * the NEW plan's full LIST price; direction is set by list-price comparison
 * (spec §5 step 3), independent of proration sign. Returns the event id so the
 * caller can fill in the proration platform id once the charge/credit settles.
 */
export async function createTierChangeEvent(params: {
  organizationId: string;
  type: Extract<FlexBillingEventType, "UPGRADED" | "DOWNGRADED">;
  /** Previous subscription id (appears as both subscription and previous, §1.5). */
  previousSubscriptionId: string;
  amount: Numeric;
  currencyCode: string;
  proration: boolean;
  prorationAmount: Numeric;
  minutesOnPlanBeforeChange: number | null;
}): Promise<string | null> {
  const event = await safe(
    () =>
      prisma.flexBillingEvent.create({
        data: {
          organizationId: params.organizationId,
          type: params.type,
          subscriptionId: params.previousSubscriptionId,
          previousSubscriptionId: params.previousSubscriptionId,
          amount: toCents(params.amount),
          currencyCode: params.currencyCode,
          proration: params.proration,
          prorationAmount: toCents(params.prorationAmount),
          prorationAmountCurrency: params.currencyCode,
          minutesOnPlanBeforeChange: params.minutesOnPlanBeforeChange,
        },
      }),
    "createTierChangeEvent",
  );
  return event ? (event as { id: string }).id : null;
}

/** Fill in the proration platform id + completion time once the call settles. */
export function completeProration(
  eventId: string | null,
  params: { prorationPlatformId?: string | null; prorationAmount?: Numeric },
): Promise<unknown> {
  if (!eventId) return Promise.resolve(null);
  return safe(
    () =>
      prisma.flexBillingEvent.update({
        where: { id: eventId },
        data: {
          prorationPlatformId: params.prorationPlatformId ?? undefined,
          prorationAmount:
            params.prorationAmount === undefined
              ? undefined
              : toCents(params.prorationAmount),
          prorationCompletedAt: new Date(),
        },
      }),
    "completeProration",
  );
}

/** Mark a tier-change event fully committed. */
export function completeEvent(eventId: string | null): Promise<unknown> {
  if (!eventId) return Promise.resolve(null);
  return safe(
    () =>
      prisma.flexBillingEvent.update({
        where: { id: eventId },
        data: { completedAt: new Date() },
      }),
    "completeEvent",
  );
}
