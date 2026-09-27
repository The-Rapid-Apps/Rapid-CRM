import type { ActionFunctionArgs } from "react-router";
import { apiError } from "~/lib/api-auth.server";
import { hasValidCronSecret } from "~/lib/cron-auth.server";
import { runChargeCron, runPausedSweep } from "~/lib/flex/charge.server";
import {
  expirePendingSubscriptions,
  reconcilePendingSubscriptionApprovals,
} from "~/lib/flex/subscribe.server";

/**
 * POST /api/flex/cron/charge
 *
 * Triggers the daily charge cron (spec §4) plus the paused-subscription sweep.
 * Wire your scheduler (cron job, Cloud Scheduler, GitHub Action, etc.) to hit
 * this once a day with the X-Cron-Secret header. This is the engine's heartbeat:
 * Shopify gives no billing webhook, so nothing charges without it.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");

  if (!hasValidCronSecret(request)) {
    return apiError(401, "Invalid cron secret");
  }

  const resumed = await runPausedSweep();
  const approvals = await reconcilePendingSubscriptionApprovals();
  const expiredPending = await expirePendingSubscriptions();
  const summary = await runChargeCron();
  return Response.json({
    ...summary,
    ...resumed,
    approvals,
    expiredPending: expiredPending.expired,
  });
}
