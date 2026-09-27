import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import { getChurnReport, getPortfolioReport } from "../app/lib/reports/analytics.server";

/**
 * Proves `loadInstalls`'s opening-balance bound (added to stop its lifecycle
 * read scaling with account age — see the reports performance audit) doesn't
 * lose an install that has been active for a long time with no lifecycle
 * events inside the report window at all. This is the exact case a naive
 * "just add `occurredAt >= windowStart`" bound would silently break: with no
 * opening-balance event, `installIsActiveAt` would see an empty
 * `lifecycleEvents` array and fall back to `installedAt`/`uninstalledAt`,
 * which happens to still work for a never-uninstalled install — so the real
 * risk is specifically installs whose *lifecycle event history* (not the
 * plain `installedAt`/`uninstalledAt` columns) is the source of truth for
 * their state at the window start, e.g. one reactivated long before the
 * window and never touched since.
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function cleanupApp(appId: string, organizationId: string): Promise<void> {
  await prisma.appInstall.deleteMany({ where: { appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixtureApp(t: TestContext): Promise<{ appId: string; organizationId: string }> {
  const suffix = id("installs-bounding");
  const organization = await prisma.organization.create({
    data: { name: `Installs bounding ${suffix}` },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Installs bounding app ${suffix}`,
      handle: `installs-bounding-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
    },
  });
  t.after(() => cleanupApp(app.id, organization.id));
  return { appId: app.id, organizationId: organization.id };
}

after(async () => {
  await prisma.$disconnect();
});

test("an install deactivated long before the report window, with nothing since, is correctly excluded from the active denominator", async (t) => {
  const { appId, organizationId } = await fixtureApp(t);

  // DEACTIVATED never touches the `installedAt`/`uninstalledAt` columns —
  // only a real `UNINSTALLED` event does. So if the opening-balance event
  // were missing (the exact failure mode a naive "just add `occurredAt >=
  // windowStart`" bound would produce), `installIsActiveAt` would find an
  // empty `lifecycleEvents` array for the window and fall back to
  // `installedAt <= at && !uninstalledAt`, which is true here regardless —
  // incorrectly reporting this install as active. Only correctly carrying
  // the DEACTIVATED event forward as the opening balance gives the right
  // (inactive) answer.
  const install = await prisma.appInstall.create({
    data: {
      appId,
      shopDomain: "deactivated-long-ago.myshopify.com",
      installedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  await prisma.accountLifecycleEvent.create({
    data: {
      appId,
      appInstallId: install.id,
      type: "INSTALLED",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      platformEventId: id("installed"),
    },
  });
  await prisma.accountLifecycleEvent.create({
    data: {
      appId,
      appInstallId: install.id,
      type: "DEACTIVATED",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      platformEventId: id("deactivated"),
    },
  });

  const range = {
    period: "all_time" as const,
    start: new Date("2026-06-01T00:00:00.000Z"),
    end: new Date("2026-07-01T00:00:00.000Z"),
    interval: "day" as const,
  };

  const churn = await getChurnReport({ organizationId, appId }, range);
  assert.equal(
    churn.logo.timeSeries[0]?.denominator,
    0,
    "a deactivated (not reinstalled) install must NOT count in the active denominator",
  );

  const portfolio = await getPortfolioReport({ organizationId, appId }, range);
  assert.equal(
    portfolio.installs.activeNow,
    0,
    "a deactivated (not reinstalled) install must not count as currently active",
  );
});

test("an install reactivated long before the report window still counts as active at the window start", async (t) => {
  const { appId, organizationId } = await fixtureApp(t);

  // Mirrors the real pipeline invariant this bound relies on: a
  // RELATIONSHIP_INSTALLED/REACTIVATED event always clears `uninstalledAt`
  // back to null (see `derive.server.ts`), so a currently-active,
  // reactivated-long-ago install looks like this, not like a stale
  // `uninstalledAt` the fallback columns would misread.
  const install = await prisma.appInstall.create({
    data: {
      appId,
      shopDomain: "reactivated-long-ago.myshopify.com",
      installedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  await prisma.accountLifecycleEvent.create({
    data: {
      appId,
      appInstallId: install.id,
      type: "INSTALLED",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      platformEventId: id("installed"),
    },
  });
  await prisma.accountLifecycleEvent.create({
    data: {
      appId,
      appInstallId: install.id,
      type: "UNINSTALLED",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
      platformEventId: id("uninstalled"),
    },
  });
  await prisma.accountLifecycleEvent.create({
    data: {
      appId,
      appInstallId: install.id,
      type: "REINSTALLED",
      occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      platformEventId: id("reinstalled"),
    },
  });

  const range = {
    period: "all_time" as const,
    start: new Date("2026-06-01T00:00:00.000Z"),
    end: new Date("2026-07-01T00:00:00.000Z"),
    interval: "day" as const,
  };

  const churn = await getChurnReport({ organizationId, appId }, range);
  assert.equal(
    churn.logo.timeSeries[0]?.denominator,
    1,
    "the reactivated install must count in the very first bucket's active denominator",
  );

  const portfolio = await getPortfolioReport({ organizationId, appId }, range);
  assert.equal(
    portfolio.installs.activeNow,
    1,
    "the reactivated install must count as currently active",
  );
});
