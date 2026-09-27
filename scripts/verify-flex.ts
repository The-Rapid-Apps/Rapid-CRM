/**
 * Verification harness for the PURE flex billing logic — the parts of the
 * spec §9 acceptance scenarios that don't need a live Postgres: proration math,
 * discount application, and the billing date arithmetic.
 *
 * Run: npx tsx scripts/verify-flex.ts
 */
import assert from "node:assert";
import { computeProration } from "../app/lib/flex/proration";
import {
  priceAfterDiscount,
  resolveChargeAmount,
} from "../app/lib/flex/discounts.server";
import {
  addInterval,
  startOfDay,
  wholeDaysBetween,
  startOfMonth,
} from "../app/lib/flex/dates";
import { Prisma, type Discount } from "../generated/prisma/client";

const D = (v: number | string) => new Prisma.Decimal(v);

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

function discount(partial: Partial<Discount>): Discount {
  return {
    id: "d",
    appId: "a",
    planId: null,
    code: null,
    type: "PERCENTAGE",
    value: D(0),
    discountMethod: "PRICE_REDUCTION",
    durationIntervals: null,
    description: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as Discount;
}

console.log("\nProration (spec §5 / §9):");

check("mid-cycle upgrade pro-rates by remaining days (§9.4)", () => {
  // 30-day cycle, 15 days remaining, $10 → $30. Expect +$10 net.
  const start = new Date(Date.UTC(2026, 0, 1));
  const end = new Date(Date.UTC(2026, 0, 31)); // 30 days
  const today = new Date(Date.UTC(2026, 0, 16)); // 15 days remaining
  const { netProRated, daysInCycle, daysRemaining } = computeProration({
    periodStart: start,
    periodEnd: end,
    today,
    prevAmount: 10,
    newAmount: 30,
  });
  assert.equal(daysInCycle, 30);
  assert.equal(daysRemaining, 15);
  assert.equal(netProRated.toFixed(2), "10.00"); // (30-10)/30 * 15
});

check("mid-cycle downgrade is negative (§9.6)", () => {
  const start = new Date(Date.UTC(2026, 0, 1));
  const end = new Date(Date.UTC(2026, 0, 31));
  const today = new Date(Date.UTC(2026, 0, 16));
  const { netProRated } = computeProration({
    periodStart: start,
    periodEnd: end,
    today,
    prevAmount: 30,
    newAmount: 10,
  });
  assert.equal(netProRated.toFixed(2), "-10.00");
});

check("equal-priced swap = 0 proration (§7)", () => {
  const start = new Date(Date.UTC(2026, 0, 1));
  const end = new Date(Date.UTC(2026, 0, 31));
  const today = new Date(Date.UTC(2026, 0, 16));
  const { netProRated } = computeProration({
    periodStart: start,
    periodEnd: end,
    today,
    prevAmount: 20,
    newAmount: 20,
  });
  assert.ok(netProRated.isZero());
});

check("degenerate same-day cycle prorates to 0, no divide-by-zero (§5)", () => {
  const day = new Date(Date.UTC(2026, 0, 1));
  const { netProRated, daysInCycle } = computeProration({
    periodStart: day,
    periodEnd: day,
    today: day,
    prevAmount: 10,
    newAmount: 50,
  });
  assert.equal(daysInCycle, 0);
  assert.ok(netProRated.isZero());
});

console.log("\nDiscounts (spec §4.2 / §9):");

check("percentage discount reduces price", () => {
  const d = discount({ type: "PERCENTAGE", value: D(20) });
  assert.equal(priceAfterDiscount(50, d).toFixed(2), "40.00");
});

check("100%-off discount yields $0 (§9.3)", () => {
  const d = discount({ type: "PERCENTAGE", value: D(100) });
  const priced = priceAfterDiscount(50, d);
  assert.equal(priced.toFixed(2), "0.00");
  assert.ok(priced.isZero()); // → charge path skips Shopify, advances period
});

check("amount-off clamps at zero", () => {
  const d = discount({ type: "AMOUNT", value: D(999) });
  assert.equal(priceAfterDiscount(50, d).toFixed(2), "0.00");
});

check("flat-price discount sets absolute price", () => {
  const d = discount({ type: "FLAT_PRICE", value: D(12.5) });
  assert.equal(priceAfterDiscount(50, d).toFixed(2), "12.50");
});

check("flat-price discount never increases a cheaper plan", () => {
  const d = discount({ type: "FLAT_PRICE", value: D(75) });
  assert.equal(priceAfterDiscount(50, d).toFixed(2), "50.00");
});

check("APP_CREDITS discount does NOT reduce the charge (§4.2)", () => {
  const d = discount({
    type: "PERCENTAGE",
    value: D(20),
    discountMethod: "APP_CREDITS",
  });
  const r = resolveChargeAmount(50, d);
  assert.equal(r.amount.toFixed(2), "50.00");
  assert.equal(r.reducedCharge, false);
});

check("PRICE_REDUCTION discount reduces the charge (§4.2)", () => {
  const d = discount({
    type: "PERCENTAGE",
    value: D(20),
    discountMethod: "PRICE_REDUCTION",
  });
  const r = resolveChargeAmount(50, d);
  assert.equal(r.amount.toFixed(2), "40.00");
  assert.equal(r.reducedCharge, true);
});

console.log("\nBilling clock (dates):");

check("addInterval MONTH clamps Jan 31 → Feb 28 (2026)", () => {
  const jan31 = new Date(Date.UTC(2026, 0, 31));
  const next = addInterval(jan31, "MONTH", 1);
  assert.equal(next.toISOString().slice(0, 10), "2026-02-28");
});

check("addInterval MONTH x1 normal", () => {
  const d = new Date(Date.UTC(2026, 5, 15));
  assert.equal(
    addInterval(d, "MONTH", 1).toISOString().slice(0, 10),
    "2026-07-15",
  );
});

check("wholeDaysBetween is day-level", () => {
  const a = new Date(Date.UTC(2026, 0, 1, 23, 0));
  const b = new Date(Date.UTC(2026, 0, 4, 1, 0));
  assert.equal(wholeDaysBetween(a, b), 3);
});

check("startOfDay / startOfMonth are UTC midnight", () => {
  const d = new Date(Date.UTC(2026, 6, 19, 13, 30));
  assert.equal(startOfDay(d).toISOString(), "2026-07-19T00:00:00.000Z");
  assert.equal(startOfMonth(d).toISOString(), "2026-07-01T00:00:00.000Z");
});

console.log(
  `\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}.\n`,
);
