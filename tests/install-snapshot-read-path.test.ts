import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";
import {
  getChurnReport,
  getLtvReport,
  getPortfolioReport,
} from "../app/lib/reports/analytics.server";
import { computeDirtyRangeSnapshotRows } from "../app/lib/reports/install-snapshot.server";

/**
 * Proves the install-snapshot read path (Phase 4) produces byte-for-byte the
 * same report output as the live `loadInstalls`-based path, for the exact
 * fields the plan targets: `ChurnReport.logo`, `PortfolioReport.installs`,
 * and `LtvReport`'s logo-churn fallback. Requires
 * `INSTALL_SNAPSHOT_READ_PATH_ENABLED=true` in the environment — the flag is
 * read once at process start (see `env.server.ts`), so this file must be run
 * as its own process with the var set, e.g.:
 *
 *   INSTALL_SNAPSHOT_READ_PATH_ENABLED=true npx tsx --test \
 *     --import ./tests/redis-teardown.ts tests/install-snapshot-read-path.test.ts
 *
 * Under the default `npm test` (flag off), every case here skips outright —
 * it does NOT silently pass as a trivial live-vs-live comparison, since that
 * would be a false sense of coverage.
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function day(n: number): Date {
  return new Date(Date.UTC(2025, 0, 1 + n));
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  const apps = await prisma.app.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const appIds = apps.map((app) => app.id);
  if (appIds.length) {
    await prisma.partnerDailyInstallSnapshot.deleteMany({
      where: { appId: { in: appIds } },
    });
    await prisma.subscription.deleteMany({
      where: { appInstall: { appId: { in: appIds } } },
    });
    await prisma.appInstall.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.plan.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.app.deleteMany({ where: { id: { in: appIds } } });
  }
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function createInstall(
  appId: string,
  shopDomain: string,
  installedAt: Date,
  uninstalledAt: Date | null,
  events: Array<{ type: string; occurredAt: Date; isStoreClosure?: boolean }>,
): Promise<void> {
  const install = await prisma.appInstall.create({
    data: { appId, shopDomain, installedAt, uninstalledAt },
  });
  for (const event of events) {
    const created = await prisma.accountLifecycleEvent.create({
      data: {
        appId,
        appInstallId: install.id,
        type: event.type as never,
        occurredAt: event.occurredAt,
        platformEventId: id(`${shopDomain}-${event.type}`),
      },
    });
    if (event.type === "UNINSTALLED") {
      await prisma.uninstallEventDetail.create({
        data: {
          eventId: created.id,
          reasonCode: "unknown_other",
          reasonCodes: ["unknown_other"],
          isStoreClosure: event.isStoreClosure ?? false,
        },
      });
    }
  }
}

async function fixtureApp(t: TestContext): Promise<{ organizationId: string; appId: string }> {
  const suffix = id("install-snapshot-read-path");
  const organization = await prisma.organization.create({
    data: { name: `Install snapshot read path ${suffix}` },
  });
  t.after(() => cleanupOrganization(organization.id));
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Install snapshot read path app ${suffix}`,
      handle: `install-snapshot-read-path-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
    },
  });
  const plan = await prisma.plan.create({
    data: {
      appId: app.id,
      name: "Monthly",
      amount: "20",
      recurringInterval: "MONTH",
      recurringIntervalCount: 1,
      usageChargeCappedAmount: "500",
    },
  });
  // Kept intentionally test-only (activatedAt long in the past, never
  // canceled) — just enough for getLtvReport to have a non-empty currency
  // set, which is what actually turns on its logo-churn fallback branch.
  const anchorInstall = await prisma.appInstall.create({
    data: { appId: app.id, shopDomain: "ltv-anchor.myshopify.com", installedAt: day(0) },
  });
  await prisma.subscription.create({
    data: {
      appInstallId: anchorInstall.id,
      planId: plan.id,
      status: "ACTIVE",
      test: false,
      activatedAt: day(0),
      currentPeriodStart: day(0),
      currentPeriodEnd: day(30),
    },
  });
  return { organizationId: organization.id, appId: app.id };
}

after(async () => {
  await prisma.$disconnect();
});

test("install-snapshot read path matches the live path for churn, portfolio, and LTV", async (t) => {
  if (!env.INSTALL_SNAPSHOT_READ_PATH_ENABLED) {
    t.skip("requires INSTALL_SNAPSHOT_READ_PATH_ENABLED=true — see file header");
    return;
  }

  const { organizationId, appId } = await fixtureApp(t);

  await createInstall(appId, "always-active.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
  ]);
  await createInstall(appId, "deactivate-reactivate.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
    { type: "DEACTIVATED", occurredAt: day(5) },
    { type: "REACTIVATED", occurredAt: day(12) },
  ]);
  await createInstall(appId, "uninstalled-mid.myshopify.com", day(3), null, [
    { type: "INSTALLED", occurredAt: day(3) },
    { type: "UNINSTALLED", occurredAt: day(15) },
  ]);
  await createInstall(appId, "new-mid-range.myshopify.com", day(8), null, [
    { type: "INSTALLED", occurredAt: day(8) },
  ]);
  await createInstall(appId, "store-closure.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
    { type: "UNINSTALLED", occurredAt: day(2), isStoreClosure: true },
  ]);

  const query = {
    organizationId,
    appId,
    start: day(0),
    end: day(19),
    interval: "day" as const,
  };

  const liveChurn = await getChurnReport(query);
  const livePortfolio = await getPortfolioReport(query);
  const liveLtv = await getLtvReport(query);

  // Populate the snapshot table for exactly the range the report needs,
  // then mark the app's floor date so readiness treats it as fully covered
  // — mirroring what `runInstallSnapshotSync` would do, without needing the
  // full cron/lease machinery for this test.
  const floorDate = day(0);
  await prisma.app.update({
    where: { id: appId },
    data: { installSnapshotFloorDate: floorDate },
  });
  const rows = await computeDirtyRangeSnapshotRows(appId, floorDate, day(19), 0, null);
  await prisma.partnerDailyInstallSnapshot.createMany({ data: rows });

  const snapshotChurn = await getChurnReport(query);
  const snapshotPortfolio = await getPortfolioReport(query);
  const snapshotLtv = await getLtvReport(query);

  assert.deepEqual(snapshotChurn.logo, liveChurn.logo);
  assert.deepEqual(snapshotPortfolio.installs, livePortfolio.installs);
  assert.deepEqual(snapshotLtv, liveLtv);
});
