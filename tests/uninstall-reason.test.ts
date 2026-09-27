import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeUninstallReason,
  STORE_CLOSURE_CODES,
} from "../app/lib/customer-events/uninstall-reason";

/* Every string here was taken from the real feed, with its observed volume, so
   a regression in this file is a regression against production data rather
   than against an invented example. */

test("machine tokens classify, not just prose", () => {
  // 5,351 rows — the single most common value in the entire feed, and the one
  // the previous keyword-only matcher dropped into unknown_other.
  const scheduled = normalizeUninstallReason("scheduled_cancellation", null);
  assert.equal(scheduled.reasonCode, "scheduled_cancellation");
  assert.equal(scheduled.isStoreClosure, true);

  const deactivated = normalizeUninstallReason("deactivated", null);
  assert.equal(deactivated.reasonCode, "deactivated");
  assert.equal(deactivated.isStoreClosure, true);
});

test("Shopify's English survey options", () => {
  const cases: Array<[string, string]> = [
    ["Not using app now", "not_using"],
    ["Testing multiple apps", "testing_multiple_apps"],
    ["Limited or missing features", "limited_features"],
    ["Expensive or unexpected cost", "high_cost"],
    ["Not working or compatible with store", "not_compatible_or_not_working"],
    ["Hard to set up or use", "hard_to_setup"],
    ["Store is closing or pausing", "store_closing_or_pausing"],
    ["Does not meet my needs", "does_not_meet_needs"],
    ["Not satisfied with support", "poor_support"],
    ["App is not performing well", "app_performance_issues"],
    ["Other (please specify)", "unknown_other"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeUninstallReason(input, null).reasonCode, expected, input);
  }
});

test("the survey is localized, and every locale counts", () => {
  const cases: Array<[string, string]> = [
    ["Ya no uso la app", "not_using"],
    ["Probando varias apps", "testing_multiple_apps"],
    ["La tienda cerrará o se pausará", "store_closing_or_pausing"],
    ["Test de plusieurs applis", "testing_multiple_apps"],
    ["Fermeture ou mise en pause de la boutique", "store_closing_or_pausing"],
    ["Coût élevé ou imprévu", "high_cost"],
    ["App wird derzeit nicht genutzt", "not_using"],
    ["Shop wird geschlossen oder pausiert", "store_closing_or_pausing"],
    ["Não estou usando o app agora", "not_using"],
    ["Non sto usando l'app al momento", "not_using"],
    ["Ik gebruik de app momenteel niet", "not_using"],
    ["Använder inte appen just nu", "not_using"],
    ["Uygulamayı şu anda kullanmıyorum", "not_using"],
    ["现在不使用应用", "not_using"],
    ["商店正在关闭或暂停", "store_closing_or_pausing"],
    ["其他（请说明）", "unknown_other"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeUninstallReason(input, null).reasonCode, expected, input);
  }
});

test("curly and straight apostrophes are the same answer", () => {
  // Both spellings appear in the feed: 445 rows one way, 56 the other.
  assert.equal(
    normalizeUninstallReason("N'utilise plus l'application", null).reasonCode,
    normalizeUninstallReason("N’utilise plus l’application", null).reasonCode,
  );
});

test("a trailing period does not create a second answer", () => {
  // "No uso la aplicación actualmente." (55) and without the period (28).
  assert.equal(
    normalizeUninstallReason("No uso la aplicación actualmente.", null).reasonCode,
    "not_using",
  );
});

test("multi-select keeps every answer, in the order given", () => {
  const result = normalizeUninstallReason(
    "Not working or compatible with store, Limited or missing features",
    null,
  );
  assert.equal(result.reasonCode, "not_compatible_or_not_working");
  assert.deepEqual(result.reasonCodes, [
    "not_compatible_or_not_working",
    "limited_features",
  ]);
});

test("a store closure anywhere in a multi-select still counts as one", () => {
  const result = normalizeUninstallReason(
    "Store is closing or pausing, Testing multiple apps",
    null,
  );
  assert.equal(result.isStoreClosure, true);
  assert.ok(result.reasonCodes.includes("testing_multiple_apps"));
});

test("free text still falls back to keywords", () => {
  assert.equal(
    normalizeUninstallReason("Other (please specify)", "way too expensive for us").reasonCode,
    "unknown_other",
    "an explicit Other answer is an answer, not a parse failure",
  );
  assert.equal(
    normalizeUninstallReason("it kept crashing on every page", null).reasonCode,
    "app_performance_issues",
  );
});

test("nothing at all stays unknown", () => {
  const result = normalizeUninstallReason(null, null);
  assert.equal(result.reasonCode, "unknown_other");
  assert.equal(result.isStoreClosure, false);
});

test("store-closure codes are the ones churn reporting excludes", () => {
  assert.deepEqual(
    [...STORE_CLOSURE_CODES].sort(),
    ["deactivated", "scheduled_cancellation", "store_closing_or_pausing"],
  );
});
