import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { prisma } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";
import { getTrafficSourcesReport } from "../app/lib/reports/traffic-sources.server";

/**
 * Proves the local `TrafficEventFact` read path produces a correct
 * `TrafficSourcesReport` — funnel counts, per-row dimension attribution
 * (including the visitor-lookback join for page-view-only dimensions), and
 * MRR/CLV shop-domain join — from seeded local facts, with no BigQuery call
 * involved. This is deliberately NOT a live-BigQuery-vs-local diff (that
 * comparison is the separate, mandatory production parity check against real
 * GA4 data before any rollout flag flips on) — it verifies the local
 * aggregation itself is correct against hand-computed expectations.
 *
 * Requires `TRAFFIC_LOCAL_READ_PATH_ENABLED=true` in the environment — the
 * flag is read once at process start (see env.server.ts), so this file must
 * run as its own process with the var set:
 *
 *   TRAFFIC_LOCAL_READ_PATH_ENABLED=true npx tsx --test \
 *     --import ./tests/redis-teardown.ts tests/traffic-local-read-path.test.ts
 *
 * Under the default `npm test` (flag off) this skips outright rather than
 * silently passing as a trivial no-op.
 */

function id(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + n));
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  const apps = await prisma.app.findMany({ where: { organizationId }, select: { id: true } });
  const appIds = apps.map((app) => app.id);
  if (appIds.length) {
    await prisma.trafficEventFact.deleteMany({ where: { appId: { in: appIds } } });
    await prisma.app.deleteMany({ where: { id: { in: appIds } } });
  }
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

async function fixtureApp(t: TestContext): Promise<{ appId: string }> {
  const suffix = id("traffic-local-read-path");
  const organization = await prisma.organization.create({
    data: { name: `Traffic local read path ${suffix}` },
  });
  t.after(() => cleanupOrganization(organization.id));
  const app = await prisma.app.create({
    data: {
      organizationId: organization.id,
      name: `Traffic local read path app ${suffix}`,
      handle: `traffic-local-read-path-${suffix}`,
      shopifyApiKey: `key-${suffix}`,
      shopifyApiSecret: `secret-${suffix}`,
      bigqueryDataset: "unused-in-local-mode",
      // Backfill "completed", and synced "just now" — satisfies
      // getTrafficSourcesReport's localReadiness gate (a real-time staleness
      // check against Date.now(), not the fixture's own fake calendar)
      // without a real GA4/BigQuery dependency.
      trafficEventsBackfillCompletedAt: day(0),
      trafficEventsSyncedAt: new Date(),
    },
  });
  return { appId: app.id };
}

interface FactOverrides {
  eventName: string;
  eventTimestamp: Date;
  userPseudoId: string;
  shopUrl?: string;
  pageLocation?: string;
  pageReferrer?: string;
  campaign?: string;
  trafficSourceName?: string;
  trafficSourceMedium?: string;
  trafficSourceSource?: string;
  language?: string;
  country?: string;
}

async function seedFact(appId: string, overrides: FactOverrides): Promise<void> {
  await prisma.trafficEventFact.create({
    data: {
      appId,
      dedupeKey: id("fact"),
      eventDate: new Date(
        Date.UTC(
          overrides.eventTimestamp.getUTCFullYear(),
          overrides.eventTimestamp.getUTCMonth(),
          overrides.eventTimestamp.getUTCDate(),
        ),
      ),
      ...overrides,
    },
  });
}

after(async () => {
  await prisma.$disconnect();
});

test("local read path: direct funnel counts, dimension grouping, and the visitor-lookback join", async (t) => {
  if (!env.TRAFFIC_LOCAL_READ_PATH_ENABLED) {
    t.skip("requires TRAFFIC_LOCAL_READ_PATH_ENABLED=true — see file header");
    return;
  }

  const { appId } = await fixtureApp(t);

  // Visitor A: views the listing page via a campaign link, then installs —
  // the install itself carries no page_location (matches real GA4 behavior),
  // so "campaign" must come from the visitor-lookback join to their own
  // earlier view_item, not straight off the install event.
  await seedFact(appId, {
    eventName: "view_item",
    eventTimestamp: day(1),
    userPseudoId: "visitor-a",
    pageLocation: "https://apps.shopify.com/acme?utm_campaign=spring-launch",
    trafficSourceSource: "(direct)",
  });
  await seedFact(appId, {
    eventName: "shopify_app_install",
    eventTimestamp: day(1),
    userPseudoId: "visitor-a",
    shopUrl: "shop-a.myshopify.com",
    trafficSourceSource: "(direct)",
  });

  // Visitor B: views the listing page with no campaign, never installs —
  // only counts toward "App Listing Page View", not "Installed".
  await seedFact(appId, {
    eventName: "view_item",
    eventTimestamp: day(2),
    userPseudoId: "visitor-b",
    pageLocation: "https://apps.shopify.com/acme",
    trafficSourceSource: "google",
  });

  // Visitor C: installs directly with no prior view_item — campaign should
  // resolve to "(not set)" (no view to join against), not crash or leak
  // visitor A's dimensions.
  await seedFact(appId, {
    eventName: "shopify_app_install",
    eventTimestamp: day(3),
    userPseudoId: "visitor-c",
    shopUrl: "shop-c.myshopify.com",
    trafficSourceSource: "shopify",
  });

  const report = await getTrafficSourcesReport(
    { start: day(0), end: day(10), interval: "day" },
    ["campaign"],
    ["listing_view", "installed"],
    1,
    50,
    {},
    undefined,
    "unused-in-local-mode",
    "unused-in-local-mode",
    appId,
    day(0),
    new Date(),
  );

  assert.equal(report.available, true, report.error);
  assert.equal(report.totals.listing_view, 2, "2 view_item events");
  assert.equal(report.totals.installed, 2, "2 shopify_app_install events");

  const byCampaign = new Map(report.rows.map((row) => [row.dimensions.campaign, row]));
  const campaignRow = byCampaign.get("spring-launch");
  assert.ok(campaignRow, "expected a row for the spring-launch campaign");
  assert.equal(campaignRow!.funnel.installed, 1, "visitor-a's install attributes to spring-launch via the lookback join");

  const notSetRow = byCampaign.get("(not set)");
  assert.ok(notSetRow, "expected a row for (not set)");
  // visitor-b's view (no campaign) + visitor-c's install (no prior view to join).
  assert.equal(notSetRow!.funnel.listing_view, 1);
  assert.equal(notSetRow!.funnel.installed, 1);
});

test("local read path: MRR/CLV shop-domain attribution finds no shops when nothing installed", async (t) => {
  if (!env.TRAFFIC_LOCAL_READ_PATH_ENABLED) {
    t.skip("requires TRAFFIC_LOCAL_READ_PATH_ENABLED=true — see file header");
    return;
  }

  const { appId } = await fixtureApp(t);
  await seedFact(appId, {
    eventName: "view_item",
    eventTimestamp: day(1),
    userPseudoId: "visitor-x",
    pageLocation: "https://apps.shopify.com/acme",
    trafficSourceSource: "shopify",
  });

  const report = await getTrafficSourcesReport(
    { start: day(0), end: day(10), interval: "day" },
    ["source"],
    ["listing_view"],
    1,
    50,
    {},
    undefined,
    "unused-in-local-mode",
    "unused-in-local-mode",
    appId,
    day(0),
    new Date(),
  );

  assert.equal(report.available, true, report.error);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]!.mrr, 0);
  assert.equal(report.rows[0]!.clv, null);
});
