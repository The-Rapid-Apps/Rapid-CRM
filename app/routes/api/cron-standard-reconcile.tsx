import type { ActionFunctionArgs } from "react-router";
import { apiError } from "~/lib/api-auth.server";
import { env } from "~/lib/env.server";
import { reconcileStandardSubscriptions } from "~/lib/standard/reconcile.server";
import { expirePendingOneTimePurchases } from "~/lib/standard/one-time.server";

/**
 * POST /api/flex/cron/standard-reconcile
 *
 * The standard rail's only scheduled job, and note what it is NOT: it does not
 * charge anything. Shopify collects on its own cycle (spec §0.1) — this exists
 * because Shopify then tells you almost nothing, so the local mirror has to
 * re-read the original to learn that a cycle rolled over, a payment froze, or a
 * merchant cancelled from the Shopify admin.
 *
 * Daily is plenty: it corrects state, it does not drive it. Safe to re-run.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");
  if (request.headers.get("x-cron-secret") !== env.CRON_SECRET) {
    return apiError(401, "Invalid cron secret");
  }
  const [subscriptions, purchases] = await Promise.all([
    reconcileStandardSubscriptions(),
    // Shopify never expires a confirmation URL, so an approval screen the
    // merchant closed would stay PENDING forever without a local sweep.
    expirePendingOneTimePurchases(),
  ]);
  return Response.json({ subscriptions, purchases });
}
