import type { ShopifyPartnerConnection } from "../../../generated/prisma/client";
import { decryptCredential } from "../credential-encryption.server";
import {
  partnerGraphqlWithCredentials,
  type PartnerCredentials,
} from "./partner.server";

export const VERIFY_PARTNER_APP_QUERY = /* GraphQL */ `
  query VerifyPartnerApp($appId: ID!) {
    app(id: $appId) {
      id
      apiKey
    }
  }
`;

export const VERIFY_PARTNER_CONNECTION_QUERY = /* GraphQL */ `
  query VerifyPartnerConnection {
    __typename
  }
`;

export const DISCOVER_PARTNER_APPS_QUERY = /* GraphQL */ `
  query DiscoverPartnerApps($after: String) {
    events(first: 100, after: $after) {
      edges {
        cursor
        node {
          subject {
            __typename
            ... on AppReference {
              id
              apiKey
              name
            }
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export type PartnerConnectionErrorCode =
  | "CONNECTION_NOT_FOUND"
  | "INVALID_APP_ID"
  | "INVALID_CLIENT_ID"
  | "INVALID_ORGANIZATION_ID"
  | "INVALID_TOKEN"
  | "APP_NOT_FOUND"
  | "APP_ID_MISMATCH"
  | "CLIENT_ID_MISMATCH"
  | "CONNECTION_FAILED";

const USER_MESSAGES: Record<PartnerConnectionErrorCode, string> = {
  CONNECTION_NOT_FOUND:
    "Choose a Shopify Partner connection from this account.",
  INVALID_APP_ID: "App ID must be numeric or look like gid://partners/App/123.",
  INVALID_CLIENT_ID: "Client ID is required.",
  INVALID_ORGANIZATION_ID: "Partner organization ID must be numeric.",
  INVALID_TOKEN: "Partner API token is required.",
  APP_NOT_FOUND:
    "That Partner connection cannot access this app. Check the App ID and the Manage apps permission.",
  APP_ID_MISMATCH: "Shopify returned a different app for this App ID.",
  CLIENT_ID_MISMATCH:
    "Client ID does not match the app returned by Shopify Partner API.",
  CONNECTION_FAILED:
    "Shopify Partner API connection failed. Check the Partner ID, token, and Manage apps permission.",
};

export class PartnerConnectionError extends Error {
  readonly code: PartnerConnectionErrorCode;

  constructor(code: PartnerConnectionErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "PartnerConnectionError";
    this.code = code;
  }
}

export function normalizePartnerAppId(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `gid://partners/App/${trimmed}`;
  if (/^gid:\/\/partners\/App\/\d+$/.test(trimmed)) return trimmed;
  throw new PartnerConnectionError("INVALID_APP_ID");
}

function normalizePartnerAppReferenceId(value: string): string {
  const match = value.match(/^gid:\/\/(?:shopify|partners)\/App\/(\d+)$/);
  if (!match) throw new PartnerConnectionError("INVALID_APP_ID");
  return `gid://partners/App/${match[1]}`;
}

export function normalizePartnerOrganizationId(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new PartnerConnectionError("INVALID_ORGANIZATION_ID");
  }
  return trimmed;
}

export function validatePartnerAccessToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) {
    throw new PartnerConnectionError("INVALID_TOKEN");
  }
  return trimmed;
}

export function partnerTokenLastFour(value: string): string {
  return value.slice(-4);
}

type StoredPartnerConnection = Pick<
  ShopifyPartnerConnection,
  "partnerOrganizationId" | "encryptedAccessToken"
>;

export function credentialsFromPartnerConnection(
  connection: StoredPartnerConnection,
): PartnerCredentials {
  try {
    const partnerApiToken = decryptCredential(connection.encryptedAccessToken);
    if (!partnerApiToken) throw new Error("empty");
    return {
      partnerApiToken,
      partnerOrganizationId: connection.partnerOrganizationId,
    };
  } catch {
    throw new PartnerConnectionError("CONNECTION_FAILED");
  }
}

interface PartnerAppQueryResult {
  app: { id: string; apiKey: string } | null;
}

export type PartnerAppQueryCaller = (
  credentials: PartnerCredentials,
  query: string,
  variables: { appId: string },
) => Promise<PartnerAppQueryResult>;

const defaultPartnerAppQueryCaller: PartnerAppQueryCaller = (
  credentials,
  query,
  variables,
) =>
  partnerGraphqlWithCredentials<PartnerAppQueryResult>(
    credentials,
    query,
    variables,
  );

export interface VerifyPartnerAppParams {
  credentials: PartnerCredentials;
  appId: string;
  clientId: string;
}

interface PartnerConnectionQueryResult {
  __typename: string;
}

export type PartnerConnectionQueryCaller = (
  credentials: PartnerCredentials,
  query: string,
) => Promise<PartnerConnectionQueryResult>;

const defaultPartnerConnectionQueryCaller: PartnerConnectionQueryCaller = (
  credentials,
  query,
) =>
  partnerGraphqlWithCredentials<PartnerConnectionQueryResult>(
    credentials,
    query,
  );

/** Verify the Partner organization/token pair before it is stored. */
export async function verifyPartnerCredentials(
  credentials: PartnerCredentials,
  callPartnerApi: PartnerConnectionQueryCaller = defaultPartnerConnectionQueryCaller,
): Promise<void> {
  try {
    const data = await callPartnerApi(
      credentials,
      VERIFY_PARTNER_CONNECTION_QUERY,
    );
    if (!data.__typename) throw new Error("missing query root");
  } catch {
    throw new PartnerConnectionError("CONNECTION_FAILED");
  }
}

interface PartnerAppReference {
  id: string;
  apiKey: string;
  name: string;
}

interface DiscoverPartnerAppsResult {
  events: {
    edges: Array<{
      cursor: string;
      node: {
        subject:
          | ({ __typename: "AppReference" } & PartnerAppReference)
          | { __typename: string }
          | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
}

export type DiscoverPartnerAppsCaller = (
  credentials: PartnerCredentials,
  query: string,
  variables: { after: string | null },
) => Promise<DiscoverPartnerAppsResult>;

const defaultDiscoverPartnerAppsCaller: DiscoverPartnerAppsCaller = (
  credentials,
  query,
  variables,
) =>
  partnerGraphqlWithCredentials<DiscoverPartnerAppsResult>(
    credentials,
    query,
    variables,
  );

/**
 * Discover apps visible to a Partner connection from organization-wide recent
 * events. Partner API has no root `apps` list; event subjects are the safe
 * discovery source, while manual App ID entry remains the fallback for apps
 * without events.
 */
export async function discoverPartnerApps(
  credentials: PartnerCredentials,
  callPartnerApi: DiscoverPartnerAppsCaller = defaultDiscoverPartnerAppsCaller,
  maxPages = 10,
): Promise<PartnerAppReference[]> {
  const apps = new Map<string, PartnerAppReference>();
  let after: string | null = null;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const data = await callPartnerApi(
        credentials,
        DISCOVER_PARTNER_APPS_QUERY,
        { after },
      );
      const edges = data.events.edges;
      for (const edge of edges) {
        const subject = edge.node.subject;
        if (subject?.__typename !== "AppReference") continue;
        const app = subject as {
          __typename: "AppReference";
        } & PartnerAppReference;
        apps.set(app.apiKey, {
          id: normalizePartnerAppReferenceId(app.id),
          apiKey: app.apiKey,
          name: app.name,
        });
      }
      if (!data.events.pageInfo.hasNextPage || edges.length === 0) break;
      after = edges[edges.length - 1].cursor;
    }
  } catch {
    throw new PartnerConnectionError("CONNECTION_FAILED");
  }

  return [...apps.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * Proves that the selected Partner client can access the exact app and that
 * its Partner API `apiKey` is the submitted Shopify Client ID.
 */
export async function verifyPartnerAppConnection(
  params: VerifyPartnerAppParams,
  callPartnerApi: PartnerAppQueryCaller = defaultPartnerAppQueryCaller,
): Promise<{ appId: string; clientId: string }> {
  const appId = normalizePartnerAppId(params.appId);
  const clientId = params.clientId.trim();
  if (!clientId) throw new PartnerConnectionError("INVALID_CLIENT_ID");

  let data: PartnerAppQueryResult;
  try {
    data = await callPartnerApi(params.credentials, VERIFY_PARTNER_APP_QUERY, {
      appId,
    });
  } catch {
    throw new PartnerConnectionError("CONNECTION_FAILED");
  }

  if (!data.app) throw new PartnerConnectionError("APP_NOT_FOUND");
  if (data.app.id !== appId) {
    throw new PartnerConnectionError("APP_ID_MISMATCH");
  }
  if (data.app.apiKey !== clientId) {
    throw new PartnerConnectionError("CLIENT_ID_MISMATCH");
  }
  return { appId, clientId };
}

export function partnerConnectionErrorMessage(error: unknown): string {
  return error instanceof PartnerConnectionError
    ? error.message
    : USER_MESSAGES.CONNECTION_FAILED;
}

export function partnerConnectionErrorCode(
  error: unknown,
): PartnerConnectionErrorCode {
  return error instanceof PartnerConnectionError
    ? error.code
    : "CONNECTION_FAILED";
}
