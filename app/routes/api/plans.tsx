import type { LoaderFunctionArgs } from "react-router";
import { handleApi, requireApiApp } from "~/lib/api-auth.server";
import { prisma } from "~/lib/db.server";
import { logger } from "~/lib/logger.server";
import {
  resolveFeaturesForPlans,
  serializeFeatures,
} from "~/lib/plans/features.server";

const log = logger.scope("flex-plans");

/**
 * GET /api/flex/plans
 * Lists the app's active, public plans for a pricing page.
 *
 * Serves BOTH billing rails: `flexBilling` says which one a plan is on, and a
 * standard-billing plan is priced by `amount` + `interval` as a real recurring
 * charge while a flex plan carries that same amount as a usage record. An app
 * rendering a pricing page does not need to care; an app calling `subscribe`
 * does not either, since the rail is chosen from the plan.
 *
 * `features` is the entitlement set, keyed the way the app gates on it. Absence
 * of an entitlement row is the feature's DEFAULT, never a denial, so every plan
 * carries the full set — see `app/lib/plans/features.ts`.
 *
 * Resolved WITHOUT trial overrides: this is the catalogue, not a subscription,
 * and there is no trial in progress to read. `GET /api/flex/subscription/:id`
 * is the endpoint that knows whether a merchant is inside a trial.
 */
export function loader({ request }: LoaderFunctionArgs) {
  return handleApi(async () => {
    const app = await requireApiApp(request);
    const plans = await prisma.plan.findMany({
      where: { appId: app.id, active: true, isPublic: true },
      orderBy: [{ sortOrder: "asc" }, { amount: "asc" }],
    });

    // Diagnostic: shows whether an app is fetching its catalogue and, crucially,
    // how many plans it gets back vs how many exist. A `returned: 0` while
    // `totalForApp > 0` means the plans exist but aren't active+public, which
    // looks to the app like "no plans to subscribe to".
    const totalForApp = await prisma.plan.count({ where: { appId: app.id } });
    log.info("fetched", {
      appId: app.id,
      appName: app.name,
      returned: plans.length,
      totalForApp,
      planIds: plans.map((p) => p.id),
    });

    const features = await resolveFeaturesForPlans(
      app.id,
      plans.map((p) => p.id),
    );
    return Response.json({
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        amount: p.amount.toString(),
        currencyCode: p.currencyCode,
        interval: p.interval,
        trialDays: p.trialDays,
        flexBilling: p.flexBilling,
        usageChargeCappedAmount: p.usageChargeCappedAmount.toString(),
        onUsageLimitReached: p.onUsageLimitReached,
        limitMetric: p.limitMetric,
        limitMax: p.limitMax?.toString() ?? null,
        // Business revenue ceiling the app enforces. Always USD; null = no cap.
        // The platform never computes against it — the app converts merchant
        // revenue to USD and compares.
        revenueCapLimit: p.revenueCapLimit?.toString() ?? null,
        revenueCapPeriod: p.revenueCapPeriod,
        revenueCapCurrency: "USD",
        features: serializeFeatures(features.get(p.id) ?? []),
      })),
    });
  });
}
