import type { ActionFunctionArgs } from "react-router";
import { apiError } from "~/lib/api-auth.server";
import { hasValidCronSecret } from "~/lib/cron-auth.server";
import { prisma } from "~/lib/db.server";
import { syncOrganizationPartnerSubscriptionFacts } from "~/lib/shopify/partner-subscription-sync.server";

/** POST /api/flex/cron/subscription-events */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");
  if (!hasValidCronSecret(request)) {
    return apiError(401, "Invalid cron secret");
  }

  const organizations = await prisma.organization.findMany({
    select: { id: true },
  });
  const results = [];
  for (const organization of organizations) {
    const facts = await syncOrganizationPartnerSubscriptionFacts({
      organizationId: organization.id,
      maxEventPages: 20,
      maxSalePages: 20,
    });
    results.push({
      organizationId: organization.id,
      ...facts,
      rawFactsPersisted: true,
      calculatedMetricsPersisted: false,
    });
  }
  // A finished historical backfill is not enough: the newest bounded window
  // must also have completed before the scheduler may record this run as 200.
  const complete =
    results.length > 0 &&
    results.every((result) => result.complete && result.fresh);
  const usableApps = results.reduce(
    (count, result) =>
      count + result.results.filter((appResult) => !appResult.skipped).length,
    0,
  );
  const unusable = results.length === 0 || usableApps === 0;
  return Response.json(
    {
      synchronizedAt: new Date().toISOString(),
      complete,
      organizations: results,
    },
    {
      // 202 tells the scheduler that a bounded backfill made progress but has
      // more cursor pages to consume. It is still a successful, idempotent run.
      status: unusable ? 503 : complete ? 200 : 202,
      headers: {
        "Cache-Control": "no-store",
        ...(!complete && !unusable ? { "Retry-After": "60" } : {}),
      },
    },
  );
}
