import type { ActionFunctionArgs } from "react-router";
import { apiError } from "~/lib/api-auth.server";
import { hasValidCronSecret } from "~/lib/cron-auth.server";
import { runTrafficEventsCron } from "~/lib/reports/traffic-events-sync.server";

/**
 * POST /api/flex/cron/traffic-events
 *
 * Backstop for the local GA4 traffic-event mirror (TrafficEventFact): syncs
 * the recent-lane overlap window and advances the one-time historical
 * backfill for every app with GA4/BigQuery configured. The interactive
 * `/api/metrics-sync` trigger already runs the recent lane on page load/tab
 * refocus/5-min interval, but never the backfill (bounded interactive
 * budget) — this cron is the only place the backfill actually advances, same
 * division of labor as customer-events/subscription-events cron vs. their
 * own interactive triggers.
 *
 * Driven by the `traffic-events` lane in sync-lanes.server.ts, so the status
 * codes answer that contract: 200 = nothing left to do, 503 = cannot progress.
 * It never answers 202 — one call advances one bounded backfill window and the
 * next tick takes the following one.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");

  if (!hasValidCronSecret(request)) {
    return apiError(401, "Invalid cron secret");
  }

  const summary = await runTrafficEventsCron();
  // No app has GA4/BigQuery configured, so there is genuinely nothing to sync —
  // that is 200 (complete), not 503. Conflating the two mattered once this
  // became a scheduled lane instead of a `curl ... || true` in a workflow: the
  // driver retires a 503 lane with an ERROR log, so an install that simply
  // doesn't use GA4 would file a failure every five minutes forever. 503 stays
  // reserved for the real blocked case — apps are configured and every one of
  // them failed.
  const unusable =
    summary.appsProcessed > 0 &&
    summary.errors.length === summary.appsProcessed;
  return Response.json(summary, {
    status: unusable ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
