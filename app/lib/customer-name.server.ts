import { prisma } from "~/lib/db.server";

/**
 * Display names for merchants, keyed by shop domain.
 *
 * The name lives in `IdentifiedCustomer`, written by `POST /v1/identify` and
 * joined on `myshopifyDomain` — the identify app id is a separate id space
 * from the platform `App`, so the shop domain is the only reliable key. Same
 * join `customer-detail.tsx` already uses for custom fields.
 *
 * Returns the STORE name ("Vino and Friends", "PB & J"), which is what Mantle
 * lists and what `name`/`customFields.name` hold. `shop_owner` is the person
 * behind the store and is deliberately not preferred: a list of merchants
 * reads better as the businesses than as their owners' names, and it is what
 * the customer's own page is titled with.
 *
 * TWO SOURCES, in this order:
 *
 *   1. `IdentifiedCustomer` — what the merchant's own app told us. Richer, but
 *      it depends on an integration that may only reach some shops.
 *   2. `AppInstall.shopName` — the store name off the Partner events feed,
 *      which we poll for every shop regardless of that integration.
 *
 * Identify wins where both exist: it is the name the merchant supplied about
 * themselves, where the Partner feed's is whatever the storefront is called.
 *
 * Callers MUST still keep a `?? shopDomain` fallback: the Partner name is only
 * captured from the moment that column shipped, so a shop with no event since
 * then has neither source.
 */
export async function resolveCustomerNames(
  shopDomains: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(shopDomains.filter(Boolean))];
  if (wanted.length === 0) return out;

  const [identified, installs] = await Promise.all([
    /* Ordered oldest-first so a newer identify overwrites an older one as the
       loop goes — the same "newest wins" rule the customer page applies,
       without needing a per-shop query. */
    prisma.identifiedCustomer.findMany({
      where: { platform: "shopify", myshopifyDomain: { in: wanted } },
      orderBy: { updatedAt: "asc" },
      select: { myshopifyDomain: true, name: true, customFields: true },
    }),
    /* One shop can be installed on several apps and each carries its own copy
       of the name; any of them answers the question, so the newest install
       wins rather than an arbitrary row. */
    prisma.appInstall.findMany({
      where: { shopDomain: { in: wanted }, shopName: { not: null } },
      orderBy: { installedAt: "asc" },
      select: { shopDomain: true, shopName: true },
    }),
  ]);

  // Partner names first, so an identify name overwrites one below it.
  for (const row of installs) {
    const name = row.shopName?.trim();
    if (name) out.set(row.shopDomain, name);
  }
  for (const row of identified) {
    if (!row.myshopifyDomain) continue;
    const name = pickName(row.name, row.customFields);
    if (name) out.set(row.myshopifyDomain, name);
  }
  return out;
}

function pickName(name: string | null, customFields: unknown): string | null {
  const fields =
    customFields && typeof customFields === "object" && !Array.isArray(customFields)
      ? (customFields as Record<string, unknown>)
      : {};

  for (const candidate of [name, fields.name, fields.shop_owner]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    /* The identify endpoint writes "Shop <domain>" as a placeholder when the
       caller sends no name. Showing that instead of the domain is strictly
       worse — it is the domain, with a word in front of it. */
    if (/^shop\s+\S+\.myshopify\.com$/i.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/** The label for one merchant: their store name, else the bare shop. */
export function customerLabel(
  shopDomain: string,
  names: Map<string, string>,
): string {
  return names.get(shopDomain) ?? shopDomain.replace(/\.myshopify\.com$/, "");
}

/**
 * Shop domains whose STORE NAME or WEBSITE matches `q`, for the Customers
 * search box. The box used to match `shopDomain` alone, which meant searching
 * a merchant by the name or the website you actually know them by returned
 * nothing.
 *
 * Four fields, mirroring what the list can show:
 *   - `IdentifiedCustomer.name`                    store name
 *   - `IdentifiedCustomer.email`                   the merchant's email — what
 *     support usually has in hand when a merchant writes in
 *   - `IdentifiedCustomer.customFields.domain`     the storefront website
 *     (e.g. "fovello.com") — NOT `store_url`, which is just the myshopify
 *     domain again and so adds nothing over the caller's own domain match.
 *   - `AppInstall.shopName`                        store name off the Partner
 *     feed, thin today (only a small share of installs carry one) but it fills in
 *     as that capture backfills.
 *
 * Resolved to a domain list rather than joined into the caller's query on
 * purpose: neither `identified_customers.myshopifyDomain` nor
 * `app_installs.shopDomain` leads an index, so a correlated EXISTS would
 * re-scan per candidate row. Two one-off scans measured 28-47ms together,
 * and the caller's result is Redis-cached anyway.
 *
 * Unbounded by design — the widest realistic term ("a") resolves to ~5.4k
 * domains, which is a fine IN list. A cap would silently drop matches, which
 * is worse than a large list for a search box.
 */
export async function resolveDomainsMatchingNameOrWebsite(
  q: string,
): Promise<string[]> {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term}%`;

  const [identified, installs] = await Promise.all([
    prisma.$queryRaw<Array<{ shopDomain: string | null }>>`
      SELECT DISTINCT myshopifyDomain AS shopDomain
      FROM identified_customers
      WHERE platform = 'shopify'
        AND myshopifyDomain IS NOT NULL
        AND (
          name LIKE ${like}
          OR email LIKE ${like}
          OR JSON_UNQUOTE(JSON_EXTRACT(customFields, '$.domain')) LIKE ${like}
        )`,
    prisma.$queryRaw<Array<{ shopDomain: string | null }>>`
      SELECT DISTINCT shopDomain
      FROM app_installs
      WHERE shopName LIKE ${like}`,
  ]);

  const domains = new Set<string>();
  for (const row of [...identified, ...installs]) {
    if (row.shopDomain) domains.add(row.shopDomain);
  }
  return [...domains];
}
