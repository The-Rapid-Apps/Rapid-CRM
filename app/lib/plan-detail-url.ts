/**
 * The URL of one observed plan's page.
 *
 * A plan billed through Shopify has no row of our own to point at, and no id —
 * its identity IS (name, list price, cadence), which is how Mantle keys plans
 * and how `buildObservedPlans` groups them. All three go in the query string
 * because all three are needed to pick the right plan back out: Rapi Bundle
 * has two plans called "Starter" and Rapi Tracking has four called
 * "Monthly Plan".
 */
export function planDetailUrl(
  appId: string,
  plan: { plan: string; amount: number; interval: "EVERY_30_DAYS" | "ANNUAL" },
): string {
  const params = new URLSearchParams({
    appId,
    plan: plan.plan,
    amount: String(plan.amount),
    interval: plan.interval,
  });
  return `/app/plans/observed?${params}`;
}
