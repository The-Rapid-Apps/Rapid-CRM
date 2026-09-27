import type { ActionFunctionArgs } from "react-router";
import { apiError } from "~/lib/api-auth.server";
import { hasValidCronSecret } from "~/lib/cron-auth.server";
import { prisma } from "~/lib/db.server";
import { syncOrganizationLiveDiscountChecks } from "~/lib/shopify/partner-live-discount.server";

/**
 * POST /api/flex/cron/live-discount-check
 *
 * Resolves the (small, bounded) set of MRR-ambiguous or gone-quiet charges
 * against Shopify's live Partner API data, so the real state is reflected
 * within one cron cycle instead of waiting for a full billing cycle to
 * confirm it naturally. See `app/lib/shopify/partner-live-discount.server.ts`
 * for the full design.
 *
 * Bounded per invocation (found the hard way 2026-09-02: an unbounded first
 * run against a real backlog timed out the reverse proxy and got its
 * in-flight connection killed outright, well before it could finish) — same
 * 202-means-call-again convention as `cron-subscription-events.tsx`.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return apiError(405, "Method not allowed");
  if (!hasValidCronSecret(request)) {
    return apiError(401, "Invalid cron secret");
  }

  const organizations = await prisma.organization.findMany({
    select: { id: true },
  });
  const results = [];
  let hasMore = false;
  for (const organization of organizations) {
    const result = await syncOrganizationLiveDiscountChecks(organization.id);
    if (result.hasMore) hasMore = true;
    results.push({ organizationId: organization.id, ...result });
  }

  return Response.json(
    { checkedAt: new Date().toISOString(), hasMore, organizations: results },
    {
      // 202 tells the caller there's still a backlog and it should call
      // again — same convention cron-subscription-events.tsx already uses.
      status: hasMore ? 202 : 200,
      headers: {
        "Cache-Control": "no-store",
        ...(hasMore ? { "Retry-After": "5" } : {}),
      },
    },
  );
}
