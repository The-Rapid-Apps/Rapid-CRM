import { useFilterState } from "~/lib/use-filter-state";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { Form, Link } from "react-router";
import { Prisma } from "../../../generated/prisma/client";
import type { Route } from "./+types/customers";
import { cachedWithRedis } from "~/lib/cache/redis-cache.server";
import {
  resolveCustomerNames,
  resolveDomainsMatchingNameOrWebsite,
} from "~/lib/customer-name.server";
import { AppName } from "~/components/app-identity";
import { AppPicker } from "~/components/app-picker";
import { prisma } from "~/lib/db.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { env } from "~/lib/env.server";
import { formatDateTime, formatMoney } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";

const PAGE_SIZE = 50;

/**
 * Short-TTL cache for this page's query results, same pattern as
 * subscriptions.tsx's SUBSCRIPTIONS_CACHE_TTL_MS: the grouped UNION (~430ms)
 * plus the follow-up 50-way-OR queries (current events, sale facts,
 * installs, latest sales) run on every load with zero caching today — that,
 * not any single query, is the actual root cause of the page's slowness.
 * Same freshness tradeoff already accepted for Subscriptions: fine for an
 * internal admin list to lag a couple minutes behind synced billing data.
 */
const CUSTOMERS_CACHE_TTL_MS = 2 * 60_000;
const CUSTOMERS_CACHE_KEY_PREFIX = "customers-page:";
/** Separate namespace from the live path's cache key, same reasoning as
 * subscriptions.tsx's PARTNER_STATE_CACHE_KEY_PREFIX. */
const PARTNER_STATE_CACHE_KEY_PREFIX = "customers-page-partner-state:";

type CustomerKeyRow = {
  appId: string;
  shopDomain: string;
  firstSeen: Date;
  lastActivity: Date;
  totalCount: bigint | number;
};

type CurrentEventRow = {
  appId: string;
  shopDomain: string;
  chargePlatformId: string;
  type: string;
  amount: Prisma.Decimal;
  currencyCode: string;
};

type LatestSaleRow = {
  appId: string;
  chargePlatformId: string | null;
  billingInterval: string | null;
  grossAmount: Prisma.Decimal | null;
  currencyCode: string | null;
};

interface CustomerRow {
  appId: string;
  appName: string;
  appLogoUrl: string | null;
  shopDomain: string;
  /** Store name, when either source knows one — see `resolveCustomerNames`.
   * Null keeps the row rendering exactly as it did before this existed. */
  storeName: string | null;
  firstSeen: string;
  lastActivity: string;
  activeChargeCount: number;
  attentionChargeCount: number;
  mrr: number;
  currencyCode: string;
  lifetimeValue: number;
  saleCount: number;
  oauthConnected: boolean;
}

interface CustomersPageData {
  customers: CustomerRow[];
  total: number;
}

function customerUrl(appId: string, shopDomain: string) {
  // Customer Details is now keyed by shop domain alone (one customer, tabbed
  // across every app it's installed on) — `app` just preselects which app's
  // panel shows first, since this list itself is still per-(app, shop).
  return `/app/customers/${encodeURIComponent(shopDomain)}?app=${encodeURIComponent(appId)}`;
}

function listUrl(filters: { q: string; appId: string }, page: number) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.appId) params.set("appId", filters.appId);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/app/customers?${query}` : "/app/customers";
}

function customerStatus(row: {
  activeChargeCount: number;
  attentionChargeCount: number;
}) {
  if (Number(row.activeChargeCount) > 0) {
    return { label: "Active", tone: "success" as const };
  }
  if (Number(row.attentionChargeCount) > 0) {
    return { label: "Attention", tone: "warning" as const };
  }
  return { label: "Inactive", tone: undefined };
}

/**
 * Fast path reading PartnerCustomerState directly — one plain indexed query
 * instead of the grouped UNION plus four follow-up queries above. Produces
 * the exact same `CustomersPageData` shape.
 */
async function fetchPartnerStateCustomers(params: {
  appId: string;
  q: string;
  /** Domains whose store name or website matches `q` — see
   * `resolveDomainsMatchingNameOrWebsite`. Empty when `q` is. */
  nameMatchedDomains: string[];
  offset: number;
  appNames: Map<string, string>;
  appLogos: Map<string, string | null>;
}): Promise<CustomersPageData> {
  const where = {
    ...(params.appId ? { appId: params.appId } : {}),
    ...(params.q
      ? {
          OR: [
            { shopDomain: { contains: params.q } },
            ...(params.nameMatchedDomains.length > 0
              ? [{ shopDomain: { in: params.nameMatchedDomains } }]
              : []),
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.partnerCustomerState.findMany({
      where,
      orderBy: [{ lastActivity: "desc" }, { shopDomain: "asc" }],
      take: PAGE_SIZE,
      skip: params.offset,
    }),
    prisma.partnerCustomerState.count({ where }),
  ]);

  /* Only the page's own rows, so this stays one small lookup regardless of
     how many customers the filter matched. */
  const names = await resolveCustomerNames(rows.map((row) => row.shopDomain));

  return {
    total,
    customers: rows.map((row) => ({
      appId: row.appId,
      appName: params.appNames.get(row.appId) ?? "Unknown app",
      appLogoUrl: params.appLogos.get(row.appId) ?? null,
      shopDomain: row.shopDomain,
      storeName: names.get(row.shopDomain) ?? null,
      firstSeen: row.firstSeen.toISOString(),
      lastActivity: row.lastActivity.toISOString(),
      activeChargeCount: row.activeChargeCount,
      attentionChargeCount: row.attentionChargeCount,
      mrr: Number(row.mrr),
      currencyCode: row.currencyCode,
      lifetimeValue: Number(row.lifetimeValue),
      saleCount: row.saleCount,
      oauthConnected: row.oauthConnected,
    })),
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 255);
  const requestedAppId = (url.searchParams.get("appId") ?? "").trim();
  const requestedPage = Number(url.searchParams.get("page") ?? "1");
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;

  const apps = await prisma.app.findMany({
    where: {
      organizationId: org.id,
      removed: false,
      scheduledForDeletionAt: null,
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      partnerStateBackfillCompletedAt: true,
    },
  });
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : "";
  // All-or-nothing across whatever's in scope, matching the same rule used
  // for every other read-path flag tonight (including this page's sibling,
  // subscriptions.tsx).
  const appsInScope = appId ? apps.filter((app) => app.id === appId) : apps;
  const partnerStateReady =
    env.PARTNER_STATE_READ_PATH_ENABLED &&
    appsInScope.length > 0 &&
    appsInScope.every((app) => app.partnerStateBackfillCompletedAt);
  const appNames = new Map(apps.map((app) => [app.id, app.name]));
  const appLogos = new Map(apps.map((app) => [app.id, app.logoUrl]));
  const eventAppFilter = appId
    ? Prisma.sql`AND e.appId = ${appId}`
    : Prisma.empty;
  const installAppFilter = appId
    ? Prisma.sql`AND i.appId = ${appId}`
    : Prisma.empty;
  /* The search box matches the domain OR the store name OR the website; the
     latter two live in other tables, so they're resolved to a domain list
     first (see resolveDomainsMatchingNameOrWebsite for why not a join). */
  const nameMatchedDomains = q
    ? await resolveDomainsMatchingNameOrWebsite(q)
    : [];
  const nameMatchSql = (column: Prisma.Sql) =>
    nameMatchedDomains.length > 0
      ? Prisma.sql` OR ${column} IN (${Prisma.join(nameMatchedDomains)})`
      : Prisma.empty;
  const eventSearchFilter = q
    ? Prisma.sql`AND (e.shopDomain LIKE ${`%${q}%`}${nameMatchSql(Prisma.sql`e.shopDomain`)})`
    : Prisma.empty;
  const installSearchFilter = q
    ? Prisma.sql`AND (i.shopDomain LIKE ${`%${q}%`}${nameMatchSql(Prisma.sql`i.shopDomain`)})`
    : Prisma.empty;
  const offset = (page - 1) * PAGE_SIZE;

  const cacheKeyParts = [org.id, appId, q, String(page)].join("␟");
  const redisKey = `${partnerStateReady ? PARTNER_STATE_CACHE_KEY_PREFIX : CUSTOMERS_CACHE_KEY_PREFIX}${cacheKeyParts}`;
  const { customers, total } = await cachedWithRedis(
    redisKey,
    CUSTOMERS_CACHE_TTL_MS,
    async (): Promise<CustomersPageData> => {
      if (partnerStateReady) {
        return fetchPartnerStateCustomers({
          appId,
          q,
          nameMatchedDomains,
          offset,
          appNames,
          appLogos,
        });
      }
      const customerKeysSql = Prisma.sql`
        SELECT customerRows.appId, customerRows.shopDomain,
          MIN(customerRows.firstSeen) AS firstSeen,
          MAX(customerRows.lastActivity) AS lastActivity
        FROM (
          SELECT e.appId, e.shopDomain,
            MIN(e.occurredAt) AS firstSeen,
            MAX(e.occurredAt) AS lastActivity
          FROM partner_subscription_events e
          INNER JOIN apps eventApp ON eventApp.id = e.appId
          WHERE e.test = 0
            AND eventApp.organizationId = ${org.id}
            AND eventApp.removed = 0
            AND eventApp.scheduledForDeletionAt IS NULL
            ${eventAppFilter}
            ${eventSearchFilter}
          GROUP BY e.appId, e.shopDomain
          UNION ALL
          SELECT i.appId, i.shopDomain,
            i.installedAt AS firstSeen,
            COALESCE(i.uninstalledAt, i.installedAt) AS lastActivity
          FROM app_installs i
          INNER JOIN apps installApp ON installApp.id = i.appId
          WHERE installApp.organizationId = ${org.id}
            AND installApp.removed = 0
            AND installApp.scheduledForDeletionAt IS NULL
            ${installAppFilter}
            ${installSearchFilter}
        ) customerRows
        GROUP BY customerRows.appId, customerRows.shopDomain
      `;

      // `COUNT(*) OVER()` folds the total-row-count into the same pass instead
      // of re-running the whole (fairly expensive) grouped UNION a second time
      // just to count it — this query and a separate COUNT(*) query measured
      // almost identical cost each (~430ms), so running both was pure
      // duplicate work.
      const customerKeys = await prisma.$queryRaw<CustomerKeyRow[]>(Prisma.sql`
        SELECT keyedCustomers.*, COUNT(*) OVER() AS totalCount
        FROM (${customerKeysSql}) keyedCustomers
        ORDER BY lastActivity DESC, shopDomain ASC
        LIMIT ${PAGE_SIZE}
        OFFSET ${offset}
      `);

      const total = Number(customerKeys[0]?.totalCount ?? 0);
      if (customerKeys.length === 0) {
        return { customers: [], total };
      }

      const pairFilter = Prisma.join(
        customerKeys.map(
          (customer) =>
            Prisma.sql`(e.appId = ${customer.appId} AND e.shopDomain = ${customer.shopDomain})`,
        ),
        " OR ",
      );
      const pairWhere = customerKeys.map((customer) => ({
        appId: customer.appId,
        shopDomain: customer.shopDomain,
      }));

      const currentEventsPromise = prisma.$queryRaw<CurrentEventRow[]>(Prisma.sql`
        WITH ranked AS (
          SELECT e.appId, e.shopDomain, e.chargePlatformId, e.type,
            e.amount, e.currencyCode,
            ROW_NUMBER() OVER (
              PARTITION BY e.appId, e.shopDomain, e.chargePlatformId
              ORDER BY e.occurredAt DESC, e.id DESC
            ) AS rowNumber
          FROM partner_subscription_events e
          WHERE e.test = 0
            AND (${pairFilter})
        )
        SELECT appId, shopDomain, chargePlatformId, type, amount, currencyCode
        FROM ranked
        WHERE rowNumber = 1
      `);

      const [currentEvents, lifetimeGroups, installs] = await Promise.all([
        currentEventsPromise,
        prisma.partnerSubscriptionSaleFact.groupBy({
          by: ["appId", "shopDomain", "currencyCode"],
          where: {
            OR: pairWhere,
            shopDomain: { not: null },
            grossAmount: { not: null },
          },
          _sum: { grossAmount: true },
          _count: { _all: true },
        }),
        prisma.appInstall.findMany({
          where: { OR: pairWhere },
          select: {
            appId: true,
            shopDomain: true,
            accessToken: true,
            uninstalledAt: true,
          },
        }),
      ]);

      const latestSales =
        currentEvents.length === 0
          ? []
          : await prisma.$queryRaw<LatestSaleRow[]>(Prisma.sql`
              WITH ranked AS (
                SELECT sale.appId, sale.chargePlatformId, sale.billingInterval,
                  sale.grossAmount, sale.currencyCode,
                  ROW_NUMBER() OVER (
                    PARTITION BY sale.appId, sale.chargePlatformId
                    ORDER BY sale.occurredAt DESC, sale.id DESC
                  ) AS rowNumber
                FROM partner_subscription_sale_facts sale
                WHERE ${Prisma.join(
                  currentEvents.map(
                    (event) =>
                      Prisma.sql`(sale.appId = ${event.appId} AND sale.chargePlatformId = ${event.chargePlatformId})`,
                  ),
                  " OR ",
                )}
              )
              SELECT appId, chargePlatformId, billingInterval, grossAmount, currencyCode
              FROM ranked
              WHERE rowNumber = 1
            `);

      const eventsByCustomer = new Map<string, CurrentEventRow[]>();
      for (const event of currentEvents) {
        const key = `${event.appId} ${event.shopDomain}`;
        const entries = eventsByCustomer.get(key) ?? [];
        entries.push(event);
        eventsByCustomer.set(key, entries);
      }
      const salesByCharge = new Map(
        latestSales.map((sale) => [
          `${sale.appId} ${sale.chargePlatformId}`,
          sale,
        ]),
      );
      const lifetimeByCustomer = new Map(
        lifetimeGroups.map((group) => [
          `${group.appId} ${group.shopDomain} ${group.currencyCode ?? "USD"}`,
          group,
        ]),
      );
      const installsByCustomer = new Map(
        installs.map((install) => [
          `${install.appId} ${install.shopDomain}`,
          install,
        ]),
      );

      const names = await resolveCustomerNames(
        customerKeys.map((customer) => customer.shopDomain),
      );

      const customers: CustomerRow[] = customerKeys.map((customer) => {
        const key = `${customer.appId} ${customer.shopDomain}`;
        const events = eventsByCustomer.get(key) ?? [];
        const activeEvents = events.filter((event) =>
          [
            "SUBSCRIPTION_CHARGE_ACTIVATED",
            "SUBSCRIPTION_CHARGE_UNFROZEN",
          ].includes(event.type),
        );
        const attentionChargeCount = events.filter((event) =>
          [
            "SUBSCRIPTION_CHARGE_FROZEN",
            "SUBSCRIPTION_CHARGE_DECLINED",
          ].includes(event.type),
        ).length;
        const mrrByCurrency = new Map<string, number>();
        for (const event of activeEvents) {
          const sale = salesByCharge.get(
            `${event.appId} ${event.chargePlatformId}`,
          );
          const currency = sale?.currencyCode ?? event.currencyCode;
          const amount = Number(sale?.grossAmount ?? event.amount);
          const monthlyAmount =
            sale?.billingInterval === "ANNUAL" ? amount / 12 : amount;
          mrrByCurrency.set(
            currency,
            (mrrByCurrency.get(currency) ?? 0) + monthlyAmount,
          );
        }
        const currencyCode =
          [...mrrByCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
          lifetimeGroups.find(
            (group) =>
              group.appId === customer.appId &&
              group.shopDomain === customer.shopDomain,
          )?.currencyCode ??
          "USD";
        const lifetime = lifetimeByCustomer.get(
          `${key} ${currencyCode}`,
        );
        const install = installsByCustomer.get(key);

        return {
          appId: customer.appId,
          appName: appNames.get(customer.appId) ?? "Unknown app",
          appLogoUrl: appLogos.get(customer.appId) ?? null,
          shopDomain: customer.shopDomain,
          storeName: names.get(customer.shopDomain) ?? null,
          firstSeen: customer.firstSeen.toISOString(),
          lastActivity: customer.lastActivity.toISOString(),
          activeChargeCount: activeEvents.length,
          attentionChargeCount,
          mrr: mrrByCurrency.get(currencyCode) ?? 0,
          currencyCode,
          lifetimeValue: Number(lifetime?._sum.grossAmount ?? 0),
          saleCount: lifetime?._count._all ?? 0,
          oauthConnected: Boolean(
            install?.accessToken && !install.uninstalledAt,
          ),
        };
      });

      return { customers, total };
    },
  );

  return {
    apps,
    filters: { q, appId },
    page,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    customers,
  };
}

export default function Customers({ loaderData }: Route.ComponentProps) {
  const { apps, customers, filters, page, total, totalPages } = loaderData;
  const [q, setQ] = useFilterState(filters.q);
  const [appId, setAppId] = useFilterState(filters.appId);

  return (
    <Page
      title="Customers"
      subtitle={`${total.toLocaleString()} Shopify customer records from synchronized billing data`}
      fullWidth
    >
      <BlockStack gap="500">
        <Card>
          <Form method="get">
            <BlockStack gap="400">
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                <TextField
                  label="Search shops"
                  name="q"
                  value={q}
                  onChange={setQ}
                  placeholder="Store name, email, website or myshopify domain"
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setQ("")}
                />
                <AppPicker
                  value={appId}
                  onChange={setAppId}
                  apps={apps}
                />
              </InlineGrid>
              <InlineStack gap="300">
                <Button submit variant="primary">
                  Apply filters
                </Button>
                <Button url="/app/customers">Reset</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Card>

        <Card padding="0">
          {customers.length === 0 ? (
            <EmptyState
              heading="No customers match these filters"
              image={EMPTY_STATE_IMAGE}
            >
              <Text as="p" tone="subdued">
                Customer records appear after Shopify lifecycle or billing data
                has been synchronized.
              </Text>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "customer", plural: "customers" }}
              itemCount={customers.length}
              selectable={false}
              headings={[
                { title: "Customer" },
                { title: "App" },
                { title: "Status" },
                { title: "MRR" },
                { title: "Lifetime value" },
                { title: "Last activity" },
                { title: "Connection" },
              ]}
            >
              {customers.map((customer, index) => {
                const status = customerStatus(customer);
                const currency = customer.currencyCode ?? "USD";
                return (
                  <IndexTable.Row
                    id={`${customer.appId}-${customer.shopDomain}`}
                    key={`${customer.appId}-${customer.shopDomain}`}
                    position={index}
                  >
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Link
                          className="customer-primary-link"
                          to={customerUrl(
                            customer.appId,
                            customer.shopDomain,
                          )}
                        >
                          {customer.storeName ??
                            customer.shopDomain.replace(".myshopify.com", "")}
                        </Link>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {customer.shopDomain}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <AppName
                        appName={customer.appName}
                        logoUrl={customer.appLogoUrl}
                      />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(customer.mrr, currency)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(customer.lifetimeValue, currency)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatDateTime(customer.lastActivity)}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge
                        tone={customer.oauthConnected ? "success" : "info"}
                      >
                        {customer.oauthConnected
                          ? "OAuth ready"
                          : "Partner data"}
                      </Badge>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>

        {totalPages > 1 ? (
          <InlineStack align="center">
            <Pagination
              hasPrevious={page > 1}
              hasNext={page < totalPages}
              onPrevious={() => {
                window.location.assign(listUrl(filters, page - 1));
              }}
              onNext={() => {
                window.location.assign(listUrl(filters, page + 1));
              }}
              label={`Page ${page} of ${totalPages}`}
            />
          </InlineStack>
        ) : null}
      </BlockStack>
    </Page>
  );
}
