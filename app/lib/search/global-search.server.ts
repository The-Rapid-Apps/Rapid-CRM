import { prisma } from "~/lib/db.server";
import { REPORT_META, REPORTS } from "~/lib/reports/report-catalog";
import {
  resolveCustomerNames,
  resolveDomainsMatchingNameOrWebsite,
} from "~/lib/customer-name.server";

/**
 * Workspace search behind the top bar's box.
 *
 * Shaped from Mantle's own behaviour, observed directly rather than guessed:
 *
 *   - case-insensitive SUBSTRING match, no fuzzy matching (Mantle returns
 *     nothing for a misspelled store name)
 *   - results grouped into typed tabs that carry their own counts, ordered by
 *     count descending, with zero-count groups still listed
 *   - customers ranked by LIFETIME VALUE descending, not by relevance or
 *     recency — confirmed across two wide searches
 *   - ten hits per group
 *
 * One deliberate divergence:
 *   - we ALSO match a shop's website, not just its name and domain
 *
 * Mantle's AI ("Ask about…", "Searching with A.I.") is deliberately absent.
 */

/** Mantle's per-group cap, matched exactly. */
const GROUP_LIMIT = 10;

export type SearchGroupKey =
  | "customers"
  | "contacts"
  | "plans"
  | "reports";

export interface SearchHit {
  id: string;
  title: string;
  /** Second line — email, domain, whatever identifies the row. */
  subtitle: string | null;
  /** Trailing metric line, e.g. "LTV: $15.00 • MRR: $15.00". */
  meta: string | null;
  url: string;
}

export interface SearchGroup {
  key: SearchGroupKey;
  label: string;
  /** Hits found, which is `hits.length` — capped at GROUP_LIMIT, so a group
   * at the cap means "at least this many". */
  count: number;
  hits: SearchHit[];
}

const GROUP_LABELS: Record<SearchGroupKey, string> = {
  customers: "Customers",
  contacts: "Contacts",
  plans: "Plans",
  reports: "Reports",
};

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

/**
 * One customer row per SHOP, not per (app, shop).
 *
 * `PartnerCustomerState` is keyed by both, so a shop installed on three apps
 * is three rows there — Mantle shows it once, with an icon per app. LTV/MRR
 * are summed across the apps so the ranking reflects the whole relationship
 * rather than whichever app happened to sort first.
 */
async function searchCustomers(
  q: string,
  appIds: string[],
): Promise<SearchGroup> {
  const hits: SearchHit[] = [];
  if (appIds.length > 0) {
    const nameMatched = await resolveDomainsMatchingNameOrWebsite(q);
    const rows = await prisma.partnerCustomerState.findMany({
      where: {
        appId: { in: appIds },
        OR: [
          { shopDomain: { contains: q } },
          ...(nameMatched.length > 0
            ? [{ shopDomain: { in: nameMatched } }]
            : []),
        ],
      },
      select: {
        shopDomain: true,
        appId: true,
        mrr: true,
        lifetimeValue: true,
      },
      /* Over-fetch, then fold by shop: the cap applies to SHOPS, and taking
         10 here would cap (app, shop) pairs instead — a shop on three apps
         would eat three of the ten slots. Approximate at the boundary, since
         a shop whose per-app rows all sit below this cut can't be promoted by
         summing them; 5x the cap makes that vanishingly unlikely and keeps
         the query bounded. */
      orderBy: { lifetimeValue: "desc" },
      take: GROUP_LIMIT * 5,
    });

    const byShop = new Map<
      string,
      { mrr: number; ltv: number; appIds: string[] }
    >();
    for (const row of rows) {
      const entry = byShop.get(row.shopDomain) ?? {
        mrr: 0,
        ltv: 0,
        appIds: [],
      };
      entry.mrr += Number(row.mrr);
      entry.ltv += Number(row.lifetimeValue);
      entry.appIds.push(row.appId);
      byShop.set(row.shopDomain, entry);
    }

    const names = await resolveCustomerNames([...byShop.keys()]);

    for (const [shopDomain, totals] of [...byShop.entries()]
      .sort((a, b) => b[1].ltv - a[1].ltv)
      .slice(0, GROUP_LIMIT)) {
      hits.push({
        id: shopDomain,
        title: names.get(shopDomain) ?? shopDomain.replace(/\.myshopify\.com$/, ""),
        subtitle: shopDomain,
        meta: `LTV: ${money(totals.ltv)} • MRR: ${money(totals.mrr)}`,
        url: `/app/customers/${encodeURIComponent(shopDomain)}?app=${encodeURIComponent(totals.appIds[0] ?? "")}`,
      });
    }
  }
  return {
    key: "customers",
    label: GROUP_LABELS.customers,
    count: hits.length,
    hits,
  };
}

/**
 * The PERSON behind a shop, which Mantle lists separately from the shop
 * itself — searching "Fovello" returns both a Customer row and a Contact row
 * for the same merchant. `IdentifiedCustomer` is our equivalent: it's the only
 * place an email for a merchant lives.
 */
async function searchContacts(q: string): Promise<SearchGroup> {
  const rows = await prisma.identifiedCustomer.findMany({
    where: {
      platform: "shopify",
      OR: [{ name: { contains: q } }, { email: { contains: q } }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      myshopifyDomain: true,
    },
    /* No LTV here to rank by, so newest-known wins — the same "newest
       identify wins" rule resolveCustomerNames applies. */
    orderBy: { updatedAt: "desc" },
    take: GROUP_LIMIT,
  });

  const hits: SearchHit[] = rows.map((row) => ({
    id: row.id,
    title: row.name?.trim() || row.email || "Unknown contact",
    subtitle: [row.email, row.myshopifyDomain].filter(Boolean).join(" • ") || null,
    meta: null,
    url: row.myshopifyDomain
      ? `/app/customers/${encodeURIComponent(row.myshopifyDomain)}`
      : "/app/customers",
  }));

  return {
    key: "contacts",
    label: GROUP_LABELS.contacts,
    count: hits.length,
    hits,
  };
}

/**
 * Plans as Shopify actually charges them, not our local `Plan` catalogue.
 *
 * Mantle lists "Monthly Plan • $6.99/mo", which is an OBSERVED plan — the
 * (name, price) pairs its charge feed carries. Our own `Plan` rows are flex
 * plans and number in single digits, so searching them would find nothing a
 * merchant recognises.
 *
 * `buildObservedPlans` is the real derivation but folds every charge an app
 * ever had (seconds), so this groups the charge events directly: measured
 * a few hundred ms against a six-figure row count, versus seconds once a
 * sale-fact join is added
 * for the billing interval.
 *
 * Which is why the link carries NO `interval` param: it lives on sale facts,
 * not charge events, and resolving it here is the entire cost. The detail
 * page resolves it instead, scoped to one plan — see its loader. Passing a
 * guess would send the ~1% of ANNUAL plans to a page describing a monthly one.
 */
async function searchPlans(
  q: string,
  appIds: string[],
): Promise<SearchGroup> {
  const hits: SearchHit[] = [];
  if (appIds.length > 0) {
    const rows = await prisma.partnerSubscriptionEvent.groupBy({
      by: ["appId", "chargeName", "amount"],
      _count: { _all: true },
      where: { appId: { in: appIds }, chargeName: { contains: q } },
      orderBy: { _count: { chargeName: "desc" } },
      take: GROUP_LIMIT,
    });
    for (const row of rows) {
      const amount = Number(row.amount);
      const params = new URLSearchParams({
        appId: row.appId,
        plan: row.chargeName,
        amount: String(amount),
      });
      hits.push({
        id: `${row.appId}␟${row.chargeName}␟${amount}`,
        title: `${row.chargeName} • ${money(amount)}`,
        subtitle: `${row._count._all.toLocaleString()} charge events`,
        meta: null,
        url: `/app/plans/observed?${params}`,
      });
    }
  }
  return { key: "plans", label: GROUP_LABELS.plans, count: hits.length, hits };
}

/**
 * The report index itself. No query at all — it's a fixed catalogue, matched
 * on label and description so "churn" finds the Churn report and "trial"
 * finds Trials, whose label says nothing about trials being searched for.
 */
function searchReports(q: string): SearchGroup {
  const needle = q.toLowerCase();
  const hits: SearchHit[] = REPORTS.filter((key) => {
    const meta = REPORT_META[key];
    return `${meta.label} ${meta.description} ${key}`
      .toLowerCase()
      .includes(needle);
  })
    .slice(0, GROUP_LIMIT)
    .map((key) => ({
      id: key,
      title: REPORT_META[key].label,
      subtitle: REPORT_META[key].description,
      meta: null,
      url: `/app/reports?report=${key}`,
    }));
  return {
    key: "reports",
    label: GROUP_LABELS.reports,
    count: hits.length,
    hits,
  };
}

/**
 * Every group, ordered by hit count descending (Mantle's tab order), with
 * empty groups kept so the tab strip doesn't reshuffle its membership as you
 * type — only its order.
 */
export async function globalSearch(params: {
  q: string;
  organizationId: string;
  appIds: string[];
}): Promise<SearchGroup[]> {
  const q = params.q.trim();
  if (!q) return [];

  const groups = await Promise.all([
    searchCustomers(q, params.appIds),
    searchContacts(q),
    searchPlans(q, params.appIds),
    Promise.resolve(searchReports(q)),
  ]);

  return groups.sort((a, b) => b.count - a.count);
}
