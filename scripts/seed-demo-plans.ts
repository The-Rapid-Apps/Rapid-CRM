/**
 * Creates a small, identical plan catalogue for each app, so per-app filtering
 * can be seen working in the UI.
 *
 * `npm run seed:demo-plans`            — create
 * `REMOVE=1 npm run seed:demo-plans`   — delete them again
 * `APP="Rapi Cart" npm run seed:demo-plans` — just that app
 *
 * DEVELOPMENT DATA. Every row it writes is named with the marker below, and
 * removal matches on exactly that, so it can only ever delete plans it created.
 * It still writes real rows to whatever database `DATABASE_URL` points at —
 * check that before running.
 *
 * The three tiers are deliberately IDENTICAL across apps. Distinct names per
 * app would let a filtered page look right while actually being wrong (you
 * would be reading the names, not testing the filter); with the same three
 * everywhere, "Rapi Cart > Plans" is correct only if it shows exactly three.
 *
 * Removal refuses any plan a subscription points at. Nothing here should ever
 * acquire one, but a plan with customers on it is not demo data any more, and
 * `Subscription.planId` would block the delete at the database anyway — better
 * to say why than to surface a foreign-key error.
 */
import { prisma } from "../app/lib/db.server";

/** Carried in the plan name because `Plan` has no metadata column, and the
 * name is what an operator sees in the list — so demo rows are obvious there
 * rather than only in the database. */
const MARKER = "[demo]";

const TIERS = [
  {
    name: "Starter",
    description: "Entry tier for small stores.",
    amount: 15,
    trialDays: 7,
    sortOrder: 1,
  },
  {
    name: "Pro",
    description: "For growing stores that need more headroom.",
    amount: 29,
    trialDays: 14,
    sortOrder: 2,
  },
  {
    name: "Elite",
    description: "High-volume stores and agencies.",
    amount: 59,
    trialDays: 0,
    sortOrder: 3,
  },
] as const;

const REMOVE = process.env.REMOVE === "1";
const ONLY_APP = process.env.APP?.trim();

const apps = await prisma.app.findMany({
  where: {
    removed: false,
    ...(ONLY_APP
      ? { name: ONLY_APP }
      : // The email-campaign tests leave behind app rows named "Email Test
        // App" that never get cleaned up. Seeding those would bury the real
        // apps in a switcher that already lists ten of them.
        { name: { not: "Email Test App" } }),
  },
  orderBy: { name: "asc" },
  select: { id: true, name: true },
});

if (apps.length === 0) {
  console.log(
    ONLY_APP ? `No app named "${ONLY_APP}".` : "No apps to seed.",
  );
  await prisma.$disconnect();
  process.exit(0);
}

if (REMOVE) {
  const doomed = await prisma.plan.findMany({
    where: { appId: { in: apps.map((a) => a.id) }, name: { startsWith: MARKER } },
    select: { id: true, name: true, app: { select: { name: true } }, _count: { select: { subscriptions: true } } },
  });
  const inUse = doomed.filter((p) => p._count.subscriptions > 0);
  for (const p of inUse) {
    console.log(`  keep   ${p.app.name} / ${p.name} — ${p._count.subscriptions} subscription(s) reference it`);
  }
  const removable = doomed.filter((p) => p._count.subscriptions === 0);
  const result = await prisma.plan.deleteMany({
    where: { id: { in: removable.map((p) => p.id) } },
  });
  console.log(`\nremoved ${result.count} demo plan(s) across ${apps.length} app(s)`);
  await prisma.$disconnect();
  process.exit(0);
}

let created = 0;
let existing = 0;

for (const app of apps) {
  for (const tier of TIERS) {
    const name = `${MARKER} ${tier.name}`;
    // No unique constraint on (appId, name), so this checks rather than
    // upserts — re-running must not add a second copy of each tier.
    const already = await prisma.plan.findFirst({
      where: { appId: app.id, name },
      select: { id: true },
    });
    if (already) {
      existing += 1;
      continue;
    }
    await prisma.plan.create({
      data: {
        appId: app.id,
        name,
        description: tier.description,
        amount: tier.amount,
        currencyCode: "USD",
        interval: "EVERY_30_DAYS",
        trialDays: tier.trialDays,
        sortOrder: tier.sortOrder,
        // Required, no schema default. Zero = no usage billing on these.
        usageChargeCappedAmount: 0,
        usageBilling: false,
        active: true,
        isPublic: true,
      },
    });
    created += 1;
  }
  console.log(`  ${app.name}`);
}

console.log(
  `\n${created} plan(s) created, ${existing} already present, across ${apps.length} app(s).` +
    `\nRemove them with: REMOVE=1 npm run seed:demo-plans`,
);
await prisma.$disconnect();
process.exit(0);
