import { prisma } from "~/lib/db.server";
import { logger } from "~/lib/logger.server";
import {
  parseReviewsPage,
  type ParsedReview,
  type ParsedReviewsPage,
} from "./app-store-reviews-page";

/**
 * Collects each app's reviews from its public App Store listing into
 * `AppReview`. Driven by the `app-reviews` sync lane every 5 minutes.
 *
 * Two jobs per app:
 * - Recent: read from page 1 (newest first) until a page holds nothing new —
 *   usually one request. Skipped while the last check is under
 *   `RECENT_INTERVAL_MS` old, so the listing sees a few requests an hour.
 * - Backfill: the one-time full read, `BACKFILL_PAGES_PER_TICK` pages per
 *   tick, resuming from `reviewsBackfillNextPage`. Resuming by page number is
 *   safe on a newest-first list: new reviews only push older ones to LATER
 *   pages, so a resumed read can see a review twice but never skip one.
 *
 * Reviews are upserted by the listing's own id and never deleted: one that
 * later leaves the listing (Shopify archives some) is kept.
 */

const log = logger.scope("app-reviews");

const LISTING_BASE = "https://apps.shopify.com";
const RECENT_INTERVAL_MS = 30 * 60_000;
/** How often the full re-read runs, to notice reviews that left the listing. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
/** A sweep that saw fewer reviews than this share of the listing's own count
 * archives nothing: a short read must not look like mass removal. */
const SWEEP_MIN_COVERAGE = 0.9;
const RECENT_MAX_PAGES = 5;
const BACKFILL_PAGES_PER_TICK = 10;
/** Between page requests: this is someone else's website. */
const PAGE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class ListingNotFoundError extends Error {
  constructor(handle: string) {
    super(`No App Store listing at ${LISTING_BASE}/${handle} — check the app's App Store handle.`);
    this.name = "ListingNotFoundError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function reviewsPageUrl(handle: string, page: number): string {
  return `${LISTING_BASE}/${encodeURIComponent(handle)}/reviews?sort_by=newest&page=${page}`;
}

/** One listing page, retried once on a rate limit, server error or timeout. */
async function fetchReviewsPage(
  handle: string,
  page: number,
): Promise<ParsedReviewsPage> {
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(reviewsPageUrl(handle, page), {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; RapidReviews/1.0)",
          "Accept-Language": "en",
        },
      });
      if (response.status === 404) throw new ListingNotFoundError(handle);
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000);
        continue;
      }
      if (!response.ok) {
        throw new Error(`App Store answered ${response.status} for ${handle} page ${page}`);
      }
      return parseReviewsPage(await response.text());
    } catch (error) {
      // A single slow response shouldn't cost the app its whole tick.
      if (controller.signal.aborted && attempt < 2) {
        await sleep(5_000);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Upserts a page's reviews; returns how many were new. */
async function storeReviews(appId: string, reviews: ParsedReview[]): Promise<number> {
  if (reviews.length === 0) return 0;
  const known = new Set(
    (
      await prisma.appReview.findMany({
        where: { appId, platformReviewId: { in: reviews.map((r) => r.platformReviewId) } },
        select: { platformReviewId: true },
      })
    ).map((row) => row.platformReviewId),
  );
  const now = new Date();
  for (const review of reviews) {
    // Edited reviews change text or rating under the same id, so existing rows
    // are refreshed, not just skipped.
    await prisma.appReview.upsert({
      where: { appId_platformReviewId: { appId, platformReviewId: review.platformReviewId } },
      create: { appId, ...review, firstSeenAt: now, lastSeenAt: now },
      update: {
        rating: review.rating,
        body: review.body,
        reviewerName: review.reviewerName,
        reviewerCountry: review.reviewerCountry,
        timeUsingApp: review.timeUsingApp,
        replyBody: review.replyBody,
        reviewedAt: review.reviewedAt,
        edited: review.edited,
        lastSeenAt: now,
        // On the listing, so not archived — even if it once was.
        archivedAt: null,
      },
    });
  }
  return reviews.filter((review) => !known.has(review.platformReviewId)).length;
}

export interface AppReviewsSyncResult {
  appId: string;
  pagesRead: number;
  newReviews: number;
  backfillComplete: boolean;
  /** Reviews found gone from the listing by a sweep that finished this tick. */
  archived?: number;
  skipped?: "recent";
  error?: string;
}

export async function syncAppReviews(
  appId: string,
  now = new Date(),
): Promise<AppReviewsSyncResult> {
  const app = await prisma.app.findUniqueOrThrow({
    where: { id: appId },
    select: {
      appStoreHandle: true,
      reviewsSyncedAt: true,
      reviewsBackfillNextPage: true,
      reviewsBackfillCompletedAt: true,
      reviewsSweepStartedAt: true,
      appStoreReviewCount: true,
    },
  });
  const handle = app.appStoreHandle!;
  const result: AppReviewsSyncResult = {
    appId,
    pagesRead: 0,
    newReviews: 0,
    backfillComplete: Boolean(app.reviewsBackfillCompletedAt),
  };

  let headline: Pick<ParsedReviewsPage, "ratingValue" | "ratingCount"> | null = null;
  const readPage = async (page: number) => {
    if (result.pagesRead > 0) await sleep(PAGE_DELAY_MS);
    const parsed = await fetchReviewsPage(handle, page);
    result.pagesRead += 1;
    if (page === 1) {
      headline = parsed;
      // A listing that says it has reviews but shows none on its first page
      // is a page we no longer understand — not an app with no reviews.
      if (parsed.reviews.length === 0 && (parsed.ratingCount ?? 0) > 0) {
        throw new Error(
          `${handle}: listing reports ${parsed.ratingCount} reviews but none parsed — page layout may have changed`,
        );
      }
    }
    result.newReviews += await storeReviews(appId, parsed.reviews);
    return parsed;
  };

  /* The full read doubles as the archive sweep: once a day it starts again at
     page 1, and a review not seen by the time it finishes has left the
     listing. The first-ever full read counts as a sweep too. */
  let backfillNextPage = app.reviewsBackfillNextPage ?? 1;
  let sweepStartedAt = app.reviewsSweepStartedAt;
  const sweepData: { reviewsSweepStartedAt?: Date; reviewsBackfillCompletedAt?: null } = {};
  const sweepDue =
    app.reviewsBackfillCompletedAt !== null &&
    now.getTime() - app.reviewsBackfillCompletedAt.getTime() >= SWEEP_INTERVAL_MS;
  if (sweepDue || (!result.backfillComplete && (!sweepStartedAt || backfillNextPage === 1))) {
    result.backfillComplete = false;
    backfillNextPage = app.reviewsBackfillNextPage && !sweepDue ? app.reviewsBackfillNextPage : 1;
    sweepStartedAt = now;
    sweepData.reviewsSweepStartedAt = now;
    if (sweepDue) sweepData.reviewsBackfillCompletedAt = null;
  }

  const recentDue =
    (!app.reviewsSyncedAt ||
      now.getTime() - app.reviewsSyncedAt.getTime() >= RECENT_INTERVAL_MS) &&
    // A full read still at page 1 is about to read the newest pages anyway.
    !(!result.backfillComplete && backfillNextPage === 1);

  if (recentDue) {
    for (let page = 1; page <= RECENT_MAX_PAGES; page += 1) {
      const before = result.newReviews;
      const parsed = await readPage(page);
      if (!parsed.hasNextPage || result.newReviews === before) break;
    }
  } else if (result.backfillComplete) {
    return { ...result, skipped: "recent" };
  }

  const data: {
    reviewsSyncedAt?: Date;
    reviewsBackfillNextPage?: number | null;
    reviewsBackfillCompletedAt?: Date | null;
    reviewsSweepStartedAt?: Date;
    appStoreRating?: number | null;
    appStoreReviewCount?: number | null;
  } = { ...sweepData };
  if (recentDue) data.reviewsSyncedAt = now;

  let sweepFinished = false;
  if (!result.backfillComplete) {
    let page = backfillNextPage;
    for (let read = 0; read < BACKFILL_PAGES_PER_TICK; read += 1, page += 1) {
      const parsed = await readPage(page);
      if (!parsed.hasNextPage) {
        result.backfillComplete = true;
        sweepFinished = true;
        data.reviewsBackfillCompletedAt = now;
        data.reviewsBackfillNextPage = null;
        break;
      }
    }
    if (!result.backfillComplete) data.reviewsBackfillNextPage = page;
  }

  const readHeadline = headline as Pick<ParsedReviewsPage, "ratingValue" | "ratingCount"> | null;
  if (readHeadline) {
    data.appStoreRating = readHeadline.ratingValue;
    data.appStoreReviewCount = readHeadline.ratingCount;
  }
  if (sweepFinished && sweepStartedAt) {
    result.archived = await archiveUnseenReviews(
      appId,
      sweepStartedAt,
      readHeadline?.ratingCount ?? app.appStoreReviewCount,
      now,
    );
  }
  await prisma.app.update({ where: { id: appId }, data });
  return result;
}

/**
 * Marks as archived every review a finished sweep did not see. Refuses when
 * the sweep saw clearly fewer reviews than the listing says it has — that is
 * a short read (a hiccup, a changed page), not hundreds of removals.
 */
async function archiveUnseenReviews(
  appId: string,
  sweepStartedAt: Date,
  listingCount: number | null,
  now: Date,
): Promise<number> {
  const seen = await prisma.appReview.count({
    where: { appId, lastSeenAt: { gte: sweepStartedAt } },
  });
  if (listingCount && seen < listingCount * SWEEP_MIN_COVERAGE) {
    log.warn("sweep saw too few reviews to judge archiving; skipped", {
      appId,
      seen,
      listingCount,
    });
    return 0;
  }
  const { count } = await prisma.appReview.updateMany({
    where: { appId, archivedAt: null, lastSeenAt: { lt: sweepStartedAt } },
    data: { archivedAt: now },
  });
  if (count > 0) log.info("reviews left the listing", { appId, archived: count });
  return count;
}

export interface AppReviewsCronSummary {
  appsProcessed: number;
  /** True when every app's one-time full read has finished. */
  complete: boolean;
  results: AppReviewsSyncResult[];
  errors: Array<{ appId: string; error: string }>;
}

/** Every live app with an App Store handle, one after another (politeness
 * matters more than speed here). One app's failure never stops the rest. */
export async function runAppReviewsCron(now = new Date()): Promise<AppReviewsCronSummary> {
  const apps = await prisma.app.findMany({
    where: { removed: false, appStoreHandle: { not: null } },
    select: { id: true, appStoreHandle: true },
    orderBy: { createdAt: "asc" },
  });
  const summary: AppReviewsCronSummary = {
    appsProcessed: apps.length,
    complete: true,
    results: [],
    errors: [],
  };
  for (const app of apps) {
    try {
      const result = await syncAppReviews(app.id, now);
      summary.results.push(result);
      if (!result.backfillComplete) summary.complete = false;
      if (result.newReviews > 0) {
        log.info("new reviews", { handle: app.appStoreHandle, newReviews: result.newReviews });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({ appId: app.id, error: message });
      log.error("sync failed", { handle: app.appStoreHandle, error: message });
    }
  }
  return summary;
}
