/**
 * Reading plan entitlements out of the database.
 *
 * The rules live in `./features.ts` and are pure; this file only fetches. It is
 * split that way because the resolution order (trial → plan → default) is the
 * part worth testing, and it needs no database to be worth testing.
 *
 * Every read here batches across plans. A pricing page asks for the whole
 * catalogue at once, and a per-plan query would be one round trip per tier for
 * data that is a single indexed read.
 */
import { prisma, Prisma } from "../db.server";
import {
  resolveFeatures,
  type FeatureEntitlement,
  type ResolvedFeature,
  type ResolveOptions,
} from "./features";

/** Every feature the app defines, in display order. Archived excluded by default. */
export async function loadFeatureDefinitions(
  appId: string,
  options: { includeArchived?: boolean } = {},
) {
  return prisma.planFeature.findMany({
    where: {
      appId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });
}

/**
 * Resolved entitlements for several plans at once, keyed by plan id.
 *
 * Plans with no entitlement rows still appear, carrying every feature at its
 * default — which is the contract `resolveFeatures` documents and the reason a
 * caller can render a comparison table without special-casing a new plan.
 */
export async function resolveFeaturesForPlans(
  appId: string,
  planIds: string[],
  options: ResolveOptions = {},
): Promise<Map<string, ResolvedFeature[]>> {
  const resolved = new Map<string, ResolvedFeature[]>();
  if (planIds.length === 0) return resolved;

  const [definitions, entitlements] = await Promise.all([
    loadFeatureDefinitions(appId, options),
    prisma.planFeatureEntitlement.findMany({
      where: { planId: { in: planIds } },
      select: {
        planId: true,
        value: true,
        trialValue: true,
        feature: { select: { key: true } },
      },
    }),
  ]);

  const byPlan = new Map<string, FeatureEntitlement[]>();
  for (const row of entitlements) {
    const list = byPlan.get(row.planId) ?? [];
    list.push({
      key: row.feature.key,
      value: row.value,
      trialValue: row.trialValue,
    });
    byPlan.set(row.planId, list);
  }

  for (const planId of planIds) {
    resolved.set(
      planId,
      resolveFeatures(definitions, byPlan.get(planId) ?? [], options),
    );
  }
  return resolved;
}

/**
 * Every feature at its default, for a customer on no plan at all.
 *
 * The free / not-yet-subscribed / mid-approval state. It has to be the DEFAULTS
 * and not an empty set: an app doing `features.x?.value === true` against `{}`
 * denies everything, which would lock out a merchant whose subscription is
 * still being approved.
 */
export async function resolveDefaultFeatures(
  appId: string,
  options: ResolveOptions = {},
): Promise<ResolvedFeature[]> {
  return resolveFeatures(await loadFeatureDefinitions(appId, options), [], options);
}

/** One plan's resolved entitlements. */
export async function resolveFeaturesForPlan(
  appId: string,
  planId: string,
  options: ResolveOptions = {},
): Promise<ResolvedFeature[]> {
  const map = await resolveFeaturesForPlans(appId, [planId], options);
  return map.get(planId) ?? [];
}

/**
 * What one SUBSCRIPTION is entitled to right now.
 *
 * Reads the trial window off the subscription rather than taking `inTrial` from
 * the caller, because the caller is usually an app asking "what may this
 * merchant do", and that answer must not depend on the app's clock. A
 * subscription that is not active gets no entitlements at all — a cancelled
 * plan grants nothing, and returning its former features would let an app keep
 * honouring them.
 */
export async function resolveFeaturesForSubscription(
  subscriptionId: string,
  at: Date = new Date(),
): Promise<ResolvedFeature[] | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      planId: true,
      status: true,
      trialStartedAt: true,
      trialEndsAt: true,
      appInstall: { select: { appId: true } },
    },
  });
  if (!subscription) return null;
  if (subscription.status !== "ACTIVE") return [];

  const inTrial = Boolean(
    subscription.trialEndsAt &&
      subscription.trialEndsAt > at &&
      (!subscription.trialStartedAt || subscription.trialStartedAt <= at),
  );

  return resolveFeaturesForPlan(
    subscription.appInstall.appId,
    subscription.planId,
    { inTrial },
  );
}

export interface EffectiveUsageLimit {
  /** The ceiling, or null when there is none (unlimited, or nothing stated). */
  limit: number | null;
  unlimited: boolean;
  /** Which statement of the limit won, for the log line when they disagree. */
  source: "entitlement" | "plan" | "none";
  /**
   * The entitlement said something unparseable. The caller MUST NOT act on the
   * fallback in that case — see `resolveUsageLimitForPlan`.
   */
  malformed: boolean;
}

/**
 * The ceiling a plan is actually gated on, from the ONE place that should state
 * it.
 *
 * Two places can: the plan's own `limitMax`, and a LIMIT-typed feature
 * entitlement whose key is the plan's `limitMetric`. They are the same number
 * for the same purpose, and once both exist they drift — at which point a
 * merchant is shown one ceiling by the app and upgraded at another. That is the
 * bug this function removes.
 *
 * The **entitlement wins**, because it is the number the app reads through
 * `GET /v1/customer`, renders on the pricing page and enforces. Being charged
 * for crossing a line different from the one you were shown is worse than any
 * inconsistency in the other direction. `limitMax` stays as the fallback for a
 * plan with no feature for its metric.
 *
 * `unlimited` resolves to `limit: null`, which means never upgrade — an
 * unlimited tier has nothing to be upgraded off.
 *
 * A malformed entitlement returns `malformed: true` and `limit: null`. The
 * caller must then do NOTHING rather than fall back: falling back would charge a
 * merchant more on the strength of a number the operator plainly mistyped, and
 * declining to upgrade costs only revenue that a fixed value recovers.
 */
export async function resolveUsageLimitForPlan(plan: {
  id: string;
  appId: string;
  limitMetric: string | null;
  limitMax: Prisma.Decimal | null;
}): Promise<EffectiveUsageLimit> {
  const planLimit = plan.limitMax == null ? null : Number(plan.limitMax);

  if (!plan.limitMetric) {
    return {
      limit: planLimit,
      unlimited: false,
      source: planLimit === null ? "none" : "plan",
      malformed: false,
    };
  }

  const features = await resolveFeaturesForPlan(plan.appId, plan.id);
  const feature = features.find((f) => f.key === plan.limitMetric);

  if (
    !feature ||
    (feature.type !== "LIMIT" && feature.type !== "LIMIT_WITH_OVERAGE")
  ) {
    // No feature states this metric — the plan column is the only statement.
    return {
      limit: planLimit,
      unlimited: false,
      source: planLimit === null ? "none" : "plan",
      malformed: false,
    };
  }

  if (feature.malformed) {
    return { limit: null, unlimited: false, source: "entitlement", malformed: true };
  }
  if (feature.unlimited) {
    return { limit: null, unlimited: true, source: "entitlement", malformed: false };
  }
  return {
    limit: feature.limit,
    unlimited: false,
    source: "entitlement",
    malformed: false,
  };
}

/**
 * The JSON an app receives. Trimmed deliberately: `source` and `malformed` are
 * operator diagnostics, not something an integrator should branch on, and
 * `visibleToCustomers` governs the pricing page rather than enforcement.
 */
export function serializeFeatures(features: ResolvedFeature[]) {
  return Object.fromEntries(
    features.map((feature) => [
      feature.key,
      {
        name: feature.name,
        description: feature.description,
        type: feature.type,
        value: feature.value,
        enabled: feature.enabled,
        limit: feature.limit,
        unlimited: feature.unlimited,
        visibleToCustomers: feature.visibleToCustomers,
      },
    ]),
  );
}
