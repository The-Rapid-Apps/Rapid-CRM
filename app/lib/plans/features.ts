/**
 * Resolving what a plan entitles.
 *
 * Shopify prices a subscription; it has no idea what the subscription grants. So
 * the catalogue lives here, the app reads it over the API, and the app enforces
 * it. Three consequences shape this file:
 *
 *   - **Absence means the default, never denial.** An entitlement row exists only
 *     where a plan differs from the feature's default, so adding a feature does
 *     not have to fan out across every plan. A reader that treated "no row" as
 *     "denied" would silently switch off a feature for every existing plan the
 *     moment somebody defined it.
 *   - **One text column, parsed by type.** Four nullable typed columns can hold
 *     contradictory values at once and nothing in the schema could say which one
 *     the type meant. The cost is that parsing lives in code, which is what the
 *     bottom half of this file is.
 *   - **A malformed value is never guessed at.** See `resolveFeature`.
 *
 * Pure — no database, no Prisma types — so the rules are testable directly and
 * the same resolution runs on a plan the caller assembled by hand.
 */

export type PlanFeatureType =
  | "BOOLEAN"
  | "LIMIT"
  | "LIMIT_WITH_OVERAGE"
  | "STRING";

/** The sentinel a LIMIT-typed value uses to mean "no ceiling". */
export const UNLIMITED = "unlimited";

const TRUTHY = new Set(["true", "1", "yes", "on", "enabled"]);
const FALSY = new Set(["false", "0", "no", "off", "disabled", ""]);

export interface FeatureDefinition {
  key: string;
  name: string;
  description: string | null;
  type: PlanFeatureType;
  defaultValue: string;
  visibleToCustomers: boolean;
  sortOrder: number;
}

/** One plan's override for one feature, keyed by the feature's `key`. */
export interface FeatureEntitlement {
  key: string;
  value: string;
  /** Applies only while the subscription is in trial. Null ⇒ use `value`. */
  trialValue: string | null;
}

export interface ResolvedFeature {
  key: string;
  name: string;
  description: string | null;
  type: PlanFeatureType;
  /** The raw text, so a client that knows the type can parse it itself. */
  value: string;
  /**
   * BOOLEAN only: whether it is on. Null for every other type — deliberately
   * NOT `false`, so `enabled === false` always means "a boolean that is off"
   * and never "not a boolean".
   */
  enabled: boolean | null;
  /**
   * LIMIT / LIMIT_WITH_OVERAGE only: the ceiling. Null when unlimited, when the
   * feature is not a limit, or when the stored value is MALFORMED — check
   * `unlimited` and `malformed` to tell those apart.
   */
  limit: number | null;
  /** True only for a LIMIT type explicitly set to `unlimited`. */
  unlimited: boolean;
  /**
   * The stored value could not be parsed as its type.
   *
   * Reported rather than repaired: turning a typo into `0` invents a denial and
   * turning it into the default invents an entitlement, and both are silent. A
   * consumer MUST fail closed on this — and it should not happen, because
   * `validateFeatureValue` rejects it at the point of writing.
   */
  malformed: boolean;
  visibleToCustomers: boolean;
  /** Where the value came from, for an admin explaining a resolved entitlement. */
  source: "plan" | "trial" | "default";
}

export interface ResolveOptions {
  /**
   * Whether the subscription is inside its trial window right now.
   *
   * Only affects features whose entitlement carries a `trialValue`. A trial that
   * grants everything converts worse than one showing the tier being bought, and
   * one that grants nothing converts worse still, so the two are separable.
   */
  inTrial?: boolean;
  /** Include features an operator has archived. Defaults to false. */
  includeArchived?: boolean;
}

/**
 * Resolve one feature against one plan's entitlements.
 *
 * Precedence: the trial value (only while in trial, only when set) → the plan's
 * value → the feature's default.
 */
export function resolveFeature(
  definition: FeatureDefinition,
  entitlement: FeatureEntitlement | undefined,
  options: ResolveOptions = {},
): ResolvedFeature {
  let value = definition.defaultValue;
  let source: ResolvedFeature["source"] = "default";
  if (entitlement) {
    if (options.inTrial && entitlement.trialValue !== null) {
      value = entitlement.trialValue;
      source = "trial";
    } else {
      value = entitlement.value;
      source = "plan";
    }
  }

  const base = {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    type: definition.type,
    value,
    visibleToCustomers: definition.visibleToCustomers,
    source,
  };

  const normalized = value.trim().toLowerCase();

  if (definition.type === "BOOLEAN") {
    const known = TRUTHY.has(normalized) || FALSY.has(normalized);
    return {
      ...base,
      enabled: TRUTHY.has(normalized),
      limit: null,
      unlimited: false,
      malformed: !known,
    };
  }

  if (definition.type === "LIMIT" || definition.type === "LIMIT_WITH_OVERAGE") {
    if (normalized === UNLIMITED) {
      return { ...base, enabled: null, limit: null, unlimited: true, malformed: false };
    }
    const parsed = Number(normalized);
    const usable = normalized !== "" && Number.isFinite(parsed) && parsed >= 0;
    return {
      ...base,
      enabled: null,
      limit: usable ? parsed : null,
      unlimited: false,
      malformed: !usable,
    };
  }

  // STRING is whatever it says. Empty is a real answer ("no variant selected"),
  // not a malformation, because nothing here knows the variant vocabulary.
  return { ...base, enabled: null, limit: null, unlimited: false, malformed: false };
}

/**
 * Every feature the app defines, resolved for one plan, in display order.
 *
 * Driven by the DEFINITIONS, not by the entitlement rows: a plan that overrides
 * nothing still gets the full set at their defaults, which is the whole reason
 * absence can mean "default". An entitlement whose feature no longer exists is
 * ignored rather than surfaced — it is a leftover, and inventing a
 * definition-less feature for it would break every keyed reader.
 */
export function resolveFeatures(
  definitions: Array<FeatureDefinition & { archivedAt?: Date | null }>,
  entitlements: FeatureEntitlement[],
  options: ResolveOptions = {},
): ResolvedFeature[] {
  const byKey = new Map(entitlements.map((row) => [row.key, row]));
  return definitions
    .filter((d) => options.includeArchived || !d.archivedAt)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map((definition) => resolveFeature(definition, byKey.get(definition.key), options));
}

/** The API/JSON shape: `{ [key]: resolved }`, for an app that gates by key. */
export function featureMap(
  resolved: ResolvedFeature[],
): Record<string, ResolvedFeature> {
  return Object.fromEntries(resolved.map((feature) => [feature.key, feature]));
}

/**
 * Whether a value is storable for a type — the guard that keeps `malformed`
 * theoretical. Returns an operator-readable reason, or null when it is fine.
 */
export function validateFeatureValue(
  type: PlanFeatureType,
  value: string,
): string | null {
  const normalized = value.trim().toLowerCase();
  if (type === "BOOLEAN") {
    return TRUTHY.has(normalized) || FALSY.has(normalized)
      ? null
      : `A boolean feature needs true or false, not "${value}".`;
  }
  if (type === "LIMIT" || type === "LIMIT_WITH_OVERAGE") {
    if (normalized === UNLIMITED) return null;
    const parsed = Number(normalized);
    if (normalized === "" || !Number.isFinite(parsed)) {
      return `A limit needs a number or "${UNLIMITED}", not "${value}".`;
    }
    return parsed < 0 ? "A limit cannot be negative." : null;
  }
  // A STRING feature's vocabulary is the app's business, so only length is ours.
  return value.length > 191
    ? "A feature value cannot exceed 191 characters."
    : null;
}

/**
 * The key an app gates on, normalized the one way the whole system agrees on.
 *
 * `revenue_cap_limit`, not `Revenue Cap Limit` — a key travels through JSON,
 * env-style config and app source, so it is lowercase snake with no spaces.
 * Rejects rather than mangles anything that cannot be normalized safely, since
 * a silently-changed key resolves to nothing at the reader.
 */
export function normalizeFeatureKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}
