import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "~/lib/db.server";
import { cachedWithRedis } from "~/lib/cache/redis-cache.server";
import {
  applyReviewFilters,
  shopifyPlanLabel,
  type ReviewFilters,
  type ReviewRow,
} from "./review-filters";

/**
 * Rows for the Reviews page: every stored review of the given apps, each
 * matched to one of our customers where the store name allows it.
 *
 * A review imported from Mantle carries its store (`AppReview.shopDomain`) and
 * that wins. Otherwise the listing gives only a store NAME, so a review is
 * linked when that name belongs to exactly one store that installed the app.
 * Names come from `AppInstall.shopName`, `IdentifiedCustomer` and — the only
 * name most stores have — `ShopProfile` (Mantle's Customers export).
 *
 * Measured 2026-09-25 by hiding the known store of every Mantle-linked review
 * and matching blind: Rapid Bundle found 79% with 0.7% wrong, Tracking 75% and
 * Cart 88% with none wrong. Two rules that lost:
 * - Also requiring the install date to fit "N months using the app": 0.2%
 *   wrong but only 56% found — install dates are too imprecise to require.
 * - Breaking name ties by install date: +4 points found, ~4x the errors.
 * (Before Mantle's names, name-only was 25% wrong: with most stores unnamed,
 * a generic name like "Ma boutique" matched the one store we had a name for.
 * Dense names are what make it safe — a generic name now matches many stores
 * and is never "exactly one".)
 *
 * Whole-app loads are fine at today's size (Rapid Bundle: ~1,600 reviews);
 * filtering and paging happen on the result.
 */

const normalizeName = (name: string) =>
  name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** Chunks an IN list; MySQL's placeholder limit is far above this. */
function chunks<T>(items: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Store name → the domains of this app's installs carrying it. */
async function namesToShops(appId: string, names: string[]): Promise<Map<string, Set<string>>> {
  const byName = new Map<string, Set<string>>();
  const add = (name: string | null, domain: string | null) => {
    if (!name?.trim() || !domain) return;
    const key = normalizeName(name);
    let set = byName.get(key);
    if (!set) byName.set(key, (set = new Set()));
    set.add(domain);
  };
  const lowered = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];

  for (const batch of chunks(lowered)) {
    const [installs, identified] = await Promise.all([
      prisma.appInstall.findMany({
        where: { appId, shopName: { in: batch } },
        select: { shopName: true, shopDomain: true },
      }),
      /* customFields.name is JSON; JSON strings compare case-sensitively, hence
         LOWER on both sides. A 26k-row scan, measured well under a second. */
      prisma.$queryRaw<Array<{ domain: string; name: string | null; fieldName: string | null }>>`
        SELECT myshopifyDomain AS domain, name,
               JSON_UNQUOTE(JSON_EXTRACT(customFields, '$.name')) AS fieldName
        FROM identified_customers
        WHERE platform = 'shopify' AND myshopifyDomain IS NOT NULL
          AND (LOWER(name) IN (${Prisma.join(batch)})
               OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(customFields, '$.name'))) IN (${Prisma.join(batch)}))`,
    ]);
    for (const row of installs) add(row.shopName, row.shopDomain);

    /* Mantle's store names — the only name most shops have (108k of our
       installs carry none). Case-insensitive via the column's collation. */
    const profiles = await prisma.shopProfile.findMany({
      where: { name: { in: batch } },
      select: { shopDomain: true, name: true },
    });

    // Identify records and profiles are any shop's; keep only shops that
    // installed THIS app.
    const candidates = [
      ...new Set([...identified.map((row) => row.domain), ...profiles.map((row) => row.shopDomain)]),
    ];
    const installedHere = new Set(
      candidates.length === 0
        ? []
        : (
            await prisma.appInstall.findMany({
              where: { appId, shopDomain: { in: candidates } },
              select: { shopDomain: true },
            })
          ).map((row) => row.shopDomain),
    );
    for (const row of identified) {
      if (!installedHere.has(row.domain)) continue;
      add(row.name, row.domain);
      add(row.fieldName, row.domain);
    }
    for (const row of profiles) {
      if (installedHere.has(row.shopDomain)) add(row.name, row.shopDomain);
    }
  }
  return byName;
}

/**
 * Each shop's Shopify plan, from whichever source is most recent: an identify
 * record (the store's own app reporting it, dated by `updatedAt`) or a
 * `ShopProfile` (Mantle's snapshot, dated by `asOf`). Plans change — a store
 * upgrades, pauses — so the newer report wins, not a fixed source order.
 */
async function plansForShops(domains: string[]): Promise<Map<string, string>> {
  const newest = new Map<string, { label: string; at: number }>();
  const offer = (domain: string, raw: string | null, at: Date) => {
    const label = shopifyPlanLabel(raw === "null" ? null : raw);
    if (!label) return;
    const current = newest.get(domain);
    if (!current || at.getTime() >= current.at) newest.set(domain, { label, at: at.getTime() });
  };
  for (const batch of chunks(domains)) {
    const [identified, profiles] = await Promise.all([
      prisma.$queryRaw<Array<{ domain: string; plan: string | null; updatedAt: Date }>>`
        SELECT myshopifyDomain AS domain, updatedAt,
               JSON_UNQUOTE(JSON_EXTRACT(customFields, '$.shopify_plan_name')) AS plan
        FROM identified_customers
        WHERE myshopifyDomain IN (${Prisma.join(batch)})`,
      prisma.shopProfile.findMany({
        where: { shopDomain: { in: batch }, shopifyPlan: { not: null } },
        select: { shopDomain: true, shopifyPlan: true, asOf: true },
      }),
    ]);
    for (const row of identified) offer(row.domain, row.plan, row.updatedAt);
    for (const row of profiles) offer(row.shopDomain, row.shopifyPlan, row.asOf);
  }
  return new Map([...newest].map(([domain, { label }]) => [domain, label]));
}

export async function loadReviewRows(appIds: string[]): Promise<ReviewRow[]> {
  if (appIds.length === 0) return [];
  const reviews = await prisma.appReview.findMany({
    where: { appId: { in: appIds } },
    orderBy: [{ reviewedAt: "desc" }, { platformReviewId: "desc" }],
    select: {
      id: true,
      appId: true,
      rating: true,
      body: true,
      reviewerName: true,
      timeUsingApp: true,
      replyBody: true,
      reviewedAt: true,
      edited: true,
      archivedAt: true,
      shopDomain: true,
    },
  });

  const matched = new Map<string, string>();
  for (const review of reviews) if (review.shopDomain) matched.set(review.id, review.shopDomain);
  for (const appId of new Set(reviews.map((review) => review.appId))) {
    const unlinked = reviews.filter((review) => review.appId === appId && !review.shopDomain);
    if (unlinked.length === 0) continue;
    const byName = await namesToShops(appId, unlinked.map((review) => review.reviewerName));
    for (const review of unlinked) {
      const shops = byName.get(normalizeName(review.reviewerName));
      if (shops?.size === 1) matched.set(review.id, [...shops][0]);
    }
  }
  const plans = await plansForShops([...new Set(matched.values())]);

  return reviews.map((review) => {
    const shopDomain = matched.get(review.id) ?? null;
    return {
      ...review,
      reviewedAt: review.reviewedAt.toISOString(),
      archivedAt: review.archivedAt?.toISOString() ?? null,
      shopDomain,
      shopifyPlan: shopDomain ? (plans.get(shopDomain) ?? null) : null,
    };
  });
}

const ROWS_CACHE_TTL_MS = 5 * 60_000;

export interface ReviewsPageApp {
  id: string;
  name: string;
  logoUrl: string | null;
  appStoreHandle: string | null;
}

/**
 * The organization's review-collecting apps and the filtered rows — shared by
 * the page and its CSV export so both show exactly the same reviews. Rows are
 * cached for 5 minutes per app set: matching is the costly part (~0.9s for
 * every app), and new reviews only arrive every 30 minutes anyway.
 */
export async function getFilteredReviews(
  organizationId: string,
  filters: ReviewFilters,
) {
  const apps: ReviewsPageApp[] = await prisma.app.findMany({
    where: { organizationId, removed: false, appStoreHandle: { not: null } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, logoUrl: true, appStoreHandle: true },
  });
  const selected = apps.find((app) => app.id === filters.appId);
  const appIds = (selected ? [selected] : apps).map((app) => app.id).sort();
  const rows = await cachedWithRedis(
    `reviews:rows:v4:${appIds.join(",")}`,
    ROWS_CACHE_TTL_MS,
    () => loadReviewRows(appIds),
  );
  return {
    apps,
    appId: selected?.id ?? "",
    /** Every plan among the loaded rows, for the Shopify plan filter. */
    plans: [...new Set(rows.map((row) => row.shopifyPlan).filter((plan): plan is string => Boolean(plan)))].sort(),
    total: rows.length,
    rows: applyReviewFilters(rows, { ...filters, appId: selected?.id ?? "" }),
  };
}
