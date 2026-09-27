import type {
  App,
  ShopifyPartnerConnection,
} from "../../../generated/prisma/client";
import {
  createRedisSwrCache,
  invalidateRedisCachePattern,
} from "../cache/redis-cache.server";
import { prisma } from "../db.server";
import {
  effectivePartnerCredentials,
  partnerGraphqlWithCredentials,
} from "./partner.server";

const LATEST_SUBSCRIPTION_EVENTS_QUERY = `
  query LatestSubscriptionEvents($appId: ID!) {
    app(id: $appId) {
      events(
        first: 50
        types: [
          SUBSCRIPTION_CHARGE_ACCEPTED
          SUBSCRIPTION_CHARGE_ACTIVATED
          SUBSCRIPTION_CHARGE_CANCELED
          SUBSCRIPTION_CHARGE_DECLINED
          SUBSCRIPTION_CHARGE_EXPIRED
          SUBSCRIPTION_CHARGE_FROZEN
          SUBSCRIPTION_CHARGE_UNFROZEN
        ]
      ) {
        edges {
          node {
            type
            occurredAt
            shop {
              id
              myshopifyDomain
            }
            ... on AppSubscriptionEvent {
              charge {
                id
                name
                amount {
                  amount
                  currencyCode
                }
                billingOn
                test
              }
            }
          }
        }
      }
    }
  }
`;

type AppWithPartnerConnection = Pick<
  App,
  "id" | "name" | "shopifyAppId" | "partnerApiToken" | "partnerOrganizationId"
> & {
  partnerConnection: Pick<
    ShopifyPartnerConnection,
    "partnerOrganizationId" | "encryptedAccessToken"
  > | null;
};

interface LatestSubscriptionEventsResult {
  app: {
    events: {
      edges: Array<{
        node: {
          type: string;
          occurredAt: string;
          shop: { id: string; myshopifyDomain: string };
          charge: {
            id: string;
            name: string;
            amount: { amount: string; currencyCode: string };
            billingOn?: string | null;
            test: boolean;
          };
        };
      }>;
    };
  } | null;
}

export interface PartnerSubscriptionActivity {
  appId: string;
  appName: string;
  type: string;
  occurredAt: string;
  shopId: string;
  shopDomain: string;
  chargeId: string;
  chargeName: string;
  amount: string;
  currencyCode: string;
  billingOn: string | null;
  test: boolean;
}

export interface PartnerSubscriptionActivityResult {
  events: PartnerSubscriptionActivity[];
  errors: Array<{ appId: string; appName: string; message: string }>;
  fetchedAt: string;
  cacheStatus: "fresh" | "stale" | "refreshed";
  /** Matching events in total, for a paginated caller. Only counted when one
   * asks (`skip` given) — the dashboard's "latest 12" has no use for it and a
   * COUNT over this table is not free. */
  total?: number;
}

/**
 * Reads the latest already-synchronized immutable lifecycle facts. Dashboard
 * navigation never waits on Shopify; the scheduled/manual sync owns network IO.
 */
export async function readPersistedPartnerSubscriptionActivity(
  apps: Array<Pick<App, "id" | "name">>,
  limit = 150,
  /** Rows to skip. Passing it also asks for `total`, since a caller that pages
   * needs to know when to stop. */
  skip?: number,
): Promise<PartnerSubscriptionActivityResult> {
  const appNames = new Map(apps.map((app) => [app.id, app.name]));
  const appIds = apps.map((app) => app.id);
  const where = { appId: { in: appIds } };
  const [events, total] = appIds.length
    ? await Promise.all([
        prisma.partnerSubscriptionEvent.findMany({
          where,
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: limit,
          ...(skip ? { skip } : {}),
        }),
        skip === undefined
          ? Promise.resolve(undefined)
          : prisma.partnerSubscriptionEvent.count({ where }),
      ])
    : [[], skip === undefined ? undefined : 0];
  return {
    ...(total === undefined ? {} : { total }),
    events: events.map((event) => ({
      appId: event.appId,
      appName: appNames.get(event.appId) ?? "Shopify app",
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      shopId: event.shopPlatformId ?? "",
      shopDomain: event.shopDomain,
      chargeId: event.chargePlatformId,
      chargeName: event.chargeName,
      amount: event.amount.toString(),
      currencyCode: event.currencyCode,
      billingOn: event.billingOn?.toISOString() ?? null,
      test: event.test,
    })),
    errors: [],
    fetchedAt: events[0]?.fetchedAt.toISOString() ?? new Date(0).toISOString(),
    cacheStatus: "fresh",
  };
}

const ACTIVITY_CACHE_TTL_MS = 5 * 60_000;
const ACTIVITY_STALE_TTL_MS = 60 * 60_000;
const ACTIVITY_CACHE_KEY_PREFIX = "activity:";
const activityCache = createRedisSwrCache<
  Omit<PartnerSubscriptionActivityResult, "cacheStatus">
>(ACTIVITY_CACHE_KEY_PREFIX);

function activityCacheKey(apps: AppWithPartnerConnection[]): string {
  return apps
    .map((app) => `${app.id}:${app.shopifyAppId ?? "unconfigured"}`)
    .sort()
    .join("|");
}

async function requestLatestPartnerSubscriptionActivity(
  apps: AppWithPartnerConnection[],
): Promise<Omit<PartnerSubscriptionActivityResult, "cacheStatus">> {
  const results = await Promise.all(
    apps.map(async (app) => {
      const credentials = effectivePartnerCredentials(app);
      if (!credentials || !app.shopifyAppId) {
        return {
          events: [] as PartnerSubscriptionActivity[],
          error: {
            appId: app.id,
            appName: app.name,
            message: "Partner connection or Shopify App ID is missing.",
          },
        };
      }

      try {
        const data =
          await partnerGraphqlWithCredentials<LatestSubscriptionEventsResult>(
            credentials,
            LATEST_SUBSCRIPTION_EVENTS_QUERY,
            { appId: app.shopifyAppId },
          );
        return {
          events: (data.app?.events.edges ?? []).map(({ node }) => ({
            appId: app.id,
            appName: app.name,
            type: node.type,
            occurredAt: node.occurredAt,
            shopId: node.shop.id,
            shopDomain: node.shop.myshopifyDomain,
            chargeId: node.charge.id,
            chargeName: node.charge.name,
            amount: node.charge.amount.amount,
            currencyCode: node.charge.amount.currencyCode,
            billingOn: node.charge.billingOn ?? null,
            test: node.charge.test,
          })),
          error: null,
        };
      } catch {
        return {
          events: [] as PartnerSubscriptionActivity[],
          error: {
            appId: app.id,
            appName: app.name,
            message: "Shopify Partner API request failed.",
          },
        };
      }
    }),
  );

  return {
    events: results
      .flatMap((result) => result.events)
      .sort(
        (left, right) =>
          new Date(right.occurredAt).getTime() -
          new Date(left.occurredAt).getTime(),
      ),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Reads Shopify's latest subscription events directly. Nothing is persisted,
 * aggregated, or converted into MRR. Fresh data is held only in Redis (with a
 * per-process in-flight dedup on top). Stale-while-revalidate keeps
 * navigation fast while refreshing automatically.
 */
export async function fetchLatestPartnerSubscriptionActivity(
  apps: AppWithPartnerConnection[],
  options: { forceRefresh?: boolean } = {},
): Promise<PartnerSubscriptionActivityResult> {
  const key = activityCacheKey(apps);
  const compute = () => requestLatestPartnerSubscriptionActivity(apps);

  if (options.forceRefresh) {
    const value = await activityCache.forceRefresh(
      key,
      ACTIVITY_CACHE_TTL_MS,
      ACTIVITY_STALE_TTL_MS,
      compute,
    );
    return { ...value, cacheStatus: "refreshed" };
  }

  const { value, status } = await activityCache.fetchOrRefresh(
    key,
    ACTIVITY_CACHE_TTL_MS,
    ACTIVITY_STALE_TTL_MS,
    compute,
  );
  return { ...value, cacheStatus: status };
}

export async function invalidatePartnerSubscriptionActivityCache(
  appIds?: string[],
): Promise<void> {
  if (!appIds) {
    await invalidateRedisCachePattern(`${ACTIVITY_CACHE_KEY_PREFIX}*`);
    return;
  }
  await Promise.all(
    appIds.map((appId) =>
      invalidateRedisCachePattern(`${ACTIVITY_CACHE_KEY_PREFIX}*${appId}:*`),
    ),
  );
}
