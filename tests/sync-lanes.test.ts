import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLaneResponse,
  LANE_NAMES,
  runSyncLanes,
  type LaneName,
} from "../app/lib/shopify/sync-lanes.server";

/** Resolves a cron URL back to its lane, failing loudly on anything else. */
function laneFromUrl(url: string | URL): LaneName {
  const lane = LANE_NAMES.find((candidate) =>
    String(url).endsWith(`/api/flex/cron/${candidate}`),
  );
  assert.ok(lane, `unexpected URL: ${url}`);
  return lane;
}

/**
 * Builds a fetch stub that answers each lane from a scripted queue of statuses,
 * recording the calls it received.
 *
 * `fallback` answers any lane the test did not script, and any call past the end
 * of a scripted queue. It defaults to 200 so a test only has to describe the
 * lanes it is actually about — deliberately: these tests used to default to 202
 * (pending forever), which meant every new entry in LANE_NAMES silently broke
 * assertions about `settledCleanly` in tests that had nothing to do with it.
 * Tests that need a lane to never converge ask for `fallback: 202` explicitly.
 */
function stubFetch(
  plan: Partial<Record<LaneName, number[]>>,
  { fallback = 200 }: { fallback?: number } = {},
) {
  const calls: LaneName[] = [];
  const queues = new Map<LaneName, number[]>(
    LANE_NAMES.map((lane) => [lane, [...(plan[lane] ?? [])]]),
  );
  const fetchImpl = (async (url: string | URL) => {
    const lane = laneFromUrl(url);
    calls.push(lane);
    const status = queues.get(lane)!.shift() ?? fallback;
    return new Response(JSON.stringify({ complete: status === 200 }), {
      status,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

test("a lane stops being retried once it reports complete", async () => {
  const { fetchImpl, calls } = stubFetch({
    "subscription-events": [200],
    "customer-events": [202, 202, 200],
  });

  const summary = await runSyncLanes({
    fetchImpl,
    sleepImpl: noSleep,
    maxIterations: 5,
    pauseMs: 0,
  });

  assert.equal(summary.lanes["subscription-events"], "complete");
  assert.equal(summary.lanes["customer-events"], "complete");
  assert.equal(summary.settledCleanly, true);
  // The finished lane must not be called again after its 200.
  assert.equal(calls.filter((lane) => lane === "subscription-events").length, 1);
  assert.equal(calls.filter((lane) => lane === "customer-events").length, 3);
});

test("503 retires a lane for the run instead of retrying it", async () => {
  const { fetchImpl, calls } = stubFetch({
    "subscription-events": [503],
    "customer-events": [200],
  });

  const summary = await runSyncLanes({
    fetchImpl,
    sleepImpl: noSleep,
    maxIterations: 5,
    pauseMs: 0,
  });

  assert.equal(summary.lanes["subscription-events"], "unusable");
  // Unusable is terminal-but-not-broken, so the run still settles cleanly.
  assert.equal(summary.settledCleanly, true);
  assert.equal(calls.filter((lane) => lane === "subscription-events").length, 1);
});

test("an unexpected status is retryable, never treated as complete", async () => {
  // A 500 must not end the run declaring the backfill finished — that would
  // strand history permanently while reporting success.
  const { fetchImpl } = stubFetch({
    "subscription-events": [500, 500],
    "customer-events": [200],
  });

  const summary = await runSyncLanes({
    fetchImpl,
    sleepImpl: noSleep,
    maxIterations: 2,
    pauseMs: 0,
  });

  assert.equal(summary.lanes["subscription-events"], "incomplete");
  assert.equal(summary.settledCleanly, false);
});

test("one lane throwing does not abandon the others", async () => {
  const calls: LaneName[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const lane = laneFromUrl(url);
    calls.push(lane);
    if (lane === "subscription-events") throw new Error("connection refused");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const summary = await runSyncLanes({
    fetchImpl,
    sleepImpl: noSleep,
    maxIterations: 3,
    pauseMs: 0,
  });

  assert.equal(summary.lanes["subscription-events"], "error");
  assert.equal(summary.lanes["customer-events"], "complete");
  assert.ok(calls.includes("customer-events"));
});

test("the deadline stops new iterations and leaves the lanes resumable", async () => {
  let now = 0;
  const { fetchImpl, calls } = stubFetch({}, { fallback: 202 });

  const summary = await runSyncLanes({
    fetchImpl,
    sleepImpl: async () => {
      // Each pause advances the clock past the deadline.
      now += 1_000;
    },
    nowImpl: () => now,
    deadlineMs: 1_500,
    maxIterations: 50,
    pauseMs: 0,
  });

  // Every lane answers 202 forever, so only the deadline can end this.
  for (const lane of LANE_NAMES) {
    assert.equal(summary.lanes[lane], "incomplete", `${lane} should be incomplete`);
  }
  assert.ok(
    summary.iterations < 50,
    `deadline should stop the loop early, ran ${summary.iterations}`,
  );
  assert.ok(calls.length > 0, "should have attempted at least one chunk");
});

test("maxIterations bounds a lane that never converges", async () => {
  const { fetchImpl, calls } = stubFetch({}, { fallback: 202 });

  const summary = await runSyncLanes({
    fetchImpl,
    sleepImpl: noSleep,
    maxIterations: 4,
    pauseMs: 0,
  });

  assert.equal(summary.iterations, 4);
  // Every lane, four iterations each — derived from LANE_NAMES rather than
  // hardcoded, so adding a lane does not make this test a liar.
  assert.equal(calls.length, LANE_NAMES.length * 4);
});

test("classifyLaneResponse only treats 200 as complete and 503 as unusable", () => {
  assert.deepEqual(classifyLaneResponse(200), {
    complete: true,
    unusable: false,
  });
  assert.deepEqual(classifyLaneResponse(202), {
    complete: false,
    unusable: false,
  });
  assert.deepEqual(classifyLaneResponse(503), {
    complete: false,
    unusable: true,
  });
  for (const status of [400, 401, 404, 500, 502]) {
    assert.deepEqual(
      classifyLaneResponse(status),
      { complete: false, unusable: false },
      `status ${status} must stay retryable`,
    );
  }
});

test("every lane the schedule owns is in LANE_NAMES", () => {
  // The pm2 `rapi-management-sync` cron drives exactly this list. traffic-events
  // is here because the GitHub Actions workflow that used to be its only trigger
  // was deleted (2026-08-21) — dropping it would silently strand the GA4
  // backfill again, with nothing failing to say so. `app-reviews` (App Store
  // reviews, app-reviews-sync.server.ts) has no other trigger at all.
  assert.deepEqual(
    [...LANE_NAMES],
    [
      "subscription-events",
      "customer-events",
      "traffic-events",
      "app-reviews",
    ],
  );
});

test("the driver runs lanes in list order", async () => {
  const { fetchImpl, calls } = stubFetch({}, { fallback: 202 });
  await runSyncLanes({
    fetchImpl,
    sleepImpl: noSleep,
    maxIterations: 1,
    pauseMs: 0,
  });

  assert.deepEqual(calls, [...LANE_NAMES]);
});

test("a lane that only ever answers 200 settles in a single call", () => {
  // traffic-events never answers 202: one call advances one
  // bounded window and the next tick takes the following one. 200 has to be
  // terminal for that to be safe.
  assert.equal(classifyLaneResponse(200).complete, true);
});
