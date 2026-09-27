import type { ActionFunctionArgs } from "react-router";
import { apiError } from "~/lib/api-auth.server";
import { hasValidCronSecret } from "~/lib/cron-auth.server";
import { runAppReviewsCron } from "~/lib/reviews/app-reviews-sync.server";

/**
 * POST /api/flex/cron/app-reviews
 *
 * Collects App Store reviews for every app with an App Store handle — see
 * app-reviews-sync.server.ts. Driven by the `app-reviews` lane in
 * sync-lanes.server.ts: 200 = every full read finished, 202 = a full read is
 * still going (the driver calls again), 503 = handles are set and every app
 * failed. An app that fails is logged and left for the next tick rather than
 * answered with 202, which would have the driver retry a broken listing
 * straight away.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");

  if (!hasValidCronSecret(request)) {
    return apiError(401, "Invalid cron secret");
  }

  const summary = await runAppReviewsCron();
  const unusable =
    summary.appsProcessed > 0 && summary.errors.length === summary.appsProcessed;
  return Response.json(summary, {
    status: unusable ? 503 : summary.complete ? 200 : 202,
    headers: { "Cache-Control": "no-store" },
  });
}
