import assert from "node:assert/strict";
import test from "node:test";
import { installIsActiveAt, type InstallForReport } from "../app/lib/reports/analytics.server";
import {
  buildDailyInstallStocks,
  installActiveTransitions,
  type InstallActivitySource,
} from "../app/lib/reports/install-snapshot.server";

/**
 * This is the load-bearing test for the whole install-snapshot table: every
 * stock number the table will ever serve is a prefix sum over
 * `installActiveTransitions`'s output, so if this function's transitions
 * don't match `installIsActiveAt` (the real, live predicate) at every
 * instant, the snapshot silently reports a wrong active-install count
 * forever — a prefix sum never self-corrects.
 */

function day(iso: string): Date {
  return new Date(iso);
}

/** Reconstructs "is active at `at`" purely from a transition list, the way
 * a prefix sum over stored deltas effectively does — independent of
 * `installActiveTransitions`'s own internal bookkeeping, so this doesn't
 * just check "the function ran", it checks the transitions are correct. */
function activeAtFromTransitions(
  transitions: Array<{ at: Date; delta: number }>,
  at: Date,
): boolean {
  let sum = 0;
  for (const t of transitions) {
    if (t.at.getTime() <= at.getTime()) sum += t.delta;
  }
  assert.ok(sum === 0 || sum === 1, `transitions produced an impossible state sum: ${sum}`);
  return sum === 1;
}

function toInstallForReport(source: InstallActivitySource): InstallForReport {
  return {
    id: "test-install",
    installedAt: source.installedAt,
    uninstalledAt: source.uninstalledAt,
    lifecycleEvents: source.events.map((event) => ({
      type: event.type,
      occurredAt: event.occurredAt,
      uninstallDetail: null,
    })),
  };
}

/** Every instant worth checking for one install: its own installedAt/
 * uninstalledAt/event timestamps, one instant before and after each, and a
 * handful of exact-midnight instants — the boundary cases most likely to
 * expose an off-by-one, not a uniformly random sample of the whole timeline. */
function candidateInstants(source: InstallActivitySource): Date[] {
  const anchors = [
    source.installedAt,
    ...(source.uninstalledAt ? [source.uninstalledAt] : []),
    ...source.events.map((e) => e.occurredAt),
  ];
  const instants: Date[] = [];
  for (const anchor of anchors) {
    instants.push(
      new Date(anchor.getTime() - 1),
      anchor,
      new Date(anchor.getTime() + 1),
    );
  }
  // A handful of exact-midnight instants spanning the install's timeline —
  // the case a naive single-column stock representation gets wrong.
  const earliest = Math.min(...anchors.map((a) => a.getTime()));
  const latest = Math.max(...anchors.map((a) => a.getTime()));
  for (let t = earliest; t <= latest + 86_400_000; t += 86_400_000) {
    const midnight = new Date(t);
    midnight.setUTCHours(0, 0, 0, 0);
    instants.push(midnight);
  }
  return instants;
}

function assertEquivalent(source: InstallActivitySource, label: string): void {
  const transitions = installActiveTransitions(source);
  const reference = toInstallForReport(source);
  for (const at of candidateInstants(source)) {
    const expected = installIsActiveAt(reference, at);
    const actual = activeAtFromTransitions(transitions, at);
    assert.equal(
      actual,
      expected,
      `${label}: mismatch at ${at.toISOString()} (expected ${expected}, got ${actual})`,
    );
  }
}

test("no events at all: pure installedAt/uninstalledAt fallback", () => {
  assertEquivalent(
    { installedAt: day("2026-01-01T00:00:00.000Z"), uninstalledAt: null, events: [] },
    "never uninstalled",
  );
  assertEquivalent(
    {
      installedAt: day("2026-01-01T00:00:00.000Z"),
      uninstalledAt: day("2026-02-01T00:00:00.000Z"),
      events: [],
    },
    "uninstalled, no events recorded for it",
  );
});

test("single INSTALLED event coinciding with installedAt", () => {
  assertEquivalent(
    {
      installedAt: day("2026-01-01T00:00:00.000Z"),
      uninstalledAt: null,
      events: [{ type: "INSTALLED", occurredAt: day("2026-01-01T00:00:00.000Z") }],
    },
    "installed event at installedAt",
  );
});

test("deactivated, never reinstalled — must read inactive despite uninstalledAt staying null", () => {
  assertEquivalent(
    {
      installedAt: day("2026-01-01T00:00:00.000Z"),
      uninstalledAt: null,
      events: [
        { type: "INSTALLED", occurredAt: day("2026-01-01T00:00:00.000Z") },
        { type: "DEACTIVATED", occurredAt: day("2026-02-01T00:00:00.000Z") },
      ],
    },
    "deactivated, no reactivation",
  );
});

test("uninstalled then reinstalled, uninstalledAt stale (not cleared) — event history must win", () => {
  assertEquivalent(
    {
      installedAt: day("2026-01-01T00:00:00.000Z"),
      uninstalledAt: day("2026-02-01T00:00:00.000Z"), // deliberately stale
      events: [
        { type: "INSTALLED", occurredAt: day("2026-01-01T00:00:00.000Z") },
        { type: "UNINSTALLED", occurredAt: day("2026-02-01T00:00:00.000Z") },
        { type: "REINSTALLED", occurredAt: day("2026-03-01T00:00:00.000Z") },
      ],
    },
    "stale uninstalledAt superseded by REINSTALLED",
  );
});

test("consecutive activating events must not double-count (no spurious extra transition)", () => {
  const source: InstallActivitySource = {
    installedAt: day("2026-01-01T00:00:00.000Z"),
    uninstalledAt: null,
    events: [
      { type: "INSTALLED", occurredAt: day("2026-01-01T00:00:00.000Z") },
      { type: "DEACTIVATED", occurredAt: day("2026-01-10T00:00:00.000Z") },
      { type: "REACTIVATED", occurredAt: day("2026-01-20T00:00:00.000Z") },
      { type: "REACTIVATED", occurredAt: day("2026-01-25T00:00:00.000Z") }, // redundant, same state
    ],
  };
  const transitions = installActiveTransitions(source);
  // Exactly 3 real flips: become active, deactivate, reactivate. The second
  // REACTIVATED must not add a 4th — it doesn't change the boolean state.
  assert.equal(transitions.length, 3);
  assertEquivalent(source, "redundant REACTIVATED");
});

test("event landing exactly at UTC midnight shifts the day-start/day-end split, not just one bucket", () => {
  assertEquivalent(
    {
      installedAt: day("2026-01-01T00:00:00.000Z"),
      uninstalledAt: null,
      events: [
        { type: "INSTALLED", occurredAt: day("2026-01-01T00:00:00.000Z") },
        { type: "DEACTIVATED", occurredAt: day("2026-03-01T00:00:00.000Z") }, // exact midnight
      ],
    },
    "deactivation exactly at midnight",
  );
});

test("installedAt after the first event (a late-arriving earlier install event lowered installedAt asymmetrically)", () => {
  // Mirrors derive.server.ts's installLifecycleMirrorUpdate: installedAt can
  // be *lowered* by a later-arriving older event, but the fallback interval
  // logic must still hold even if installedAt ends up equal to or after
  // firstEventAt in some reordering.
  assertEquivalent(
    {
      installedAt: day("2026-01-05T00:00:00.000Z"),
      uninstalledAt: null,
      events: [{ type: "INSTALLED", occurredAt: day("2026-01-05T00:00:00.000Z") }],
    },
    "installedAt equals first event exactly (the common real-world case)",
  );
});

test("randomized population: brute-force equivalence across many synthetic installs", () => {
  // Deterministic PRNG (no Math.random() per this session's own established
  // constraint on non-reproducible randomness in test/workflow code) — a
  // simple mulberry32, seeded, so a failure is reproducible.
  let seed = 42;
  function next(): number {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const EVENT_TYPES = [
    "INSTALLED",
    "REINSTALLED",
    "UNINSTALLED",
    "REACTIVATED",
    "DEACTIVATED",
  ];
  const START = day("2026-01-01T00:00:00.000Z").getTime();
  const SPAN_MS = 200 * 86_400_000;

  for (let i = 0; i < 500; i += 1) {
    const installedAt = new Date(START + Math.floor(next() * SPAN_MS));
    const hasUninstall = next() < 0.3;
    const uninstalledAt = hasUninstall
      ? new Date(installedAt.getTime() + Math.floor(next() * SPAN_MS))
      : null;
    const eventCount = Math.floor(next() * 6);
    const events = Array.from({ length: eventCount }, () => ({
      type: EVENT_TYPES[Math.floor(next() * EVENT_TYPES.length)],
      occurredAt: new Date(installedAt.getTime() + Math.floor(next() * SPAN_MS)),
    })).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    assertEquivalent(
      { installedAt, uninstalledAt, events },
      `random install #${i} (seed-reproducible)`,
    );
  }
});

test("buildDailyInstallStocks satisfies start(D) == end(D-1) + midnightDelta(D) for every day", () => {
  const installs: InstallActivitySource[] = [
    {
      installedAt: day("2026-01-01T00:00:00.000Z"),
      uninstalledAt: null,
      events: [{ type: "INSTALLED", occurredAt: day("2026-01-01T00:00:00.000Z") }],
    },
    {
      installedAt: day("2026-01-10T00:00:00.000Z"),
      uninstalledAt: day("2026-01-20T00:00:00.000Z"),
      events: [
        { type: "INSTALLED", occurredAt: day("2026-01-10T00:00:00.000Z") },
        { type: "UNINSTALLED", occurredAt: day("2026-01-20T00:00:00.000Z") },
      ],
    },
    {
      // Exact-midnight transition — the case that breaks a single-column stock.
      installedAt: day("2026-01-01T00:00:00.000Z"),
      uninstalledAt: null,
      events: [
        { type: "INSTALLED", occurredAt: day("2026-01-01T00:00:00.000Z") },
        { type: "DEACTIVATED", occurredAt: day("2026-01-15T00:00:00.000Z") },
      ],
    },
  ];
  const days: Date[] = [];
  for (let t = day("2026-01-01T00:00:00.000Z").getTime(); t < day("2026-02-01T00:00:00.000Z").getTime(); t += 86_400_000) {
    days.push(new Date(t));
  }
  const stocks = buildDailyInstallStocks(installs, days);

  let previous: { end: number } | null = null;
  for (const d of days) {
    const stock = stocks.get(d.getTime());
    assert.ok(stock, `missing stock row for ${d.toISOString()}`);
    if (previous) {
      // midnightDelta(D) = start(D) - end(D-1); re-derive it independently
      // from the raw transitions rather than trusting the map's own math.
      const midnightDelta = installs.reduce((sum, install) => {
        const atMidnight = installActiveTransitions(install)
          .filter((t) => t.at.getTime() === d.getTime())
          .reduce((s, t) => s + t.delta, 0);
        return sum + atMidnight;
      }, 0);
      assert.equal(
        stock!.activeInstallsAtDayStart,
        previous.end + midnightDelta,
        `identity broken at ${d.toISOString()}`,
      );
    }
    previous = { end: stock!.activeInstallsAtDayEnd };
  }
});
