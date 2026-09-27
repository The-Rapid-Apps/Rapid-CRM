/**
 * Verification harness for the account-lifecycle derivation
 * (app/lib/customer-events/derive.server.ts) — the state machine that turns
 * `RawPartnerEvent` rows into clean `AccountLifecycleEvent`s.
 *
 * Unlike verify-flex.ts this needs a live DATABASE_URL (the derivation reads
 * and writes MySQL) — it does NOT exercise poll.server.ts, which needs a
 * real Partner API token. Creates its own throwaway Organization/App and
 * deletes them on exit (pass or fail).
 *
 * Run: npx tsx scripts/verify-customer-events.ts
 */
import assert from "node:assert";
import { prisma } from "../app/lib/db.server";
import { deriveAccountLifecycleEvents } from "../app/lib/customer-events/derive.server";

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

async function main() {
  const org = await prisma.organization.create({
    data: { name: "__verify_customer_events__" },
  });
  const app = await prisma.app.create({
    data: {
      organizationId: org.id,
      name: "verify-app",
      handle: `verify-app-${Date.now()}`,
      shopifyApiKey: "k",
      shopifyApiSecret: "s",
    },
  });

  try {
    const shopDomain = "verify-shop.myshopify.com";
    const t0 = new Date("2026-01-01T00:00:00Z");
    const hour = 60 * 60 * 1000;

    await prisma.rawPartnerEvent.createMany({
      data: [
        {
          appId: app.id,
          type: "RELATIONSHIP_INSTALLED",
          occurredAt: t0,
          shopDomain,
        },
        {
          appId: app.id,
          type: "RELATIONSHIP_UNINSTALLED",
          occurredAt: new Date(t0.getTime() + hour),
          shopDomain,
          reason: "It was too expensive for what it does",
        },
        {
          appId: app.id,
          type: "RELATIONSHIP_INSTALLED",
          occurredAt: new Date(t0.getTime() + 2 * hour),
          shopDomain,
        },
        {
          appId: app.id,
          type: "RELATIONSHIP_REACTIVATED",
          occurredAt: new Date(t0.getTime() + 3 * hour),
          shopDomain,
        },
      ],
    });

    const { derived } = await deriveAccountLifecycleEvents(app.id);
    await check("derives exactly one clean event per raw event", () => {
      assert.equal(derived, 4);
    });

    const events = await prisma.accountLifecycleEvent.findMany({
      where: { appInstall: { appId: app.id } },
      orderBy: { occurredAt: "asc" },
      include: { uninstallDetail: true },
    });

    await check("first install emits INSTALLED", () => {
      assert.equal(events[0]?.type, "INSTALLED");
    });
    await check(
      "uninstall emits UNINSTALLED with a normalized reason code",
      () => {
        assert.equal(events[1]?.type, "UNINSTALLED");
        assert.equal(events[1]?.uninstallDetail?.reasonCode, "high_cost");
      },
    );
    await check(
      "install after a prior install emits REINSTALLED, not INSTALLED again",
      () => {
        assert.equal(events[2]?.type, "REINSTALLED");
      },
    );
    await check("reactivate emits REACTIVATED", () => {
      assert.equal(events[3]?.type, "REACTIVATED");
    });

    const { derived: derivedAgain } = await deriveAccountLifecycleEvents(
      app.id,
    );
    await check(
      "re-deriving is idempotent (0 new events, no duplicates)",
      async () => {
        assert.equal(derivedAgain, 0);
        const count = await prisma.accountLifecycleEvent.count({
          where: { appInstall: { appId: app.id } },
        });
        assert.equal(count, 4);
      },
    );
  } finally {
    // Cascades to App/AppInstall/RawPartnerEvent/AccountLifecycleEvent/UninstallEventDetail.
    await prisma.organization.delete({ where: { id: org.id } });
  }

  console.log(
    `\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}.\n`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
