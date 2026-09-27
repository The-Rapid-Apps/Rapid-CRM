import "@shopify/shopify-api/adapters/node";
import {
  shopifyApi,
  Session,
  ApiVersion,
  type Shopify,
} from "@shopify/shopify-api";
import type { App, AppInstall } from "../../../generated/prisma/client";
import { env } from "../env.server";
import { logger } from "../logger.server";

const log = logger.scope("shopify-admin");

// Newest stable Admin API version in @shopify/shopify-api@13. Bump as Shopify
// ships new quarterly versions (keep in step with partner.server.ts).
const SHOPIFY_API_VERSION = ApiVersion.July26;

/**
 * This platform is multi-tenant: each `App` has its own Shopify API
 * credentials, so we build (and cache) one `shopifyApi` instance per app. The
 * merchant's offline access token lives on the `AppInstall` and becomes the
 * `Session` we attach to the GraphQL client.
 */
const apiCache = new Map<
  string,
  {
    apiKey: string;
    apiSecret: string;
    api: Shopify;
  }
>();

function apiFor(
  app: Pick<App, "id" | "shopifyApiKey" | "shopifyApiSecret">,
): Shopify {
  if (!app.shopifyApiKey.trim() || !app.shopifyApiSecret.trim()) {
    throw new Error(
      "Shopify Admin API is not configured: save the app Client ID and Client secret first",
    );
  }
  const cached = apiCache.get(app.id);
  if (
    cached &&
    cached.apiKey === app.shopifyApiKey &&
    cached.apiSecret === app.shopifyApiSecret
  ) {
    return cached.api;
  }

  const hostName = new URL(env.APP_URL).host;
  const instance = shopifyApi({
    apiKey: app.shopifyApiKey,
    apiSecretKey: app.shopifyApiSecret,
    // Scopes aren't needed for server-side Admin GraphQL calls with an existing
    // offline token, but the config requires the field.
    scopes: [],
    hostName,
    apiVersion: SHOPIFY_API_VERSION,
    isEmbeddedApp: true,
  });
  apiCache.set(app.id, {
    apiKey: app.shopifyApiKey,
    apiSecret: app.shopifyApiSecret,
    api: instance,
  });
  return instance;
}

function offlineSession(
  api: Shopify,
  install: Pick<AppInstall, "shopDomain" | "accessToken" | "scope">,
): Session {
  if (!install.accessToken) {
    throw new Error(
      `AppInstall for ${install.shopDomain} has no access token — cannot call the Admin API`,
    );
  }
  return new Session({
    id: api.session.getOfflineId(install.shopDomain),
    shop: install.shopDomain,
    state: "",
    isOnline: false,
    accessToken: install.accessToken,
    scope: install.scope ?? undefined,
  });
}

export interface AdminGraphqlError {
  message: string;
  extensions?: Record<string, unknown>;
}

/**
 * Run an Admin GraphQL operation for a given (app, install). Returns the `data`
 * payload. Throws on transport/GraphQL-level errors; mutation `userErrors` are
 * NOT thrown — callers inspect them (the billing layer treats specific ones as
 * soft no-ops per spec §2.2).
 */
export async function adminGraphql<T>(
  app: Pick<App, "id" | "shopifyApiKey" | "shopifyApiSecret">,
  install: Pick<AppInstall, "shopDomain" | "accessToken" | "scope">,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const api = apiFor(app);
  const client = new api.clients.Graphql({
    session: offlineSession(api, install),
  });
  const response = await client.request<T>(query, { variables });

  if (response.errors) {
    log.error("Admin GraphQL returned errors", {
      shop: install.shopDomain,
      errors: response.errors,
    });
    const message =
      response.errors.message ??
      (Array.isArray(response.errors.graphQLErrors)
        ? response.errors.graphQLErrors.map((e) => e.message).join("; ")
        : "Unknown GraphQL error");
    throw new Error(
      `Admin GraphQL error for ${install.shopDomain}: ${message}`,
    );
  }

  return response.data as T;
}
