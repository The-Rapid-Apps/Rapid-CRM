import { prisma } from "../db.server";
import {
  credentialsFromPartnerConnection,
  discoverPartnerApps,
  PartnerConnectionError,
  verifyPartnerAppConnection,
} from "./partner-connection.server";

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Match apps already added to the internal tool with the authoritative app
 * references visible in recent Partner events, verify each exact App ID, then
 * attach them to the reusable connection in one transaction.
 */
export async function connectDiscoveredPartnerApps(
  organizationId: string,
  connectionId: string,
): Promise<{
  connected: number;
  discovered: number;
  correctedClientIds: number;
}> {
  const connection = await prisma.shopifyPartnerConnection.findFirst({
    where: { id: connectionId, organizationId },
  });
  if (!connection) throw new PartnerConnectionError("CONNECTION_NOT_FOUND");

  const credentials = credentialsFromPartnerConnection(connection);
  const [remoteApps, localApps] = await Promise.all([
    discoverPartnerApps(credentials),
    prisma.app.findMany({
      where: { organizationId },
      include: { _count: { select: { rawPartnerEvents: true } } },
    }),
  ]);
  const claimedRemoteIds = new Set<string>();
  const verified: Array<{
    localAppId: string;
    appId: string;
    clientId: string;
    resetSync: boolean;
    correctedClientId: boolean;
  }> = [];

  for (const localApp of localApps) {
    const byName = remoteApps.find(
      (remoteApp) =>
        normalizeName(remoteApp.name) === normalizeName(localApp.name) &&
        !claimedRemoteIds.has(remoteApp.id),
    );
    const byClientId = remoteApps.find(
      (remoteApp) =>
        remoteApp.apiKey === localApp.shopifyApiKey &&
        !claimedRemoteIds.has(remoteApp.id),
    );
    const remoteApp = byName ?? byClientId;
    if (!remoteApp) continue;
    if (
      localApp.shopifyAppId &&
      localApp.shopifyAppId !== remoteApp.id &&
      localApp._count.rawPartnerEvents > 0
    ) {
      continue;
    }

    const result = await verifyPartnerAppConnection({
      credentials,
      appId: remoteApp.id,
      clientId: remoteApp.apiKey,
    });
    claimedRemoteIds.add(result.appId);
    verified.push({
      localAppId: localApp.id,
      appId: result.appId,
      clientId: result.clientId,
      resetSync: localApp.shopifyAppId !== result.appId,
      correctedClientId: localApp.shopifyApiKey !== result.clientId,
    });
  }

  if (verified.length === 0) {
    return {
      connected: 0,
      discovered: remoteApps.length,
      correctedClientIds: 0,
    };
  }

  const now = new Date();
  await prisma.$transaction([
    ...verified.map((match) =>
      prisma.app.update({
        where: { id: match.localAppId },
        data: {
          partnerConnectionId: connection.id,
          shopifyAppId: match.appId,
          shopifyApiKey: match.clientId,
          partnerAppVerifiedAt: now,
          partnerAppVerificationError: null,
          ...(match.resetSync ? { lifecycleEventsSyncedAt: null } : {}),
        },
      }),
    ),
    prisma.shopifyPartnerConnection.update({
      where: { id: connection.id },
      data: {
        status: "CONNECTED",
        lastTestedAt: now,
        lastConnectedAt: now,
        lastErrorCode: null,
      },
    }),
  ]);

  return {
    connected: verified.length,
    discovered: remoteApps.length,
    correctedClientIds: verified.filter((match) => match.correctedClientId)
      .length,
  };
}
