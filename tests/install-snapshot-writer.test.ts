import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import {
  buildDailyInstallStocks,
  computeDirtyRangeSnapshotRows,
  utcDayRange,
  type InstallActivitySource,
} from "../app/lib/reports/install-snapshot.server";

/**
 * Proves the incremental dirty-range writer (`computeDirtyRangeSnapshotRows`,
 * built on the "synthetic opening-balance event" resumption technique) is
 * exactly equivalent to a from-scratch full-history recompute — the property
 * the whole incremental design depends on. If this ever regresses, the
 * snapshot table would silently start reporting a wrong active-install count
 * for every app after its first dirty-range write.
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + n));
}

async function cleanupApp(appId: string, organizationId: string): Promise<void> {
  await prisma.appInstall.deleteMany({ where: { appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixtureApp(t: TestContext): Promise<string> {
  const suffix = id("install-snapshot-writer");
  const organization = await prisma.organization.create({
    data: { name: `Install snapshot writer ${suffix}` },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Install snapshot writer app ${suffix}`,
      handle: `install-snapshot-writer-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
    },
  });
  t.after(() => cleanupApp(app.id, organization.id));
  return app.id;
}

async function createInstall(
  appId: string,
  shopDomain: string,
  installedAt: Date,
  uninstalledAt: Date | null,
  events: Array<{ type: string; occurredAt: Date }>,
): Promise<string> {
  const install = await prisma.appInstall.create({
    data: { appId, shopDomain, installedAt, uninstalledAt },
  });
  for (const event of events) {
    await prisma.accountLifecycleEvent.create({
      data: {
        appId,
        appInstallId: install.id,
        type: event.type as never,
        occurredAt: event.occurredAt,
        platformEventId: id(`${shopDomain}-${event.type}`),
      },
    });
  }
  return install.id;
}

/** Ground truth: every install's real, complete history — no synthetic
 * events, no touched-set narrowing — folded from day 0 with anchor 0. */
async function fullRecomputeStocks(appId: string, days: Date[]) {
  const installs = await prisma.appInstall.findMany({
    where: { appId },
    select: {
      installedAt: true,
      uninstalledAt: true,
      lifecycleEvents: {
        select: { type: true, occurredAt: true },
        orderBy: { occurredAt: "asc" },
      },
    },
  });
  const sources: InstallActivitySource[] = installs.map((i) => ({
    installedAt: i.installedAt,
    uninstalledAt: i.uninstalledAt,
    events: i.lifecycleEvents,
  }));
  return buildDailyInstallStocks(sources, days, 0);
}

after(async () => {
  await prisma.$disconnect();
});

test("incremental dirty-range rewrite matches a full-history recompute exactly, across a mixed population", async (t) => {
  const appId = await fixtureApp(t);

  // Untouched throughout the dirty window: contributes only via the anchor.
  await createInstall(appId, "always-active.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
  ]);

  // Deactivated exactly at the dirty-window boundary (day 10) — the case
  // most likely to expose a synthetic-event ordering bug at the boundary.
  await createInstall(appId, "deactivated-at-boundary.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
    { type: "DEACTIVATED", occurredAt: day(10) },
  ]);

  // Deactivated before the window, reactivated inside it — the opening
  // balance must correctly resume as "inactive" for this install.
  await createInstall(appId, "reactivated-inside-window.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
    { type: "DEACTIVATED", occurredAt: day(3) },
    { type: "REACTIVATED", occurredAt: day(14) },
  ]);

  // Uninstalled inside the window — real UNINSTALLED event, was active before.
  await createInstall(appId, "uninstalled-inside-window.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
    { type: "UNINSTALLED", occurredAt: day(16) },
  ]);

  // Brand new within the window — the "genuinely new" branch, not a resume.
  await createInstall(appId, "new-inside-window.myshopify.com", day(12), null, [
    { type: "INSTALLED", occurredAt: day(12) },
  ]);

  // Never touched, already gone before the window — must stay excluded from
  // the touched set entirely and not affect the anchor-driven days.
  await createInstall(appId, "long-gone.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
    { type: "UNINSTALLED", occurredAt: day(2) },
  ]);

  const allDays = utcDayRange(day(0), day(20));
  const groundTruth = await fullRecomputeStocks(appId, allDays);

  const dirtyFrom = day(10);
  const todayStart = day(20);
  const anchorDay = day(9);
  const anchor = groundTruth.get(anchorDay.getTime())!.activeInstallsAtDayEnd;

  const rows = await computeDirtyRangeSnapshotRows(
    appId,
    dirtyFrom,
    todayStart,
    anchor,
    null,
  );

  const dirtyDays = utcDayRange(dirtyFrom, todayStart);
  assert.equal(rows.length, dirtyDays.length);

  for (const row of rows) {
    const expected = groundTruth.get(row.snapshotDate.getTime());
    assert.ok(expected, `ground truth missing for ${row.snapshotDate.toISOString()}`);
    assert.equal(
      row.activeInstallsAtDayStart,
      expected!.activeInstallsAtDayStart,
      `activeInstallsAtDayStart mismatch on ${row.snapshotDate.toISOString()}`,
    );
    assert.equal(
      row.activeInstallsAtDayEnd,
      expected!.activeInstallsAtDayEnd,
      `activeInstallsAtDayEnd mismatch on ${row.snapshotDate.toISOString()}`,
    );
  }

  // Spot-check the flow fields on the days each event actually happened.
  const byDate = new Map(rows.map((r) => [r.snapshotDate.getTime(), r]));
  assert.equal(byDate.get(day(10).getTime())!.deactivations, 1);
  assert.equal(byDate.get(day(12).getTime())!.newInstalls, 1);
  assert.equal(byDate.get(day(14).getTime())!.reactivations, 1);
  assert.equal(byDate.get(day(16).getTime())!.uninstallsAll, 1);
  assert.equal(byDate.get(day(16).getTime())!.logoLost, 1);
});

test("a dirty range with no touched installs stays flat at the anchor", async (t) => {
  const appId = await fixtureApp(t);
  await createInstall(appId, "untouched.myshopify.com", day(0), null, [
    { type: "INSTALLED", occurredAt: day(0) },
  ]);

  const rows = await computeDirtyRangeSnapshotRows(appId, day(10), day(15), 7, null);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.activeInstallsAtDayStart, 7);
    assert.equal(row.activeInstallsAtDayEnd, 7);
    assert.equal(row.newInstalls, 0);
    assert.equal(row.uninstallsAll, 0);
  }
});
