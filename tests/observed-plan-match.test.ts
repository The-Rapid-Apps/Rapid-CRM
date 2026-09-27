import assert from "node:assert/strict";
import test from "node:test";
import { matchObservedPlans, planNameKey } from "../app/lib/shopify/observed-plan-match";

/* Rapid Bundle's catalogue and the Partner charge groups, as read off
   production on 2026-09-23 (counts illustrative). */
const plan = (id: string, name: string, amount: number, interval: string) => ({
  id, name, amount, interval, currency: "USD",
});
const CATALOGUE = [
  plan("free", "Free", 0, "EVERY_30_DAYS"),
  plan("starter", "Starter", 15, "EVERY_30_DAYS"),
  plan("pro", "Pro", 29, "EVERY_30_DAYS"),
  plan("elite", "Elite", 59, "EVERY_30_DAYS"),
  plan("starterY", "Starter_yearly", 119.88, "ANNUAL"),
  plan("proY", "Pro_yearly", 239.88, "ANNUAL"),
  plan("eliteY", "Elite_yearly", 479.88, "ANNUAL"),
  plan("payM", "PAY MONTHLY", 14.99, "EVERY_30_DAYS"),
  plan("payY", "PAY YEARLY", 119.88, "ANNUAL"),
];
const group = (name: string, amount: number, interval: string, customers: number, trials = 0) => ({
  plan: name, amount, interval, currency: "USD", customers, trials, mrr: 0,
});

test("names match across spellings, cadence carried by interval and price", () => {
  assert.equal(planNameKey("Starter_yearly"), "starter");
  assert.equal(planNameKey("PAY YEARLY"), "pay");
  assert.equal(planNameKey("Monthly"), "monthly", "never stripped to nothing");
});

test("every Rapid Bundle charge group lands on its own plan", () => {
  const { byPlanId, unmatched } = matchObservedPlans(CATALOGUE, [
    group("Starter", 15, "EVERY_30_DAYS", 2310, 40),
    group("Starter", 119.88, "ANNUAL", 34),
    group("Pro", 29, "EVERY_30_DAYS", 908),
    group("Pro", 239.88, "ANNUAL", 22),
    group("Elite", 59, "EVERY_30_DAYS", 372),
    group("Elite", 479.88, "ANNUAL", 50),
    group("PAY MONTHLY", 14.99, "EVERY_30_DAYS", 279),
    group("PAY YEARLY", 119.88, "ANNUAL", 216),
    group("Monthly Plan", 9.99, "EVERY_30_DAYS", 6),
  ]);
  assert.deepEqual(byPlanId.starter, { customers: 2310, trials: 40, mrr: 0 });
  assert.equal(byPlanId.starterY?.customers, 34, "annual Starter is Starter_yearly…");
  assert.equal(byPlanId.payY?.customers, 216, "…and PAY YEARLY keeps its own, same price");
  assert.equal(byPlanId.proY?.customers, 22);
  assert.equal(byPlanId.eliteY?.customers, 50);
  assert.equal(byPlanId.payM?.customers, 279);
  assert.deepEqual(unmatched.map((g) => g.plan), ["Monthly Plan"]);
});

test("a price match alone never assigns merchants", () => {
  const { byPlanId, unmatched } = matchObservedPlans(CATALOGUE, [group("Growth", 29, "EVERY_30_DAYS", 5)]);
  assert.equal(byPlanId.pro, undefined);
  assert.equal(unmatched.length, 1);
});

test("two catalogue plans on one key claim nothing — surfaced instead of guessed", () => {
  const { byPlanId, unmatched } = matchObservedPlans(
    [plan("a", "Pro", 29, "EVERY_30_DAYS"), plan("b", "pro", 29, "EVERY_30_DAYS")],
    [group("Pro", 29, "EVERY_30_DAYS", 3)],
  );
  assert.deepEqual(byPlanId, {});
  assert.equal(unmatched.length, 1);
});
