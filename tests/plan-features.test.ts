import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  featureMap,
  normalizeFeatureKey,
  resolveFeature,
  resolveFeatures,
  UNLIMITED,
  validateFeatureValue,
  type FeatureDefinition,
} from "../app/lib/plans/features";

/**
 * What a plan entitles.
 *
 * The rules worth guarding are the ones that go wrong quietly: an absent
 * entitlement meaning the DEFAULT rather than denial, a trial value applying
 * only inside the trial, and a malformed stored value being reported rather
 * than turned into a number somebody will bill against.
 */

const def = (over: Partial<FeatureDefinition> = {}): FeatureDefinition => ({
  key: "ai_generation",
  name: "AI generation",
  description: null,
  type: "BOOLEAN",
  defaultValue: "false",
  visibleToCustomers: true,
  sortOrder: 0,
  ...over,
});

describe("resolving one feature", () => {
  it("falls back to the feature default when the plan says nothing", () => {
    const resolved = resolveFeature(def({ defaultValue: "true" }), undefined);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.source, "default");
  });

  it("absence is the default, NOT a denial", () => {
    // The bug this prevents: defining a feature would otherwise switch it off
    // for every plan that existed before it.
    assert.equal(resolveFeature(def({ defaultValue: "true" }), undefined).enabled, true);
  });

  it("a plan value overrides the default", () => {
    const resolved = resolveFeature(def(), {
      key: "ai_generation",
      value: "true",
      trialValue: null,
    });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.source, "plan");
  });

  it("a trial value applies only while in trial", () => {
    const entitlement = {
      key: "ai_generation",
      value: "false",
      trialValue: "true",
    };
    assert.equal(resolveFeature(def(), entitlement, { inTrial: true }).enabled, true);
    assert.equal(resolveFeature(def(), entitlement, { inTrial: false }).enabled, false);
    assert.equal(
      resolveFeature(def(), entitlement, { inTrial: true }).source,
      "trial",
    );
  });

  it("a null trial value means the trial gets the plan's own value", () => {
    const resolved = resolveFeature(
      def(),
      { key: "ai_generation", value: "true", trialValue: null },
      { inTrial: true },
    );
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.source, "plan");
  });
});

describe("limits", () => {
  const limit = def({ key: "revenue_cap_limit", type: "LIMIT", defaultValue: "0" });

  it("parses a numeric ceiling", () => {
    const resolved = resolveFeature(limit, {
      key: "revenue_cap_limit",
      value: "10000",
      trialValue: null,
    });
    assert.equal(resolved.limit, 10000);
    assert.equal(resolved.unlimited, false);
    assert.equal(resolved.malformed, false);
  });

  it("treats the unlimited sentinel as no ceiling", () => {
    const resolved = resolveFeature(limit, {
      key: "revenue_cap_limit",
      value: UNLIMITED,
      trialValue: null,
    });
    assert.equal(resolved.unlimited, true);
    assert.equal(resolved.limit, null, "null limit + unlimited is 'no ceiling'");
  });

  it("reports a malformed limit instead of inventing a number", () => {
    // Neither 0 (invents a denial) nor the default (invents an entitlement).
    const resolved = resolveFeature(limit, {
      key: "revenue_cap_limit",
      value: "ten thousand",
      trialValue: null,
    });
    assert.equal(resolved.malformed, true);
    assert.equal(resolved.limit, null);
    assert.equal(resolved.unlimited, false);
  });

  it("never reports enabled for a non-boolean", () => {
    // `enabled === false` must always mean "a boolean that is off".
    const resolved = resolveFeature(limit, undefined);
    assert.equal(resolved.enabled, null);
  });
});

describe("resolving a whole plan", () => {
  const definitions = [
    def({ key: "b", name: "B", sortOrder: 2 }),
    def({ key: "a", name: "A", sortOrder: 1 }),
    def({ key: "gone", name: "Archived", sortOrder: 0 }),
  ].map((d) => ({ ...d, archivedAt: d.key === "gone" ? new Date() : null }));

  it("returns every defined feature in display order, archived excluded", () => {
    const resolved = resolveFeatures(definitions, []);
    assert.deepEqual(
      resolved.map((f) => f.key),
      ["a", "b"],
    );
  });

  it("includes archived features when asked", () => {
    const resolved = resolveFeatures(definitions, [], { includeArchived: true });
    assert.deepEqual(
      resolved.map((f) => f.key),
      ["gone", "a", "b"],
    );
  });

  it("ignores an entitlement whose feature no longer exists", () => {
    // A leftover row must not conjure a definition-less feature, which would
    // have no type and break every keyed reader.
    const resolved = resolveFeatures(definitions, [
      { key: "deleted_feature", value: "true", trialValue: null },
    ]);
    assert.equal(resolved.find((f) => f.key === "deleted_feature"), undefined);
  });

  it("keys the map by feature key for an app gating by key", () => {
    const map = featureMap(resolveFeatures(definitions, []));
    assert.deepEqual(Object.keys(map).sort(), ["a", "b"]);
    assert.equal(map.a?.name, "A");
  });
});

describe("validating a value before it is stored", () => {
  it("accepts booleans in the forms an operator types", () => {
    for (const value of ["true", "FALSE", "1", "0", "yes", "no", "on", "off"]) {
      assert.equal(validateFeatureValue("BOOLEAN", value), null, value);
    }
  });

  it("rejects a boolean that is neither", () => {
    assert.match(String(validateFeatureValue("BOOLEAN", "maybe")), /true or false/);
  });

  it("accepts a number or the unlimited sentinel for a limit", () => {
    assert.equal(validateFeatureValue("LIMIT", "0"), null);
    assert.equal(validateFeatureValue("LIMIT", "10000.50"), null);
    assert.equal(validateFeatureValue("LIMIT_WITH_OVERAGE", UNLIMITED), null);
  });

  it("rejects a negative or non-numeric limit", () => {
    assert.match(String(validateFeatureValue("LIMIT", "-1")), /negative/);
    assert.match(String(validateFeatureValue("LIMIT", "lots")), /number/);
    assert.match(String(validateFeatureValue("LIMIT", "")), /number/);
  });

  it("leaves a string feature's vocabulary to the app, but bounds its length", () => {
    assert.equal(validateFeatureValue("STRING", "anything at all"), null);
    assert.match(
      String(validateFeatureValue("STRING", "x".repeat(192))),
      /191 characters/,
    );
  });
});

describe("feature keys", () => {
  it("normalizes what an operator types into what an app gates on", () => {
    assert.equal(normalizeFeatureKey("Revenue Cap Limit"), "revenue_cap_limit");
    assert.equal(normalizeFeatureKey("  AI-Generation  "), "ai_generation");
    assert.equal(normalizeFeatureKey("Mix & Match products"), "mix__match_products");
  });
});
