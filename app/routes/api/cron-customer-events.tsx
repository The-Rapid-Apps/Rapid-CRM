import type { ActionFunctionArgs } from "react-router";
import { apiError } from "~/lib/api-auth.server";
import { env } from "~/lib/env.server";
import { runCustomerEventsCron } from "~/lib/customer-events/cron.server";

/**
 * POST /api/flex/cron/customer-events
 *
 * Polls the Partner API app-events feed for account-lifecycle events
 * (install/reinstall/uninstall/reactivate/deactivate) across every live app
 * and derives clean events from them.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");

  if (request.headers.get("x-cron-secret") !== env.CRON_SECRET) {
    return apiError(401, "Invalid cron secret");
  }

  const summary = await runCustomerEventsCron();
  const unusable =
    summary.appsProcessed === 0 ||
    summary.appsSkipped === summary.appsProcessed ||
    summary.errors === summary.appsProcessed;
  return Response.json(summary, {
    status: unusable ? 503 : summary.complete ? 200 : 202,
    headers: {
      "Cache-Control": "no-store",
      ...(!summary.complete && !unusable ? { "Retry-After": "60" } : {}),
    },
  });
}
