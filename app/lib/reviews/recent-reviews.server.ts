import { prisma } from "~/lib/db.server";
import {
  REVIEW_WINDOW_DAYS,
  reviewWindowStart,
  type RecentReview,
} from "./reviews.shared";

/** Every review of these apps in the card's widest window (30 days), newest
 * first. The card filters narrower windows in the browser. */
export async function getRecentReviews(
  appIds: string[],
  now = new Date(),
): Promise<RecentReview[]> {
  if (appIds.length === 0) return [];
  const rows = await prisma.appReview.findMany({
    where: {
      appId: { in: appIds },
      reviewedAt: { gte: reviewWindowStart(Math.max(...REVIEW_WINDOW_DAYS), now) },
    },
    /* Same-day reviews carry no time; the listing's ids only grow, so the
       higher id is the later review. */
    orderBy: [{ reviewedAt: "desc" }, { platformReviewId: "desc" }],
    select: { id: true, appId: true, rating: true, body: true, reviewerName: true, reviewedAt: true },
    take: 500,
  });
  return rows.map((row) => ({ ...row, reviewedAt: row.reviewedAt.toISOString() }));
}
