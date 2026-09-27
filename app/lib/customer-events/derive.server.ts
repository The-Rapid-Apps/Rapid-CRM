import { randomUUID } from "node:crypto";
import type {
  AccountLifecycleEventType,
  Prisma,
} from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { syncCustomerStateForInstall } from "../shopify/partner-state-sync.server";
import { normalizeUninstallReason } from "./uninstall-reason";

const log = logger.scope("customer-events-derive");
const DERIVATION_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_DERIVATION_LIMIT = 250;

const RAW_TYPE_TO_CLEAN: Record<string, AccountLifecycleEventType | undefined> =
  {
    RELATIONSHIP_UNINSTALLED: "UNINSTALLED",
    RELATIONSHIP_REACTIVATED: "REACTIVATED",
    RELATIONSHIP_DEACTIVATED: "DEACTIVATED",
    // RELATIONSHIP_INSTALLED is handled separately below — INSTALLED vs
    // REINSTALLED depends on whether an older install fact exists.
  };

const SUPPORTED_RAW_TYPES = [
  "RELATIONSHIP_INSTALLED",
  "RELATIONSHIP_UNINSTALLED",
  "RELATIONSHIP_REACTIVATED",
  "RELATIONSHIP_DEACTIVATED",
] as const;

type InstallLifecycleMirrorInput = {
  rawType: string;
  occurredAt: Date;
  installedAt: Date;
  uninstalledAt: Date | null;
  relationshipStateSyncedAt: Date | null;
};

/**
 * Build the local current-install mirror update for an immutable Partner fact.
 * Historical backfill rows may improve the first-install timestamp but must
 * never replace a newer relationship state. OAuth credentials are
 * intentionally outside this update.
 */
export function installLifecycleMirrorUpdate({
  rawType,
  occurredAt,
  installedAt,
  uninstalledAt,
  relationshipStateSyncedAt,
}: InstallLifecycleMirrorInput): {
  installedAt?: Date;
  uninstalledAt?: Date | null;
  relationshipStateSyncedAt?: Date;
} {
  const update: {
    installedAt?: Date;
    uninstalledAt?: Date | null;
    relationshipStateSyncedAt?: Date;
  } = {};

  if (
    rawType === "RELATIONSHIP_INSTALLED" &&
    occurredAt.getTime() < installedAt.getTime()
  ) {
    update.installedAt = occurredAt;
  }

  const isNewestState =
    !relationshipStateSyncedAt ||
    occurredAt.getTime() >= relationshipStateSyncedAt.getTime();
  if (!isNewestState) return update;

  update.relationshipStateSyncedAt = occurredAt;
  if (rawType === "RELATIONSHIP_UNINSTALLED") {
    update.uninstalledAt = occurredAt;
  } else if (
    rawType === "RELATIONSHIP_INSTALLED" ||
    rawType === "RELATIONSHIP_REACTIVATED"
  ) {
    // A newer install/reactivation fact is authoritative even when the mirror
    // is already active. Explicitly clearing keeps this operation idempotent.
    update.uninstalledAt = null;
  } else if (rawType === "RELATIONSHIP_DEACTIVATED") {
    // Deactivation is not an uninstall, but it must advance the watermark so
    // an older backfill row cannot later change the current relationship.
    void uninstalledAt;
  }
  return update;
}

export interface LifecycleDerivationResult {
  derived: number;
  hasMore: boolean;
  inProgress: boolean;
  /** Earliest `occurredAt` among this batch's raw events, or null if none
   * were processed — lets callers advance an `installSnapshotDirtyFrom`-style
   * watermark to cover exactly what this derivation could have moved. */
  earliestOccurredAt: Date | null;
}

/**
 * Derive a bounded batch of clean lifecycle events from immutable Partner
 * facts. A database lease prevents duplicate work across Node processes. Each
 * raw-event link and AppInstall mirror update commits in one transaction, so a
 * crash cannot leave a linked event with stale current-install state.
 */
export async function deriveAccountLifecycleEvents(
  appId: string,
  options: { limit?: number; newestFirst?: boolean } = {},
): Promise<LifecycleDerivationResult> {
  const limit = Math.min(
    500,
    Math.max(1, options.limit ?? DEFAULT_DERIVATION_LIMIT),
  );
  const leaseToken = randomUUID();
  const now = new Date();
  const acquired = await prisma.app.updateMany({
    where: {
      id: appId,
      OR: [
        { lifecycleDeriveLeaseToken: null },
        { lifecycleDeriveLeaseExpiresAt: null },
        { lifecycleDeriveLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      lifecycleDeriveLeaseToken: leaseToken,
      lifecycleDeriveLeaseExpiresAt: new Date(
        now.getTime() + DERIVATION_LEASE_MS,
      ),
    },
  });
  if (acquired.count !== 1) {
    return { derived: 0, hasMore: true, inProgress: true, earliestOccurredAt: null };
  }

  try {
    const rawEvents = await prisma.rawPartnerEvent.findMany({
      where: {
        appId,
        lifecycleEvent: null,
        type: { in: [...SUPPORTED_RAW_TYPES] },
      },
      orderBy: [
        { occurredAt: options.newestFirst ? "desc" : "asc" },
        { id: options.newestFirst ? "desc" : "asc" },
      ],
      take: limit,
    });
    if (rawEvents.length === 0) {
      return { derived: 0, hasMore: false, inProgress: false, earliestOccurredAt: null };
    }

    let derived = 0;
    let earliestOccurredAt: Date | null = null;
    for (const raw of rawEvents) {
      if (derived > 0 && derived % 25 === 0) {
        const renewed = await prisma.app.updateMany({
          where: { id: appId, lifecycleDeriveLeaseToken: leaseToken },
          data: {
            lifecycleDeriveLeaseExpiresAt: new Date(
              Date.now() + DERIVATION_LEASE_MS,
            ),
          },
        });
        if (renewed.count !== 1) {
          throw new Error("Lifecycle derivation lease was lost");
        }
      }

      await prisma.$transaction(
        async (tx) => {
          const appInstall = await tx.appInstall.upsert({
            where: { appId_shopDomain: { appId, shopDomain: raw.shopDomain } },
            /* The name is written whenever the feed carried one, so a rename
               lands on the next event rather than being frozen at install.
               Never written as null: events are derived in `occurredAt` order,
               but a single event with no name must not erase a name an earlier
               one supplied. */
            update: {
              ...(raw.shopPlatformId ? { shopPlatformId: raw.shopPlatformId } : {}),
              ...(raw.shopName ? { shopName: raw.shopName } : {}),
            },
            create: {
              appId,
              shopDomain: raw.shopDomain,
              shopPlatformId: raw.shopPlatformId,
              shopName: raw.shopName,
              installedAt: raw.occurredAt,
            },
            select: {
              id: true,
              installedAt: true,
              uninstalledAt: true,
              relationshipStateSyncedAt: true,
            },
          });

          let type: AccountLifecycleEventType;
          if (raw.type === "RELATIONSHIP_INSTALLED") {
            // Classification is based on immutable raw history, not on which
            // worker happened to derive an earlier row first.
            const olderInstallFacts = await tx.rawPartnerEvent.count({
              where: {
                appId,
                shopDomain: raw.shopDomain,
                type: "RELATIONSHIP_INSTALLED",
                occurredAt: { lt: raw.occurredAt },
              },
            });
            type = olderInstallFacts > 0 ? "REINSTALLED" : "INSTALLED";
          } else {
            const mapped = RAW_TYPE_TO_CLEAN[raw.type];
            if (!mapped) {
              log.warn("unknown raw partner event type — skipping", {
                type: raw.type,
                rawId: raw.id,
              });
              return null;
            }
            type = mapped;
          }

          const event = await tx.accountLifecycleEvent.upsert({
            where: { platformEventId: `partner_event/${raw.id}` },
            create: {
              appId,
              appInstallId: appInstall.id,
              type,
              occurredAt: raw.occurredAt,
              platformEventId: `partner_event/${raw.id}`,
              rawPartnerEventId: raw.id,
            },
            update: {},
          });

          if (type === "UNINSTALLED") {
            const { reasonCode, reasonCodes, isStoreClosure } =
              normalizeUninstallReason(raw.reason, raw.description);
            await tx.uninstallEventDetail.upsert({
              where: { eventId: event.id },
              create: {
                eventId: event.id,
                reason: raw.reason,
                description: raw.description,
                reasonCode,
                reasonCodes,
                isStoreClosure,
              },
              update: {},
            });
          }

          const mirrorUpdate = installLifecycleMirrorUpdate({
            rawType: raw.type,
            occurredAt: raw.occurredAt,
            installedAt: appInstall.installedAt,
            uninstalledAt: appInstall.uninstalledAt,
            relationshipStateSyncedAt: appInstall.relationshipStateSyncedAt,
          });

          if (mirrorUpdate.installedAt) {
            await tx.appInstall.updateMany({
              where: {
                id: appInstall.id,
                installedAt: { gt: mirrorUpdate.installedAt },
              },
              data: { installedAt: mirrorUpdate.installedAt },
            });
          }

          if (mirrorUpdate.relationshipStateSyncedAt) {
            const stateData: Prisma.AppInstallUpdateManyMutationInput = {
              relationshipStateSyncedAt: mirrorUpdate.relationshipStateSyncedAt,
            };
            if ("uninstalledAt" in mirrorUpdate) {
              stateData.uninstalledAt = mirrorUpdate.uninstalledAt ?? null;
            }
            await tx.appInstall.updateMany({
              where: {
                id: appInstall.id,
                OR: [
                  { relationshipStateSyncedAt: null },
                  {
                    relationshipStateSyncedAt: {
                      lte: mirrorUpdate.relationshipStateSyncedAt,
                    },
                  },
                ],
              },
              data: stateData,
            });
          }
          return { eventId: event.id, lifecycleType: type };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
      // Best-effort, outside the transaction — this shop's AppInstall row may
      // have just been created here for the first time ever (an install-only
      // shop with no subscription events), which is otherwise never noticed
      // by partner-state-sync.server.ts (see syncCustomerStateForInstall's
      // own doc for why this hook exists).
      await syncCustomerStateForInstall(appId, raw.shopDomain);
      derived += 1;
      if (!earliestOccurredAt || raw.occurredAt.getTime() < earliestOccurredAt.getTime()) {
        earliestOccurredAt = raw.occurredAt;
      }
    }

    return {
      derived,
      hasMore: rawEvents.length === limit,
      inProgress: false,
      earliestOccurredAt,
    };
  } finally {
    await prisma.app.updateMany({
      where: { id: appId, lifecycleDeriveLeaseToken: leaseToken },
      data: {
        lifecycleDeriveLeaseToken: null,
        lifecycleDeriveLeaseExpiresAt: null,
      },
    });
  }
}
