import assert from "node:assert/strict";
import test from "node:test";
import {
  discountCoversApp,
  validateDiscountEligibility,
  type DiscountWithApps,
} from "../app/lib/flex/discounts.server";
import { flexDiscountState, nativeRedemptionState } from "../app/lib/flex/discount-merchants";

const discount = (over: Partial<DiscountWithApps> = {}): DiscountWithApps =>
  ({ id: "d1", appId: "bundle", active: true, planId: null, ...over }) as DiscountWithApps;

test("a discount is valid in its primary app and every listed app", () => {
  const shared = discount({ apps: [{ appId: "bundle" }, { appId: "tracking" }] });
  assert.equal(discountCoversApp(shared, "bundle"), true);
  assert.equal(discountCoversApp(shared, "tracking"), true);
  assert.equal(discountCoversApp(shared, "cart"), false);
  assert.deepEqual(validateDiscountEligibility(shared, { appId: "tracking" }), { eligible: true });
  assert.deepEqual(validateDiscountEligibility(shared, { appId: "cart" }), {
    eligible: false,
    reason: "WRONG_APP",
  });
});

test("without its app list loaded, a discount fails CLOSED outside its primary app", () => {
  const bare = discount(); // apps not loaded
  assert.equal(discountCoversApp(bare, "bundle"), true);
  assert.equal(discountCoversApp(bare, "tracking"), false);
});

test("inactive and plan rules still apply to shared discounts", () => {
  const shared = discount({ apps: [{ appId: "tracking" }] });
  assert.equal(validateDiscountEligibility({ ...shared, active: false }, { appId: "tracking" }).eligible, false);
  assert.deepEqual(validateDiscountEligibility({ ...shared, planId: "p1" }, { appId: "bundle" }), {
    eligible: false,
    reason: "PLAN_REQUIRED",
  });
});

const now = new Date("2026-09-23T12:00:00Z");

test("native merchants: canceled subscription is expired, unsynced is active but flagged", () => {
  const base = { appliedAt: new Date("2026-06-01"), durationIntervals: null, externalPlanKey: "elite-yearly", now };
  assert.deepEqual(nativeRedemptionState({ ...base, subscriptionStatus: "CANCELLED" }), { active: false, reason: "Canceled" });
  assert.deepEqual(nativeRedemptionState({ ...base, subscriptionStatus: "ACTIVE" }), { active: true, note: null });
  assert.deepEqual(nativeRedemptionState({ ...base, subscriptionStatus: null }), {
    active: true,
    note: "Subscription status not synced yet",
  });
});

test("native merchants: a limited discount ends after its periods (yearly plans count years)", () => {
  const monthly = { appliedAt: new Date("2026-06-01"), durationIntervals: 3, externalPlanKey: "pro-monthly", subscriptionStatus: "ACTIVE", now };
  assert.deepEqual(nativeRedemptionState(monthly), { active: false, reason: "Discount period over" });
  assert.equal(nativeRedemptionState({ ...monthly, externalPlanKey: "pro-yearly" }).active, true);
});

test("flex merchants: window end, cancellation and pending approval", () => {
  assert.deepEqual(flexDiscountState({ endsAt: null, subscriptionStatus: "ACTIVE", canceledAt: null, now }), { active: true, note: null });
  assert.deepEqual(flexDiscountState({ endsAt: new Date("2026-09-01"), subscriptionStatus: "ACTIVE", canceledAt: null, now }), {
    active: false,
    reason: "Discount period over",
  });
  assert.equal(flexDiscountState({ endsAt: null, subscriptionStatus: "ACTIVE", canceledAt: new Date("2026-09-10"), now }).active, false);
  assert.deepEqual(flexDiscountState({ endsAt: null, subscriptionStatus: "PENDING", canceledAt: null, now }), {
    active: true,
    note: "Awaiting merchant approval",
  });
});
