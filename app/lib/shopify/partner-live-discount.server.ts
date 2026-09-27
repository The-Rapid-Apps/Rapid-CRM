import { prisma } from "../db.server";
import { logger } from "../logger.server";
import {
  listAmbiguousDiscountCharges,
  listInferredTrialCharges,
  listNativeDiscountCharges,
  listUnverifiedChargePrices,
  listOverriddenActiveCharges,
  listStaleActiveCharges,
} from "./partner-mrr.server";
import {
  effectivePartnerCredentials,
  partnerGraphqlWithCredentials,
  type PartnerApp,
} from "./partner.server";

const log = logger.scope("partner-live-discount");

/**
 * Don't re-check a charge more often than this while it remains a candidate
 * (ambiguous discount, gone quiet, or carrying a live override) — these
 * populations don't change minute to minute, so daily is plenty to catch
 * `discountEndsAt` passing, a merchant's plan changing, or a subscription
 * finally showing up as cancelled, without wasting Partner API budget
 * re-confirming the same answer.
 *
 * Note this floor is only meaningful if something actually invokes the job
 * daily. It ran unscheduled until 2026-09-09 — see `sync:live-discounts` in
 * `ecosystem.config.cjs`, and `LIVE_CHECK_TRUST_MS` for what now happens to
 * an override the refresher stops reaching.
 */
const STALE_MS = 24 * 60 * 60_000;

/**
 * How long a monthly-cadence active charge can go with no new event or sale
 * before it's worth spot-checking against live Shopify — see
 * `listStaleActiveCharges`'s own doc comment for why this is scoped to
 * monthly charges only.
 */
const STALE_ACTIVE_DAYS = 60;

/*
  `trialEndsAt` and `items.usage` were added 2026-09-09. Both are ground truth
  this platform previously had to guess at, and both were already reachable on
  the query this job has been making all along — no Admin API and no per-shop
  access token, which is what a first look suggested they would need.
  
  - `trialEndsAt` is Shopify's own trial end. `contributionAt` currently INFERS
    one from the distance between activation and `billingOn`, guarded by a
    12-hour floor, a cadence ceiling and a `shopHasPriorSale` check — a chain
    that exists only because this field was not being read.
  - `items.usage { cost { amount } quantity }` is the metered cost for the CURRENT billing
    cycle. `PartnerDailyMrrSnapshot.usageCharges` is 0.000000 on every row ever
    written, because nothing has ever supplied it.
  
  Both describe the live subscription, so they are truth from the day they are
  first recorded forward — neither can reconstruct a past date.
*/
const ACTIVE_SUBSCRIPTION_DISCOUNT_QUERY = /* GraphQL */ `
  query ActiveSubscriptionDiscount($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      billingPeriod
      trialEndsAt
      cancelAtEndOfCycle
      currentBillingCycle {
        startTime
        endTime
      }
      items {
        price {
          __typename
          ... on FlatRatePrice {
            amount
          }
        }
        usage {
          cost {
            amount
            currencyCode
          }
          quantity
        }
        discount {
          percentage
          discountEndsAt
          remainingDiscountCycles
        }
      }
    }
  }
`;

interface ActiveSubscriptionDiscountResponse {
  activeSubscription: {
    billingPeriod: "EVERY_30_DAYS" | "ANNUAL";
    trialEndsAt: string | null;
    cancelAtEndOfCycle: boolean | null;
    currentBillingCycle: { startTime: string; endTime: string } | null;
    items: Array<{
      price: { __typename?: string; amount?: string } | null;
      /** Present only on a tiered/metered item. Current cycle only. */
      usage: {
        cost: { amount: string | null; currencyCode: string | null } | null;
        quantity: number | null;
      } | null;
      discount: {
        percentage: number | null;
        discountEndsAt: string | null;
        remainingDiscountCycles: number | null;
      } | null;
    }>;
  } | null;
}

/**
 * The Partner API's `App`/`Shop` GIDs stored in this app's own tables use the
 * `gid://partners/...` namespace, but `activeSubscription`'s `appId`/`shopId`
 * arguments require `gid://shopify/...` — confirmed live 2026-08-31 via a
 * real `INVALID_GID` error. Swap the namespace, nothing else.
 */
function toShopifyGid(partnersGid: string): string {
  return partnersGid.replace(/^gid:\/\/partners\//, "gid://shopify/");
}

/**
 * The trial/usage/cycle columns, written identically on create and update.
 *
 * One function so the two halves of the upsert cannot drift — the existing
 * columns are already listed twice, which is exactly how a field ends up
 * recorded on first sight and never refreshed afterwards.
 */
function liveTruthFields(resolved: ResolvedLiveDiscount) {
  return {
    trialEndsAt: resolved.trialEndsAt,
    cancelAtEndOfCycle: resolved.cancelAtEndOfCycle,
    currentCycleStart: resolved.currentCycleStart,
    currentCycleEnd: resolved.currentCycleEnd,
    usageCost: resolved.usageCost,
    usageQuantity: resolved.usageQuantity,
  };
}

interface ResolvedLiveDiscount {
  effectiveAmount: number | null;
  /** Shopify's own trial end for the live subscription, or null. */
  trialEndsAt: Date | null;
  cancelAtEndOfCycle: boolean | null;
  currentCycleStart: Date | null;
  currentCycleEnd: Date | null;
  /** Metered cost across every usage item, for the CURRENT cycle only. */
  usageCost: number | null;
  usageQuantity: number | null;
  discountPercentage: number | null;
  discountEndsAt: Date | null;
  remainingDiscountCycles: number | null;
  subscriptionActive: boolean;
}

async function fetchLiveDiscount(
  app: PartnerApp,
  shopPlatformId: string,
): Promise<ResolvedLiveDiscount | null> {
  const creds = effectivePartnerCredentials(app);
  if (!creds || !app.shopifyAppId) return null;

  const data = await partnerGraphqlWithCredentials<ActiveSubscriptionDiscountResponse>(
    creds,
    ACTIVE_SUBSCRIPTION_DISCOUNT_QUERY,
    {
      appId: toShopifyGid(app.shopifyAppId),
      shopId: toShopifyGid(shopPlatformId),
    },
  );

  const sub = data.activeSubscription;
  if (!sub) {
    return {
      effectiveAmount: null,
      trialEndsAt: null,
      cancelAtEndOfCycle: null,
      currentCycleStart: null,
      currentCycleEnd: null,
      usageCost: null,
      usageQuantity: null,
      discountPercentage: null,
      discountEndsAt: null,
      remainingDiscountCycles: null,
      subscriptionActive: false,
    };
  }

  const item = sub.items[0];
  const face = item?.price?.amount ? Number(item.price.amount) : null;
  const discountPercentage = item?.discount?.percentage ?? null;
  let effectiveAmount =
    face !== null ? face * (1 - (discountPercentage ?? 0)) : null;
  if (effectiveAmount !== null && sub.billingPeriod === "ANNUAL") {
    effectiveAmount = effectiveAmount / 12;
  }

  /* Summed across items: a plan can carry a flat line and a metered line, and
     `usageCharges` wants the whole metered cost, not the first item's. Null
     when no item reports usage at all, so "no metered plan" stays
     distinguishable from "metered plan, nothing used yet". */
  const usageItems = sub.items.filter((entry) => entry.usage !== null);
  const usageCost = usageItems.length
    ? usageItems.reduce(
        (total, entry) => total + Number(entry.usage?.cost?.amount ?? 0),
        0,
      )
    : null;
  const usageQuantity = usageItems.length
    ? usageItems.reduce((total, entry) => total + Number(entry.usage?.quantity ?? 0), 0)
    : null;

  return {
    effectiveAmount:
      effectiveAmount !== null && Number.isFinite(effectiveAmount)
        ? effectiveAmount
        : null,
    trialEndsAt: sub.trialEndsAt ? new Date(sub.trialEndsAt) : null,
    cancelAtEndOfCycle: sub.cancelAtEndOfCycle ?? null,
    currentCycleStart: sub.currentBillingCycle
      ? new Date(sub.currentBillingCycle.startTime)
      : null,
    currentCycleEnd: sub.currentBillingCycle
      ? new Date(sub.currentBillingCycle.endTime)
      : null,
    usageCost:
      usageCost !== null && Number.isFinite(usageCost) ? usageCost : null,
    usageQuantity:
      usageQuantity !== null && Number.isFinite(usageQuantity)
        ? usageQuantity
        : null,
    discountPercentage,
    discountEndsAt: item?.discount?.discountEndsAt
      ? new Date(item.discount.discountEndsAt)
      : null,
    remainingDiscountCycles: item?.discount?.remainingDiscountCycles ?? null,
    subscriptionActive: true,
  };
}

/**
 * A first-ever run (or one that's fallen behind) can face hundreds of
 * candidates — found the hard way 2026-09-02, when an unbounded run against
 * production timed out at the reverse proxy after ~359 checks and the
 * in-flight request was killed outright (no further progress after the
 * connection dropped, unlike a client that just stops waiting). Each check
 * is a real Partner API round trip plus the existing 120ms pacing, so this
 * caps how many checks a single invocation attempts — same shape as
 * `syncOrganizationPartnerSubscriptionFacts`'s `maxEventPages`/`maxSalePages`
 * bounding. `hasMore: true` tells the caller (the cron route) there's still
 * a backlog, so it can be invoked again rather than assumed complete.
 */
const DEFAULT_MAX_CHECKS_PER_APP = 100;

/**
 * Resolves uncertain charges for one app against Shopify's live
 * `activeSubscription` data, persisting the result so `contributionAt` can
 * use it immediately instead of waiting for a real billing cycle to
 * naturally resolve it: (1) an ambiguous discount — a sale below listed
 * price with no second sale to corroborate it yet — and (2) a monthly
 * charge that's gone quiet far longer than a healthy one should, which
 * sometimes means the subscription-events feed never received a terminal
 * event for it at all (confirmed 2026-09-01; see `listStaleActiveCharges`'s
 * doc comment — this is deliberately NOT the local `AccountLifecycleEvent`
 * data, which real data showed is not reliably terminal either), and (3) a
 * charge whose MRR amount this job is itself already supplying, which has to
 * keep being re-verified for as long as it's in use (see
 * `listOverriddenActiveCharges`). Also verifies trial classification, prices
 * with no sale evidence (including annual and past-due charges), and applied
 * native discount redemptions. Best-effort
 * per charge — one failure (a purged shop, a transient API error) is logged
 * and skipped, never aborts the rest of the app's run, same non-throwing
 * convention as `resolveOfferCadencePins`' own write.
 */
export async function syncLiveDiscountChecksForApp(
  app: PartnerApp,
  at: Date = new Date(),
  maxChecks: number = DEFAULT_MAX_CHECKS_PER_APP,
): Promise<{ checked: number; skipped: number; errors: number; hasMore: boolean }> {
  const creds = effectivePartnerCredentials(app);
  if (!creds) {
    // Same return shape as "no candidates", so without this line the two are
    // indistinguishable in the cron response.
    log.warn("live discount check skipped: no partner credentials", {
      appId: app.id,
    });
    return { checked: 0, skipped: 0, errors: 0, hasMore: false };
  }

  const [
    ambiguousDiscounts,
    staleActive,
    overridden,
    inferredTrials,
    unverifiedPrices,
    nativeDiscounts,
  ] = await Promise.all([
    listAmbiguousDiscountCharges(app.id, at),
    listStaleActiveCharges(app.id, at, STALE_ACTIVE_DAYS),
    // Anything this job's own past output is still supplying to the MRR
    // math. Without it the job can't refresh what it already wrote — see
    // `listOverriddenActiveCharges`.
    listOverriddenActiveCharges(app.id, at),
    // Verify trial classification as well as price.
    listInferredTrialCharges(app.id, at),
    // Neither a list-price guess nor a past-due zero is verified pricing.
    // The stale selector misses recent monthly activity and annual plans.
    listUnverifiedChargePrices(app.id, at),
    listNativeDiscountCharges(app.id, at),
  ]);
  const candidatesByCharge = new Map<
    string,
    { shopDomain: string; chargePlatformId: string }
  >();
  for (const charge of [
    ...ambiguousDiscounts,
    ...staleActive,
    ...overridden,
    ...inferredTrials,
    ...unverifiedPrices,
    ...nativeDiscounts,
  ]) {
    candidatesByCharge.set(charge.chargePlatformId, charge);
  }
  const candidates = [...candidatesByCharge.values()];
  /* This job spent a week reporting `checked: 0` with 348 candidates sitting
     in the database and no way to tell which of its four silent exits it was
     taking — missing credentials, an empty candidate set, every candidate
     inside the staleness floor, or no `shopPlatformId` to ask Shopify about.
     One line per app, always, so "it ran and did nothing" is greppable and
     attributable. */
  log.info("live discount check candidates", {
    appId: app.id,
    ambiguous: ambiguousDiscounts.length,
    staleActive: staleActive.length,
    overridden: overridden.length,
    inferredTrials: inferredTrials.length,
    unverifiedPrices: unverifiedPrices.length,
    nativeDiscounts: nativeDiscounts.length,
    candidates: candidates.length,
    maxChecks,
  });
  if (candidates.length === 0) return { checked: 0, skipped: 0, errors: 0, hasMore: false };

  const existingRows = await prisma.partnerChargeLiveDiscountCheck.findMany({
    where: { appId: app.id },
    select: { chargePlatformId: true, checkedAt: true },
  });
  const checkedAtByCharge = new Map(
    existingRows.map((row) => [row.chargePlatformId, row.checkedAt]),
  );

  const shopEvents = await prisma.partnerSubscriptionEvent.findMany({
    where: {
      appId: app.id,
      shopDomain: { in: [...new Set(candidates.map((c) => c.shopDomain))] },
      shopPlatformId: { not: null },
    },
    select: { shopDomain: true, shopPlatformId: true },
  });
  const shopPlatformIdByDomain = new Map<string, string>();
  for (const event of shopEvents) {
    if (event.shopPlatformId && !shopPlatformIdByDomain.has(event.shopDomain)) {
      shopPlatformIdByDomain.set(event.shopDomain, event.shopPlatformId);
    }
  }

  let checked = 0;
  let skipped = 0;
  let errors = 0;
  let hasMore = false;

  for (const charge of candidates) {
    if (checked >= maxChecks) {
      hasMore = true;
      break;
    }
    const lastChecked = checkedAtByCharge.get(charge.chargePlatformId);
    if (lastChecked && at.getTime() - lastChecked.getTime() < STALE_MS) {
      skipped++;
      continue;
    }
    const shopPlatformId = shopPlatformIdByDomain.get(charge.shopDomain);
    if (!shopPlatformId) {
      skipped++;
      continue;
    }
    try {
      const resolved = await fetchLiveDiscount(app, shopPlatformId);
      if (!resolved) {
        skipped++;
        continue;
      }
      await prisma.partnerChargeLiveDiscountCheck.upsert({
        where: {
          appId_chargePlatformId: {
            appId: app.id,
            chargePlatformId: charge.chargePlatformId,
          },
        },
        create: {
          appId: app.id,
          chargePlatformId: charge.chargePlatformId,
          effectiveAmount: resolved.effectiveAmount,
          discountPercentage: resolved.discountPercentage,
          discountEndsAt: resolved.discountEndsAt,
          remainingDiscountCycles: resolved.remainingDiscountCycles,
          subscriptionActive: resolved.subscriptionActive,
          ...liveTruthFields(resolved),
        },
        update: {
          effectiveAmount: resolved.effectiveAmount,
          discountPercentage: resolved.discountPercentage,
          discountEndsAt: resolved.discountEndsAt,
          remainingDiscountCycles: resolved.remainingDiscountCycles,
          subscriptionActive: resolved.subscriptionActive,
          ...liveTruthFields(resolved),
          checkedAt: at,
        },
      });
      checked++;
    } catch (error) {
      errors++;
      log.warn("live discount check failed", {
        appId: app.id,
        chargePlatformId: charge.chargePlatformId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info("live discount check finished for app", {
    appId: app.id,
    candidates: candidates.length,
    checked,
    skipped,
    errors,
    hasMore,
  });
  return { checked, skipped, errors, hasMore };
}

/**
 * Total checks a single org-level invocation attempts across every app
 * combined — bounds the whole HTTP request the cron route makes, not just
 * one app's share of it. Spread evenly-ish by giving each app up to
 * `DEFAULT_MAX_CHECKS_PER_APP` but stopping the whole run once this total is
 * hit, so one app with a huge backlog can't starve the others in a single
 * tick either.
 */
const DEFAULT_MAX_CHECKS_PER_ORG = 80;

/**
 * Org-wide fan-out, mirroring `syncOrganizationPartnerSubscriptionFacts`'s
 * shape: apps processed sequentially, not in parallel — parallel Partner API
 * calls across apps exhaust the shared rate-limit bucket (the exact reason
 * that sync job stays sequential too). Per-app errors are collected, never
 * abort the rest of the organization's apps. Bounded per invocation (see
 * `DEFAULT_MAX_CHECKS_PER_ORG`'s doc comment) — `hasMore: true` means the
 * cron should be invoked again to keep working through the backlog.
 */
export async function syncOrganizationLiveDiscountChecks(
  organizationId: string,
  maxChecks: number = DEFAULT_MAX_CHECKS_PER_ORG,
): Promise<{
  appsProcessed: number;
  checked: number;
  skipped: number;
  errors: Array<{ appId: string; message: string }>;
  hasMore: boolean;
}> {
  const apps = await prisma.app.findMany({
    where: {
      organizationId,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
    },
    include: { partnerConnection: true },
  });

  let checked = 0;
  let skipped = 0;
  let hasMore = false;
  const errors: Array<{ appId: string; message: string }> = [];

  for (const app of apps) {
    const remaining = maxChecks - checked;
    if (remaining <= 0) {
      hasMore = true;
      break;
    }
    try {
      const result = await syncLiveDiscountChecksForApp(
        app,
        new Date(),
        Math.min(remaining, DEFAULT_MAX_CHECKS_PER_APP),
      );
      checked += result.checked;
      skipped += result.skipped;
      if (result.hasMore) hasMore = true;
    } catch (error) {
      errors.push({
        appId: app.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { appsProcessed: apps.length, checked, skipped, errors, hasMore };
}
