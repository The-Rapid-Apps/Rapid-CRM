/**
 * Fills a fresh database with a FICTIONAL app portfolio, so the dashboard can
 * be explored without connecting a real Shopify Partner organization.
 *
 *   npm run db:seed-demo              # create the demo portfolio
 *   REMOVE=1 npm run db:seed-demo     # delete it again
 *
 * Every app it creates has a `demo-` handle and every shop is an invented
 * `*.myshopify.com` name; nothing here is real data. It writes the same raw
 * Partner facts a real sync would (subscription events, sales, install
 * lifecycle) and marks the syncs complete, so every report reconstructs its
 * figures exactly as it would from live data.
 *
 * Guard rails: refuses to run in production, and refuses to add demo apps to a
 * database that already holds real ones. The data is deterministic (seeded
 * random numbers), so re-running after REMOVE=1 reproduces the same portfolio.
 */
import { createHash } from "node:crypto";
import { prisma } from "../app/lib/db.server";
import { normalizeUninstallReason } from "../app/lib/customer-events/uninstall-reason";

const DAY = 86_400_000;
const HANDLE_PREFIX = "demo-";
const HISTORY_DAYS = 540;

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data with NODE_ENV=production.");
  process.exit(1);
}

/* ---------- deterministic randomness ---------- */
let seed = 20260927;
function random(): number {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => random() < p;
const between = (min: number, max: number) => min + random() * (max - min);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
function weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [item, w] of items) {
    roll -= w;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]![0];
}

/* ---------- the fictional portfolio ---------- */
type DemoPlan = { name: string; amount: number; annual?: boolean; weight: number };
type DemoApp = {
  handle: string;
  name: string;
  trialDays: number;
  installsPerDay: [number, number]; // at the start of history, and today
  subscribeRate: number;
  monthlyChurn: number;
  plans: DemoPlan[];
};

const APPS: DemoApp[] = [
  {
    handle: "demo-upsell",
    name: "Acme Upsell",
    trialDays: 14,
    installsPerDay: [3, 9],
    subscribeRate: 0.42,
    monthlyChurn: 0.035,
    plans: [
      { name: "Starter", amount: 9.99, weight: 5 },
      { name: "Pro", amount: 29.99, weight: 3 },
      { name: "Plus", amount: 79.99, weight: 1 },
      { name: "Starter", amount: 99.99, annual: true, weight: 1 },
      { name: "Pro", amount: 299.99, annual: true, weight: 0.6 },
    ],
  },
  {
    handle: "demo-reviews",
    name: "Acme Reviews",
    trialDays: 7,
    installsPerDay: [2, 5],
    subscribeRate: 0.35,
    monthlyChurn: 0.045,
    plans: [
      { name: "Basic", amount: 7.99, weight: 5 },
      { name: "Growth", amount: 19.99, weight: 2 },
    ],
  },
  {
    handle: "demo-pixel",
    name: "Acme Pixel",
    trialDays: 14,
    installsPerDay: [1, 4],
    subscribeRate: 0.5,
    monthlyChurn: 0.03,
    plans: [
      { name: "Monthly", amount: 14.99, weight: 4 },
      { name: "Yearly", amount: 149.99, annual: true, weight: 1 },
    ],
  },
];

const ADJECTIVES = ["blue", "golden", "urban", "little", "wild", "north", "silver", "happy", "coastal", "cedar", "maple", "bright", "velvet", "rustic", "lunar", "sunny"];
const NOUNS = ["harbor", "fox", "leaf", "studio", "goods", "threads", "pantry", "atelier", "market", "supply", "candle", "bloom", "outfitters", "ceramics", "coffee", "boutique"];
const COUNTRIES = ["United States", "United Kingdom", "Canada", "Australia", "Germany", "France", "Netherlands", "Spain"];
const UNINSTALL_REASONS: ReadonlyArray<readonly [string, number]> = [
  ["scheduled_cancellation", 5],
  ["Not using it anymore", 4],
  ["Too expensive for my store right now", 3],
  ["Missing features I needed", 2],
  ["Found another app, switched to a competitor", 2],
  ["Hard to set up, too complicated", 1],
  ["Just testing, trying out a few apps", 3],
  ["Closing my store", 1],
];
const REVIEW_TEXT = [
  "Setup took five minutes and it worked right away. Support answered within the hour.",
  "Exactly what I needed. Conversion went up the first week.",
  "Great app, great team. Helped me customise it for my theme.",
  "Solid and reliable. Would love a few more design options.",
  "Does the job. A bit pricey for a small store but worth it.",
  "Very easy to use and the support chat is fantastic.",
  "",
];

/* ---------- builders ---------- */
let chargeSeq = 1_000_000;
let saleSeq = 1;

type Rows = {
  installs: Array<{ id: string; appId: string; shopDomain: string; shopName: string; installedAt: Date; uninstalledAt: Date | null }>;
  lifecycle: Array<{ id: string; appInstallId: string; appId: string; type: "INSTALLED" | "UNINSTALLED"; occurredAt: Date; platformEventId: string }>;
  uninstallDetails: Array<{ eventId: string; reason: string; reasonCode: string; reasonCodes: string[]; isStoreClosure: boolean }>;
  events: Array<Record<string, unknown>>;
  sales: Array<Record<string, unknown>>;
};

function cuidLike(prefix: string, n: number): string {
  return `${prefix}${n.toString(36).padStart(8, "0")}${Math.floor(random() * 1e8).toString(36)}`;
}

function dedupeKey(appId: string, type: string, occurredAt: Date, shopDomain: string, chargeId: string) {
  return createHash("sha256")
    .update([appId, type, occurredAt.toISOString(), shopDomain, chargeId].join("\u001f"))
    .digest("hex");
}

function simulateApp(app: DemoApp, appId: string, now: Date, rows: Rows, shopCounter: { n: number }) {
  const start = now.getTime() - HISTORY_DAYS * DAY;
  let idSeq = 0;

  const event = (type: string, at: Date, shopDomain: string, charge: { id: string; name: string; amount: number }, billingOn: Date | null) => {
    rows.events.push({
      appId,
      dedupeKey: dedupeKey(appId, type, at, shopDomain, charge.id),
      type,
      occurredAt: at,
      shopDomain,
      chargePlatformId: charge.id,
      chargeName: charge.name,
      amount: charge.amount.toFixed(2),
      currencyCode: "USD",
      billingOn,
      test: false,
    });
  };

  for (let day = 0; day < HISTORY_DAYS; day += 1) {
    const progress = day / HISTORY_DAYS;
    const rate = app.installsPerDay[0] + (app.installsPerDay[1] - app.installsPerDay[0]) * progress;
    const installsToday = Math.max(0, Math.round(rate + between(-1.5, 1.5)));

    for (let i = 0; i < installsToday; i += 1) {
      shopCounter.n += 1;
      const words = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
      const shopDomain = `${words}-${shopCounter.n}.myshopify.com`;
      const shopName = words.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
      const installedAt = new Date(start + day * DAY + between(0, DAY));
      if (installedAt > now) continue;

      const installId = cuidLike("demoinst", (idSeq += 1)) + app.handle.slice(5, 8);
      let uninstalledAt: Date | null = null;
      let uninstallReason: string | null = null;

      /* ---- subscription journey ---- */
      if (chance(app.subscribeRate)) {
        const plan = weighted(app.plans.map((p) => [p, p.weight] as const));
        const activatedAt = new Date(installedAt.getTime() + between(0.01, 2) * DAY);
        if (activatedAt < now) {
          const periodDays = plan.annual ? 365 : 30;
          const trialEnd = new Date(activatedAt.getTime() + app.trialDays * DAY);
          let charge = { id: `gid://shopify/AppSubscription/${(chargeSeq += 1)}`, name: plan.name, amount: plan.amount };
          event("SUBSCRIPTION_CHARGE_ACTIVATED", activatedAt, shopDomain, charge, trialEnd);

          let endedAt: Date | null = null;
          if (chance(0.28)) {
            // Cancels during the trial.
            endedAt = new Date(activatedAt.getTime() + between(1, app.trialDays) * DAY);
          } else {
            // Paying: one sale per period until churn (or today).
            let periodStart = trialEnd;
            let upgraded = false;
            while (periodStart < now) {
              saleSeq += 1;
              rows.sales.push({
                appId,
                transactionPlatformId: `gid://partners/AppSubscriptionSale/demo-${saleSeq}`,
                chargePlatformId: charge.id,
                occurredAt: new Date(periodStart.getTime() + between(0, 0.2) * DAY),
                shopDomain,
                billingInterval: plan.annual ? "ANNUAL" : "EVERY_30_DAYS",
                grossAmount: charge.amount.toFixed(2),
                netAmount: (charge.amount * 0.85).toFixed(2),
                shopifyFee: (charge.amount * 0.15).toFixed(2),
                currencyCode: "USD",
              });
              const next = new Date(periodStart.getTime() + periodDays * DAY);
              const churnP = plan.annual ? 0.2 : app.monthlyChurn;
              if (chance(churnP) && next < now) {
                endedAt = new Date(periodStart.getTime() + between(3, periodDays - 1) * DAY);
                break;
              }
              // Occasional upgrade to the next monthly tier.
              const higher = app.plans.find((p) => !p.annual && p.amount > charge.amount && !plan.annual);
              if (!upgraded && higher && chance(0.06) && next < now) {
                upgraded = true;
                const at = new Date(periodStart.getTime() + between(2, 20) * DAY);
                event("SUBSCRIPTION_CHARGE_CANCELED", at, shopDomain, charge, null);
                charge = { id: `gid://shopify/AppSubscription/${(chargeSeq += 1)}`, name: higher.name, amount: higher.amount };
                event("SUBSCRIPTION_CHARGE_ACTIVATED", new Date(at.getTime() + 1000), shopDomain, charge, new Date(at.getTime() + 30 * DAY));
                periodStart = new Date(at.getTime() + 30 * DAY);
                continue;
              }
              periodStart = next;
            }
          }
          if (endedAt && endedAt < now) {
            event("SUBSCRIPTION_CHARGE_CANCELED", endedAt, shopDomain, charge, null);
            if (chance(0.8)) {
              uninstalledAt = new Date(endedAt.getTime() + between(0, 2) * DAY);
              uninstallReason = weighted(UNINSTALL_REASONS);
            }
          }
        }
      } else if (chance(0.7)) {
        // Never paid, and left again.
        uninstalledAt = new Date(installedAt.getTime() + between(0.1, 30) * DAY);
        uninstallReason = weighted(UNINSTALL_REASONS);
      }
      if (uninstalledAt && uninstalledAt > now) uninstalledAt = null;

      rows.installs.push({ id: installId, appId, shopDomain, shopName, installedAt, uninstalledAt });
      const installEventId = `${installId}-i`;
      rows.lifecycle.push({ id: installEventId, appInstallId: installId, appId, type: "INSTALLED", occurredAt: installedAt, platformEventId: `demo:${installEventId}` });
      if (uninstalledAt) {
        const eventId = `${installId}-u`;
        rows.lifecycle.push({ id: eventId, appInstallId: installId, appId, type: "UNINSTALLED", occurredAt: uninstalledAt, platformEventId: `demo:${eventId}` });
        const normalized = normalizeUninstallReason(uninstallReason, null);
        rows.uninstallDetails.push({ eventId, reason: uninstallReason ?? "", ...normalized });
      }
    }
  }
}

async function inBatches<T>(items: T[], size: number, write: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) await write(items.slice(i, i + size));
}

async function remove() {
  const apps = await prisma.app.findMany({ where: { handle: { startsWith: HANDLE_PREFIX } }, select: { id: true } });
  const appIds = apps.map((a) => a.id);
  await prisma.discount.deleteMany({ where: { appId: { in: appIds } } });
  const { count } = await prisma.app.deleteMany({ where: { id: { in: appIds } } });
  console.log(`Removed ${count} demo app(s) and everything attached to them.`);
}

async function main() {
  if (process.env.REMOVE === "1") return remove();

  const realApps = await prisma.app.count({ where: { NOT: { handle: { startsWith: HANDLE_PREFIX } } } });
  if (realApps > 0) {
    throw new Error(`This database already has ${realApps} real app(s). Demo data only goes into a fresh database.`);
  }
  if (await prisma.app.count({ where: { handle: { startsWith: HANDLE_PREFIX } } })) {
    throw new Error("Demo data is already seeded. Run with REMOVE=1 first to rebuild it.");
  }

  const org =
    (await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await prisma.organization.create({ data: { name: "Demo" } }));
  const now = new Date();
  const shopCounter = { n: 0 };

  for (const demo of APPS) {
    const app = await prisma.app.create({
      data: {
        organizationId: org.id,
        name: demo.name,
        handle: demo.handle,
        shopifyApiKey: `demo-${demo.handle}`,
        shopifyApiSecret: "demo-not-a-secret",
        shopifyAppId: `gid://partners/App/${9_000_000 + APPS.indexOf(demo)}`,
        partnerAppVerifiedAt: now,
        // Marks every sync complete and fresh, so reports treat the facts
        // below as the full history — exactly as after a real backfill.
        billingEventsSyncedAt: now,
        billingEventsBackfillCompletedAt: now,
        billingSalesSyncedAt: now,
        billingSalesBackfillCompletedAt: now,
        lifecycleEventsSyncedAt: now,
        lifecycleEventsBackfillCompletedAt: now,
        partnerStateBackfillCompletedAt: now,
        partnerStateInstallBackfillCompletedAt: now,
        reviewsSyncedAt: now,
        reviewsBackfillCompletedAt: now,
        appStoreRating: "4.8",
      },
    });

    const rows: Rows = { installs: [], lifecycle: [], uninstallDetails: [], events: [], sales: [] };
    simulateApp(demo, app.id, now, rows, shopCounter);

    await inBatches(rows.installs, 1000, (batch) =>
      prisma.appInstall.createMany({ data: batch.map((row) => ({ ...row, relationshipStateSyncedAt: now })) }),
    );
    await inBatches(rows.lifecycle, 1000, (batch) => prisma.accountLifecycleEvent.createMany({ data: batch }));
    await inBatches(rows.uninstallDetails, 1000, (batch) => prisma.uninstallEventDetail.createMany({ data: batch }));
    await inBatches(rows.events, 1000, (batch) => prisma.partnerSubscriptionEvent.createMany({ data: batch as never }));
    await inBatches(rows.sales, 1000, (batch) => prisma.partnerSubscriptionSaleFact.createMany({ data: batch as never }));

    /* App Store reviews */
    const reviewers = rows.installs.filter(() => chance(0.02)).slice(0, 60);
    await prisma.appReview.createMany({
      data: reviewers.map((install, index) => {
        const rating = weighted([[5, 14], [4, 3], [3, 1], [2, 0.4], [1, 0.4]] as const);
        return {
          appId: app.id,
          platformReviewId: `demo-${demo.handle}-${index}`,
          rating,
          body: pick(REVIEW_TEXT),
          reviewerName: install.shopName,
          reviewerCountry: pick(COUNTRIES),
          timeUsingApp: `${Math.ceil(between(1, 11))} months using the app`,
          replyBody: rating <= 3 ? "Thanks for the feedback — we've reached out to help." : null,
          reviewedAt: new Date(install.installedAt.getTime() + between(5, 60) * DAY),
          shopDomain: install.shopDomain,
        };
      }),
    });
    await prisma.app.update({ where: { id: app.id }, data: { appStoreReviewCount: reviewers.length } });

    console.log(
      `${demo.name}: ${rows.installs.length} installs, ${rows.events.length} subscription events, ${rows.sales.length} sales, ${reviewers.length} reviews`,
    );
  }

  /* A few discount codes, shared across the portfolio */
  const apps = await prisma.app.findMany({ where: { handle: { startsWith: HANDLE_PREFIX } }, orderBy: { handle: "asc" } });
  const upsell = apps.find((a) => a.handle === "demo-upsell")!;
  const codes = [
    { code: "WELCOME20", value: "20", durationIntervals: 3, description: "20% off the first three months", endsAt: null },
    { code: "SPRING15", value: "15", durationIntervals: 2, description: "Spring campaign", endsAt: new Date(now.getTime() - 20 * DAY) },
    { code: "PARTNER10", value: "10", durationIntervals: null, description: "Agency partners, forever", endsAt: null },
  ];
  for (const c of codes) {
    const discount = await prisma.discount.create({
      data: {
        appId: upsell.id,
        organizationId: org.id,
        code: c.code,
        normalizedCode: c.code,
        orgCodeKey: c.code,
        type: "PERCENTAGE",
        value: c.value,
        durationIntervals: c.durationIntervals,
        description: c.description,
        endsAt: c.endsAt,
      },
    });
    await prisma.discountApp.createMany({
      data: apps.filter((a) => a.id !== upsell.id).map((a) => ({ discountId: discount.id, appId: a.id })),
    });
  }

  console.log("Demo portfolio ready. Sign in and open the Overview.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
  })
  .finally(() => process.exit(0));
