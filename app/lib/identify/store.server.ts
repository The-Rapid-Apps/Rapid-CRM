import { Prisma, prisma } from "../db.server";
import { decryptCredential } from "../credential-encryption.server";
import { constantTimeEqual } from "./app-registry.server";
import {
  CustomerConflictError,
  type CustomerStore,
  type StoredCustomer,
  hashCustomerToken,
} from "./core.server";

/** Production {@link CustomerStore} backed by Prisma / MySQL. */

const SELECT = {
  id: true,
  appId: true,
  platform: true,
  platformId: true,
  name: true,
  email: true,
  myshopifyDomain: true,
  customFields: true,
  apiToken: true,
} as const;

function toStored(row: {
  id: string;
  appId: string;
  platform: string;
  platformId: string;
  name: string | null;
  email: string | null;
  myshopifyDomain: string | null;
  customFields: Prisma.JsonValue;
  apiToken: string;
}): StoredCustomer {
  return {
    id: row.id,
    appId: row.appId,
    platform: row.platform,
    platformId: row.platformId,
    name: row.name,
    email: row.email,
    myshopifyDomain: row.myshopifyDomain,
    customFields:
      row.customFields && typeof row.customFields === "object"
        ? (row.customFields as Record<string, unknown>)
        : null,
    apiToken: row.apiToken,
  };
}

export const prismaCustomerStore: CustomerStore = {
  async findByIdentity(identity) {
    const row = await prisma.identifiedCustomer.findUnique({
      where: { appId_platform_platformId: identity },
      select: SELECT,
    });
    return row ? toStored(row) : null;
  },

  async create(data) {
    try {
      const row = await prisma.identifiedCustomer.create({
        data: {
          appId: data.appId,
          platform: data.platform,
          platformId: data.platformId,
          name: data.name,
          email: data.email,
          myshopifyDomain: data.myshopifyDomain,
          accessToken: data.accessTokenEncrypted,
          customFields:
            data.customFields === null
              ? Prisma.DbNull
              : (data.customFields as Prisma.InputJsonValue),
          apiToken: data.apiToken,
          apiTokenHash: data.apiTokenHash,
        },
        select: SELECT,
      });
      return toStored(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new CustomerConflictError();
      }
      throw error;
    }
  },

  async update(identity, data) {
    const row = await prisma.identifiedCustomer.update({
      where: { appId_platform_platformId: identity },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.myshopifyDomain !== undefined
          ? { myshopifyDomain: data.myshopifyDomain }
          : {}),
        ...(data.accessTokenEncrypted !== undefined
          ? { accessToken: data.accessTokenEncrypted }
          : {}),
        ...(data.customFields !== undefined
          ? {
              customFields:
                data.customFields === null
                  ? Prisma.DbNull
                  : (data.customFields as Prisma.InputJsonValue),
            }
          : {}),
      },
      select: SELECT,
    });
    return toStored(row);
  },
};

/**
 * Resolve a customer-scoped API token (a future X-Customer-Api-Token) back to
 * its customer. The indexed lookup is by token hash; the stored plaintext is
 * then confirmed with a constant-time comparison so a hash collision or a
 * partially-matching token can't authenticate. Returns the customer id and
 * appId, or null. The token itself is never returned or logged.
 */
export async function resolveCustomerByToken(
  token: string,
): Promise<{ id: string; appId: string } | null> {
  if (!token) return null;
  const row = await prisma.identifiedCustomer.findUnique({
    where: { apiTokenHash: hashCustomerToken(token) },
    select: { id: true, appId: true, apiToken: true },
  });
  if (!row) return null;
  if (!constantTimeEqual(token, row.apiToken)) return null;
  return { id: row.id, appId: row.appId };
}

/** Decrypt a stored access-token envelope. Kept here so callers never touch
 * the raw column. Throws on a tampered/invalid envelope. */
export function decryptStoredAccessToken(envelope: string): string {
  return decryptCredential(envelope);
}
