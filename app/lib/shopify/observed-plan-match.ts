/**
 * Attaching Shopify-billed merchants to the catalogue plans they are on.
 *
 * A standard (non-flex) plan is billed by Shopify, not by this platform, so no
 * local `Subscription` row ever exists for it and the Plans page counted zero
 * customers on every one of them — a large app showed 0 against thousands of live
 * Partner subscriptions. The merchants are all in the Partner data, grouped by
 * `buildObservedPlans` into (charge name, amount, interval, currency); this
 * maps each of those groups onto the catalogue plan it is.
 *
 * Matched on the NAME and the price together, never the price alone: Rapid
 * Bundle has both "Starter_yearly" and "PAY YEARLY" at $119.88 a year, and a
 * price-only match would hand one plan's merchants to the other. Names are
 * compared loosely because the two sides spell the same plan differently —
 * Shopify charges an annual Starter as "Starter" at $119.88, the catalogue
 * calls it "Starter_yearly" — so a trailing cadence word and punctuation are
 * ignored, and the interval and amount carry the cadence instead.
 */

export interface CataloguePlanKey {
  id: string;
  name: string;
  amount: number;
  interval: string;
  currency: string;
}

export interface ObservedPlanCounts {
  plan: string;
  amount: number;
  interval: string;
  currency: string;
  customers: number;
  trials: number;
  mrr: number;
}

export interface PlanCountMatch {
  byPlanId: Record<string, { customers: number; trials: number; mrr: number }>;
  /** Groups Shopify bills that no catalogue plan claims — shown, not dropped. */
  unmatched: ObservedPlanCounts[];
}

const CADENCE_SUFFIX = /(yearly|annual|annually|monthly|month|year)$/;

/** "Starter_yearly" → "starter", "PAY YEARLY" → "pay", "Pro" → "pro". */
export function planNameKey(name: string): string {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const stripped = compact.replace(CADENCE_SUFFIX, "");
  // Never strip a name down to nothing ("Monthly" alone stays "monthly").
  return stripped || compact;
}

const cents = (amount: number) => Math.round(amount * 100);

function keyOf(plan: { name: string; amount: number; interval: string; currency: string }) {
  return [planNameKey(plan.name), cents(plan.amount), plan.interval, plan.currency.toUpperCase()].join("|");
}

export function matchObservedPlans(
  catalogue: CataloguePlanKey[],
  observed: ObservedPlanCounts[],
): PlanCountMatch {
  /* Two catalogue plans on one key would make a match a coin toss, so such a
     key claims nothing and its merchants surface as unmatched instead. */
  const byKey = new Map<string, string | null>();
  for (const plan of catalogue) {
    const key = keyOf(plan);
    byKey.set(key, byKey.has(key) ? null : plan.id);
  }

  const byPlanId: PlanCountMatch["byPlanId"] = {};
  const unmatched: ObservedPlanCounts[] = [];
  for (const group of observed) {
    const planId = byKey.get(keyOf({ ...group, name: group.plan })) ?? null;
    if (!planId) {
      unmatched.push(group);
      continue;
    }
    const entry = (byPlanId[planId] ??= { customers: 0, trials: 0, mrr: 0 });
    entry.customers += group.customers;
    entry.trials += group.trials;
    entry.mrr += group.mrr;
  }
  return { byPlanId, unmatched };
}
