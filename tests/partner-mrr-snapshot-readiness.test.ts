import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSnapshotCompleteness } from "../app/lib/shopify/partner-mrr-snapshot.server";

function row(appId: string, iso: string) {
  return { appId, snapshotDate: new Date(iso) };
}

const RANGE_START = new Date("2026-07-01T00:00:00.000Z");
const RANGE_END_EXCLUSIVE = new Date("2026-07-04T00:00:00.000Z"); // 3 days: 07-01, 07-02, 07-03

test("applied is true when every app has a row for every expected day", () => {
  const result = evaluateSnapshotCompleteness({
    appIds: ["app-1"],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    rows: [
      row("app-1", "2026-07-01T00:00:00.000Z"),
      row("app-1", "2026-07-02T00:00:00.000Z"),
      row("app-1", "2026-07-03T00:00:00.000Z"),
    ],
  });
  assert.equal(result.applied, true);
  assert.equal(result.missingDays, 0);
  assert.deepEqual(result.readyAppIds, ["app-1"]);
  assert.deepEqual(result.liveAppIds, []);
});

test("one app missing one day disqualifies only that app — the other still serves from the snapshot", () => {
  // 2026-08-16 change: this used to disqualify the WHOLE scope ("applied:
  // false" with nothing else usable). A single young or lagging app in an
  // "All apps" request should not force every other, fully-covered app back
  // onto the slow live path — see `evaluateSnapshotCompleteness`'s own docs.
  const result = evaluateSnapshotCompleteness({
    appIds: ["app-1", "app-2"],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    rows: [
      row("app-1", "2026-07-01T00:00:00.000Z"),
      row("app-1", "2026-07-02T00:00:00.000Z"),
      row("app-1", "2026-07-03T00:00:00.000Z"),
      row("app-2", "2026-07-01T00:00:00.000Z"),
      // app-2 is missing 07-02
      row("app-2", "2026-07-03T00:00:00.000Z"),
    ],
  });
  assert.equal(result.applied, false);
  assert.equal(result.missingDays, 1);
  assert.deepEqual(result.readyAppIds, ["app-1"]);
  assert.deepEqual(result.liveAppIds, ["app-2"]);
});

test("a dirty watermark inside the range disqualifies only that app, even with full day coverage", () => {
  const result = evaluateSnapshotCompleteness({
    appIds: ["app-1", "app-2"],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    rows: [
      row("app-1", "2026-07-01T00:00:00.000Z"),
      row("app-1", "2026-07-02T00:00:00.000Z"),
      row("app-1", "2026-07-03T00:00:00.000Z"),
      row("app-2", "2026-07-01T00:00:00.000Z"),
      row("app-2", "2026-07-02T00:00:00.000Z"),
      row("app-2", "2026-07-03T00:00:00.000Z"),
    ],
    dirtyFromByApp: new Map([
      ["app-2", new Date("2026-07-02T00:00:00.000Z")],
    ]),
  });
  assert.deepEqual(result.readyAppIds, ["app-1"]);
  assert.deepEqual(result.liveAppIds, ["app-2"]);
});

test("a dirty watermark outside (after) the range does not disqualify that app", () => {
  const result = evaluateSnapshotCompleteness({
    appIds: ["app-1"],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    rows: [
      row("app-1", "2026-07-01T00:00:00.000Z"),
      row("app-1", "2026-07-02T00:00:00.000Z"),
      row("app-1", "2026-07-03T00:00:00.000Z"),
    ],
    dirtyFromByApp: new Map([
      ["app-1", new Date("2026-07-10T00:00:00.000Z")],
    ]),
  });
  assert.deepEqual(result.readyAppIds, ["app-1"]);
  assert.deepEqual(result.liveAppIds, []);
});

test("zero apps in scope is never applied — there's nothing to be complete about", () => {
  const result = evaluateSnapshotCompleteness({
    appIds: [],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    rows: [],
  });
  assert.equal(result.applied, false);
});

test("a range that has already collapsed (end <= start, e.g. the whole request is 'today') is never applied", () => {
  const result = evaluateSnapshotCompleteness({
    appIds: ["app-1"],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_START,
    rows: [],
  });
  assert.equal(result.applied, false);
  assert.equal(result.missingDays, -1);
});

test("a stray row outside [rangeStart, rangeEndExclusive) — e.g. one written for today — has no effect on applied", () => {
  const withoutStray = evaluateSnapshotCompleteness({
    appIds: ["app-1"],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    rows: [
      row("app-1", "2026-07-01T00:00:00.000Z"),
      row("app-1", "2026-07-02T00:00:00.000Z"),
      row("app-1", "2026-07-03T00:00:00.000Z"),
    ],
  });
  const withStray = evaluateSnapshotCompleteness({
    appIds: ["app-1"],
    rangeStart: RANGE_START,
    rangeEndExclusive: RANGE_END_EXCLUSIVE,
    rows: [
      row("app-1", "2026-07-01T00:00:00.000Z"),
      row("app-1", "2026-07-02T00:00:00.000Z"),
      row("app-1", "2026-07-03T00:00:00.000Z"),
      // A row for "today", outside the checked window — must not matter.
      row("app-1", "2026-07-04T00:00:00.000Z"),
    ],
  });
  assert.equal(withoutStray.applied, true);
  assert.equal(withStray.applied, true);
  assert.equal(withoutStray.missingDays, withStray.missingDays);
});
