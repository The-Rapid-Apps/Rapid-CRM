import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_LIFECYCLE_EVENTS_QUERY,
  FIRST_RECENT_WINDOW_MS,
  LIFECYCLE_OVERLAP_BUFFER_MS,
  lifecycleFreshness,
  planRecentLifecycleWindow,
} from "../app/lib/customer-events/poll.server";
import { installLifecycleMirrorUpdate } from "../app/lib/customer-events/derive.server";

const emptyWindowState = {
  lifecycleEventsSyncedAt: null,
  lifecycleEventsIncrementalCursor: null,
  lifecycleEventsIncrementalMinAt: null,
  lifecycleEventsIncrementalMaxAt: null,
  lifecycleEventsBackfillCompletedAt: null,
};

test("first lifecycle refresh prioritizes a bounded recent window", () => {
  const requestedAt = new Date("2026-08-03T12:00:00.000Z");
  const window = planRecentLifecycleWindow(emptyWindowState, requestedAt);

  assert.equal(window.after, null);
  assert.equal(window.occurredAtMax.toISOString(), requestedAt.toISOString());
  assert.equal(
    window.occurredAtMin.getTime(),
    requestedAt.getTime() - FIRST_RECENT_WINDOW_MS,
  );
  assert.equal(window.resumed, false);
});

test("resumed lifecycle cursor keeps immutable min and max arguments", () => {
  const fixedMin = new Date("2026-07-29T10:00:00.000Z");
  const fixedMax = new Date("2026-08-03T10:00:00.000Z");
  const window = planRecentLifecycleWindow(
    {
      ...emptyWindowState,
      lifecycleEventsSyncedAt: new Date("2026-08-03T09:00:00.000Z"),
      lifecycleEventsIncrementalCursor: "cursor-page-4",
      lifecycleEventsIncrementalMinAt: fixedMin,
      lifecycleEventsIncrementalMaxAt: fixedMax,
    },
    new Date("2026-08-03T14:00:00.000Z"),
  );

  assert.equal(window.after, "cursor-page-4");
  assert.equal(window.occurredAtMin, fixedMin);
  assert.equal(window.occurredAtMax, fixedMax);
  assert.equal(window.resumed, true);
});

test("subsequent lifecycle refresh overlaps the completed watermark", () => {
  const syncedAt = new Date("2026-08-03T10:00:00.000Z");
  const window = planRecentLifecycleWindow(
    { ...emptyWindowState, lifecycleEventsSyncedAt: syncedAt },
    new Date("2026-08-03T12:00:00.000Z"),
  );

  assert.equal(
    window.occurredAtMin.getTime(),
    syncedAt.getTime() - LIFECYCLE_OVERLAP_BUFFER_MS,
  );
});

test("recent lifecycle data can be fresh before historical backfill completes", () => {
  const requestedAt = new Date("2026-08-03T12:00:00.000Z");
  const freshness = lifecycleFreshness(
    {
      lifecycleEventsSyncedAt: requestedAt,
      lifecycleEventsBackfillCompletedAt: null,
    },
    requestedAt,
  );

  assert.equal(freshness.fresh, true);
  assert.equal(freshness.historyComplete, false);
  assert.equal(freshness.exact, false);
});

test("lifecycle data is exact only when recent and historical lanes complete", () => {
  const requestedAt = new Date("2026-08-03T12:00:00.000Z");
  const freshness = lifecycleFreshness(
    {
      lifecycleEventsSyncedAt: requestedAt,
      lifecycleEventsBackfillCompletedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    requestedAt,
  );

  assert.equal(freshness.fresh, true);
  assert.equal(freshness.historyComplete, true);
  assert.equal(freshness.exact, true);
});

test("Partner account lifecycle query fixes both cursor window bounds", () => {
  assert.match(ACCOUNT_LIFECYCLE_EVENTS_QUERY, /\$occurredAtMin:\s*DateTime/);
  assert.match(ACCOUNT_LIFECYCLE_EVENTS_QUERY, /\$occurredAtMax:\s*DateTime/);
  assert.match(
    ACCOUNT_LIFECYCLE_EVENTS_QUERY,
    /occurredAtMin:\s*\$occurredAtMin/,
  );
  assert.match(
    ACCOUNT_LIFECYCLE_EVENTS_QUERY,
    /occurredAtMax:\s*\$occurredAtMax/,
  );
});

test("historical install facts backdate first seen without reviving an uninstall", () => {
  const update = installLifecycleMirrorUpdate({
    rawType: "RELATIONSHIP_INSTALLED",
    occurredAt: new Date("2026-06-01T00:00:00.000Z"),
    installedAt: new Date("2026-07-01T00:00:00.000Z"),
    uninstalledAt: new Date("2026-08-01T00:00:00.000Z"),
    relationshipStateSyncedAt: new Date("2026-08-01T00:00:00.000Z"),
  });

  assert.equal(update.installedAt?.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal("uninstalledAt" in update, false);
});

test("only a newer relationship event changes the current install state", () => {
  const oldUninstall = installLifecycleMirrorUpdate({
    rawType: "RELATIONSHIP_UNINSTALLED",
    occurredAt: new Date("2026-07-01T00:00:00.000Z"),
    installedAt: new Date("2026-06-01T00:00:00.000Z"),
    uninstalledAt: null,
    relationshipStateSyncedAt: new Date("2026-07-15T00:00:00.000Z"),
  });
  assert.equal("uninstalledAt" in oldUninstall, false);

  const newestUninstall = installLifecycleMirrorUpdate({
    rawType: "RELATIONSHIP_UNINSTALLED",
    occurredAt: new Date("2026-08-03T00:00:00.000Z"),
    installedAt: new Date("2026-06-01T00:00:00.000Z"),
    uninstalledAt: null,
    relationshipStateSyncedAt: new Date("2026-07-15T00:00:00.000Z"),
  });
  assert.equal(
    newestUninstall.uninstalledAt?.toISOString(),
    "2026-08-03T00:00:00.000Z",
  );

  const newestReinstall = installLifecycleMirrorUpdate({
    rawType: "RELATIONSHIP_INSTALLED",
    occurredAt: new Date("2026-08-04T00:00:00.000Z"),
    installedAt: new Date("2026-06-01T00:00:00.000Z"),
    uninstalledAt: new Date("2026-08-03T00:00:00.000Z"),
    relationshipStateSyncedAt: new Date("2026-08-03T00:00:00.000Z"),
  });
  assert.equal(newestReinstall.uninstalledAt, null);

  const newestReactivation = installLifecycleMirrorUpdate({
    rawType: "RELATIONSHIP_REACTIVATED",
    occurredAt: new Date("2026-08-05T00:00:00.000Z"),
    installedAt: new Date("2026-06-01T00:00:00.000Z"),
    uninstalledAt: new Date("2026-08-03T00:00:00.000Z"),
    relationshipStateSyncedAt: new Date("2026-08-03T00:00:00.000Z"),
  });
  assert.equal(newestReactivation.uninstalledAt, null);
});

test("deactivation advances state ordering without marking an uninstall", () => {
  const occurredAt = new Date("2026-08-06T00:00:00.000Z");
  const update = installLifecycleMirrorUpdate({
    rawType: "RELATIONSHIP_DEACTIVATED",
    occurredAt,
    installedAt: new Date("2026-06-01T00:00:00.000Z"),
    uninstalledAt: null,
    relationshipStateSyncedAt: new Date("2026-08-05T00:00:00.000Z"),
  });

  assert.equal(update.relationshipStateSyncedAt, occurredAt);
  assert.equal("uninstalledAt" in update, false);
});
