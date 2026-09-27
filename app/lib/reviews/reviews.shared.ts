/**
 * Client-safe rules for showing App Store reviews: the date window, the rating
 * groups and the "3 days ago" wording. Kept pure so the card and its tests
 * agree on exactly which reviews "the last 7 days" means.
 */

export interface RecentReview {
  id: string;
  appId: string;
  rating: number;
  body: string;
  reviewerName: string;
  /** ISO string of the UTC day the listing shows. */
  reviewedAt: string;
}

export const REVIEW_WINDOW_DAYS = [7, 14, 30] as const;
export type ReviewWindowDays = (typeof REVIEW_WINDOW_DAYS)[number];

/** Mantle's groups. 3★ belongs to neither — it is neutral. */
export const REVIEW_RATING_FILTERS = {
  all: { label: "All ratings", matches: () => true },
  negative: { label: "Negative (1–2 stars)", matches: (rating: number) => rating <= 2 },
  positive: { label: "Positive (4–5 stars)", matches: (rating: number) => rating >= 4 },
} as const;
export type ReviewRatingFilter = keyof typeof REVIEW_RATING_FILTERS;

const DAY_MS = 86_400_000;

function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Whole days between the review's day and today; 0 is today. The listing
 * publishes a day, not a time, so this is day arithmetic, never hours. */
export function reviewDaysAgo(reviewedAt: string, now: Date): number {
  return Math.max(0, Math.round((utcDayStart(now) - utcDayStart(new Date(reviewedAt))) / DAY_MS));
}

export function reviewDaysAgoLabel(days: number): string {
  if (days === 0) return "Today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** "Last N days" counts today as the first of the N. */
export function reviewWindowStart(days: number, now: Date): Date {
  return new Date(utcDayStart(now) - (days - 1) * DAY_MS);
}

export function filterRecentReviews<T extends RecentReview>(
  reviews: readonly T[],
  filters: { appId: string; days: number; rating: ReviewRatingFilter },
  now: Date,
): T[] {
  const start = reviewWindowStart(filters.days, now).getTime();
  const matches = REVIEW_RATING_FILTERS[filters.rating].matches;
  return reviews.filter(
    (review) =>
      (!filters.appId || review.appId === filters.appId) &&
      new Date(review.reviewedAt).getTime() >= start &&
      matches(review.rating),
  );
}
