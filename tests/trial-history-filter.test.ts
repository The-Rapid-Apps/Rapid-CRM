import assert from "node:assert/strict";
import test from "node:test";
import { filterTrialHistory } from "../app/lib/reports/trial-history-filter";

/**
 * The bug this covers, reported 2026-09-22: searching the trial history for
 * "free" returned nothing, although free plans ("Free", "For Free",
 * "Gratuit") are real and all carry a 30-day trial. The filter ran in the
 * browser over the newest 200 rows of 1,773, and every free trial in the
 * period sat outside that slice — the nearest had 350 trials newer than it.
 */

const FACTS = [
  { shopDomain: "alpha.myshopify.com", planName: "Pro", monthlyAmount: 29, status: "paying" },
  { shopDomain: "beta.myshopify.com", planName: "Free", monthlyAmount: 0, status: "on_trial" },
  { shopDomain: "gamma.myshopify.com", planName: "Gratuit", monthlyAmount: 0, status: "churned_during_trial" },
  { shopDomain: "delta.myshopify.com", planName: "Starter", monthlyAmount: 9, status: "on_trial" },
];

const NONE = { query: "", status: "all", paidOnly: false, matchingDomains: null };

test("a plan-name search finds free plans anywhere in the period", () => {
  const found = filterTrialHistory(FACTS, { ...NONE, query: "free" });
  assert.deepEqual(
    found.map((row) => row.planName),
    ["Free"],
    "matches the plan name regardless of where the row sorts",
  );
});

test("a search matches the shop domain too", () => {
  const found = filterTrialHistory(FACTS, { ...NONE, query: "gamma" });
  assert.equal(found.length, 1);
  assert.equal(found[0].planName, "Gratuit");
});

test("customer-name matches arrive as domains, since the name is not on the row", () => {
  const found = filterTrialHistory(FACTS, {
    ...NONE,
    query: "acme",
    matchingDomains: new Set(["delta.myshopify.com"]),
  });
  assert.deepEqual(found.map((row) => row.shopDomain), ["delta.myshopify.com"]);
});

test("a query that matches no name and no row returns nothing, not everything", () => {
  const found = filterTrialHistory(FACTS, {
    ...NONE,
    query: "nosuchthing",
    matchingDomains: new Set(),
  });
  assert.deepEqual(found, [], "an empty domain set must not read as 'no filter'");
});

test("paid-only drops $0 plans, matching the charts' fold", () => {
  const found = filterTrialHistory(FACTS, { ...NONE, paidOnly: true });
  assert.deepEqual(found.map((row) => row.planName), ["Pro", "Starter"]);
});

test("status and query compose rather than override each other", () => {
  const found = filterTrialHistory(FACTS, { ...NONE, query: "a", status: "on_trial" });
  assert.deepEqual(
    found.map((row) => row.shopDomain),
    ["beta.myshopify.com", "delta.myshopify.com"],
    "both predicates apply",
  );
});
