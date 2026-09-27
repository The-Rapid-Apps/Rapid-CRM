import type { Route } from "./+types/reviews.export";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { toCsv } from "~/lib/csv";
import { parseReviewFilters } from "~/lib/reviews/review-filters";
import { getFilteredReviews } from "~/lib/reviews/reviews-page.server";

/** GET /app/reviews/export — the Reviews page's filtered rows as CSV. Every
 * matching review, not just the page on screen. */
export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const filters = parseReviewFilters(new URL(request.url).searchParams);
  const { apps, appId, rows } = await getFilteredReviews(org.id, filters);
  const appNames = new Map(apps.map((app) => [app.id, app.name]));

  const csv = toCsv([
    ["Date", "App", "Customer", "Shop domain", "Shopify plan", "Rating", "Content", "Time spent using app", "Developer reply"],
    ...rows.map((row) => [
      row.reviewedAt.slice(0, 10),
      appNames.get(row.appId) ?? "",
      row.reviewerName,
      row.shopDomain,
      row.shopifyPlan,
      row.rating,
      row.body,
      row.timeUsingApp,
      row.replyBody,
    ]),
  ]);
  const scope = apps.find((app) => app.id === appId)?.appStoreHandle ?? "all-apps";
  const filename = `reviews-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
  // The BOM makes Excel read UTF-8: review text is full of accents and emoji.
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
