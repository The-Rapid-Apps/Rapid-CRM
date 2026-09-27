import { prisma } from "../db.server";
import { logger } from "../logger.server";
import {
  markInstallSnapshotDirty,
  runInstallSnapshotSync,
} from "../reports/install-snapshot.server";
import { deriveAccountLifecycleEvents } from "./derive.server";
import { pollAccountLifecycleEvents } from "./poll.server";

const log = logger.scope("customer-events-cron");

export interface CustomerEventsCronSummary {
  appsProcessed: number;
  appsComplete: number;
  appsFresh: number;
  appsSkipped: number;
  appsInProgress: number;
  fetched: number;
  derived: number;
  errors: number;
  complete: boolean;
}

/**
 * Poll + derive account-lifecycle events for every live, non-removed app.
 * Apps without Partner API credentials are skipped (poll is a no-op for
 * them — see hasPartnerApiCredentials). Wire your scheduler to this once a
 * day, alongside the flex billing charge cron.
 */
export async function runCustomerEventsCron(): Promise<CustomerEventsCronSummary> {
  const requestedAt = new Date();
  const summary: CustomerEventsCronSummary = {
    appsProcessed: 0,
    appsComplete: 0,
    appsFresh: 0,
    appsSkipped: 0,
    appsInProgress: 0,
    fetched: 0,
    derived: 0,
    errors: 0,
    complete: false,
  };

  const apps = await prisma.app.findMany({
    where: { enabled: true, removed: false, scheduledForDeletionAt: null },
    include: { partnerConnection: true },
  });

  for (const app of apps) {
    summary.appsProcessed++;
    try {
      const result = await pollAccountLifecycleEvents(app, {
        maxPages: 10,
        requestedAt,
      });
      summary.fetched += result.fetched;
      let derivationComplete = true;
      if (!result.skipped && !result.inProgress) {
        const deriveDeadline = Date.now() + 15_000;
        for (let chunk = 0; chunk < 4; chunk += 1) {
          const derivation = await deriveAccountLifecycleEvents(app.id, {
            limit: 250,
          });
          summary.derived += derivation.derived;
          if (derivation.earliestOccurredAt) {
            await markInstallSnapshotDirty(app.id, derivation.earliestOccurredAt);
          }
          if (derivation.inProgress) {
            summary.appsInProgress++;
            derivationComplete = false;
            break;
          }
          if (!derivation.hasMore) break;
          if (chunk === 3 || Date.now() >= deriveDeadline) {
            derivationComplete = false;
            break;
          }
        }
      }
      const refreshedForThisRun =
        result.recentComplete &&
        result.freshThrough !== null &&
        result.freshThrough.getTime() >= requestedAt.getTime();
      if (refreshedForThisRun) summary.appsFresh++;
      if (result.skipped) summary.appsSkipped++;
      if (result.inProgress) summary.appsInProgress++;
      if (
        result.complete &&
        refreshedForThisRun &&
        derivationComplete &&
        !result.skipped &&
        !result.inProgress
      ) {
        summary.appsComplete++;
      }

      // Only run the install-snapshot writer once this app has no pending
      // derivation left — a mid-derivation run would rewrite a dirty range
      // against a lifecycle history that's about to change again.
      if (derivationComplete && !result.skipped && !result.inProgress) {
        await runInstallSnapshotSync(app, requestedAt);
      }
    } catch (err) {
      summary.errors++;
      log.error("customer-events cron failed for app", {
        appId: app.id,
        err: String(err),
      });
    }
  }

  summary.complete =
    summary.errors === 0 &&
    summary.appsProcessed > 0 &&
    summary.appsSkipped === 0 &&
    summary.appsInProgress === 0 &&
    summary.appsComplete === summary.appsProcessed;
  return summary;
}
