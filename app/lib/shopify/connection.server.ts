import type { App, AppInstall } from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { adminGraphql } from "./admin.server";

/**
 * A deliberately small, read-only query. If it succeeds, the stored offline
 * token can reach this shop's Admin API; the returned canonical domain also
 * lets us detect a token accidentally attached to the wrong install.
 */
export const SHOPIFY_CONNECTION_CHECK_QUERY =
  "query ConnectionCheck { shop { id name myshopifyDomain } }";

export type ShopifyConnectionStatus =
  "connected" | "missing_token" | "uninstalled" | "error" | "domain_mismatch";

export interface ShopifyConnectionApp extends Pick<
  App,
  "id" | "name" | "shopifyApiKey" | "shopifyApiSecret"
> {}

export interface ShopifyConnectionInstall extends Pick<
  AppInstall,
  "id" | "appId" | "shopDomain" | "accessToken" | "scope" | "uninstalledAt"
> {}

export interface ShopifyRemoteShop {
  id: string;
  name: string;
  myshopifyDomain: string;
}

interface ConnectionResultBase {
  appId: string;
  appName: string;
  installId: string;
  shopDomain: string;
}

export type ShopifyConnectionResult = ConnectionResultBase &
  (
    | {
        status: "connected";
        remoteShop: ShopifyRemoteShop;
      }
    | {
        status: "missing_token";
      }
    | {
        status: "uninstalled";
      }
    | {
        status: "error";
        message: "Shopify Admin API connection check failed.";
      }
    | {
        status: "domain_mismatch";
        remoteShop: ShopifyRemoteShop;
      }
  );

interface ConnectionCheckPayload {
  shop: ShopifyRemoteShop | null;
}

/**
 * Concrete instead of generic so tests can inject a small async function
 * without needing to reproduce adminGraphql's generic call signature.
 */
export type ShopifyConnectionGraphqlCaller = (
  app: ShopifyConnectionApp,
  install: ShopifyConnectionInstall,
  query: string,
) => Promise<ConnectionCheckPayload>;

export interface ShopifyConnectionDependencies {
  callGraphql: ShopifyConnectionGraphqlCaller;
}

const defaultDependencies: ShopifyConnectionDependencies = {
  callGraphql: (app, install, query) =>
    adminGraphql<ConnectionCheckPayload>(app, install, query),
};

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function resultBase(
  app: ShopifyConnectionApp,
  install: ShopifyConnectionInstall,
): ConnectionResultBase {
  return {
    appId: app.id,
    appName: app.name,
    installId: install.id,
    shopDomain: install.shopDomain,
  };
}

/**
 * Probe one already-loaded install. This function performs no database writes
 * and never returns credentials or raw exception text.
 */
export async function checkShopifyInstallConnection(
  app: ShopifyConnectionApp,
  install: ShopifyConnectionInstall,
  dependencies: Partial<ShopifyConnectionDependencies> = {},
): Promise<ShopifyConnectionResult> {
  const base = resultBase(app, install);

  if (install.uninstalledAt) {
    return { ...base, status: "uninstalled" };
  }
  if (!install.accessToken?.trim()) {
    return { ...base, status: "missing_token" };
  }

  const { callGraphql } = { ...defaultDependencies, ...dependencies };
  try {
    const payload = await callGraphql(
      app,
      install,
      SHOPIFY_CONNECTION_CHECK_QUERY,
    );
    if (!payload.shop) {
      return {
        ...base,
        status: "error",
        message: "Shopify Admin API connection check failed.",
      };
    }

    const expectedDomain = normalizeShopDomain(install.shopDomain);
    const actualDomain = normalizeShopDomain(payload.shop.myshopifyDomain);
    if (actualDomain !== expectedDomain) {
      return {
        ...base,
        status: "domain_mismatch",
        remoteShop: payload.shop,
      };
    }

    return {
      ...base,
      status: "connected",
      remoteShop: payload.shop,
    };
  } catch {
    return {
      ...base,
      status: "error",
      message: "Shopify Admin API connection check failed.",
    };
  }
}

/**
 * Resolve and check one install while enforcing the dashboard tenant boundary.
 * A missing or cross-organization id returns null rather than revealing it.
 */
export async function checkShopifyConnectionByInstallId(
  organizationId: string,
  installId: string,
  dependencies: Partial<ShopifyConnectionDependencies> = {},
): Promise<ShopifyConnectionResult | null> {
  const install = await prisma.appInstall.findFirst({
    where: {
      id: installId,
      app: { organizationId },
    },
    include: { app: true },
  });
  if (!install) return null;

  return checkShopifyInstallConnection(install.app, install, dependencies);
}

export interface CheckActiveShopifyConnectionsParams {
  organizationId: string;
  /** Omit to check every app in the organization. */
  appId?: string;
  /** Ignore Partner-discovered installs that have never completed app OAuth. */
  onlyWithToken?: boolean;
}

/**
 * Check every currently installed shop for an organization, optionally scoped
 * to one app. Requests run sequentially to avoid creating an Admin API burst;
 * one failed shop is represented in the results and does not abort the sweep.
 */
export async function checkActiveShopifyConnections(
  params: CheckActiveShopifyConnectionsParams,
  dependencies: Partial<ShopifyConnectionDependencies> = {},
): Promise<ShopifyConnectionResult[]> {
  const installs = await prisma.appInstall.findMany({
    where: {
      uninstalledAt: null,
      ...(params.onlyWithToken ? { accessToken: { not: null } } : {}),
      app: {
        organizationId: params.organizationId,
        ...(params.appId ? { id: params.appId } : {}),
      },
    },
    include: { app: true },
    orderBy: [{ appId: "asc" }, { shopDomain: "asc" }],
  });

  const results: ShopifyConnectionResult[] = [];
  for (const install of installs) {
    results.push(
      await checkShopifyInstallConnection(install.app, install, dependencies),
    );
  }
  return results;
}
