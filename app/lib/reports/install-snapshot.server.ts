import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "../db.server";
import { logger } from "../logger.server";
import { claimRedisThrottle } from "../cache/redis-cache.server";
import { installIsActiveAt, startOfUtcDay } from "./analytics.server";

const log = logger.scope("install-snapshot");

const DAY_MS = 86_400_000;

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

/** The three event types `installIsActiveAt` treats as "active". */
const ACTIVATING_TYPES = new Set(["INSTALLED", "REINSTALLED", "REACTIVATED"]);

export interface InstallLifecycleEvent {
  type: string;
  occurredAt: Date;
}

export interface InstallActivitySource {
  installedAt: Date;
  uninstalledAt: Date | null;
  /** Ascending by `occurredAt`. */
  events: InstallLifecycleEvent[];
}

export interface ActiveTransition {
  at: Date;
  delta: 1 | -1;
}

/**
 * State just before `at`, under the `installedAt`/`uninstalledAt` fallback
 * rule alone (`installIsActiveAt`'s branch for "no event at or before `at`
 * exists yet") — i.e. the limit as time approaches `at` from below. Left-
 * closed transitions mean this is `installedAt < at` (not `<=`): at exactly
 * `installedAt`, the install *becomes* active, so "just before" is not yet.
 */
function fallbackActiveJustBefore(
  installedAt: Date,
  uninstalledAt: Date | null,
  at: Date,
): boolean {
  return (
    installedAt.getTime() < at.getTime() &&
    (uninstalledAt === null || uninstalledAt.getTime() >= at.getTime())
  );
}

/**
 * Every instant at which one install's `installIsActiveAt` verdict flips,
 * expressed as a signed delta — the single source of truth this whole
 * snapshot table is built on. Left-closed, matching `installIsActiveAt`
 * exactly: a transition's effect is visible starting *at* its own instant.
 *
 * Two regimes, exactly mirroring `installIsActiveAt`'s own two branches:
 *
 * 1. Before any event exists at-or-before `at`, the verdict falls back to
 *    `installedAt <= at && (!uninstalledAt || uninstalledAt > at)` — an
 *    "active" interval of `[installedAt, min(uninstalledAt, firstEventAt))`,
 *    only emitted if that interval is non-empty. If there are no events at
 *    all, this is the *only* regime, and it runs forever (or until
 *    `uninstalledAt`).
 * 2. From each event onward, the verdict is that event's type. Only emits a
 *    transition where the verdict actually *changes* — two consecutive
 *    activating events (e.g. FROZEN-then-UNFROZEN was never inactive to
 *    begin with... concretely: INSTALLED then REACTIVATED with nothing
 *    between) must not double-count the install as if it activated twice.
 *
 * Verified against `installIsActiveAt` directly, at randomized instants,
 * over a large synthetic population — see
 * tests/install-snapshot-transitions.test.ts. Do not change this function
 * without re-running that test: it is the only thing standing between this
 * table and a silently wrong active-install count.
 */
export function installActiveTransitions(
  install: InstallActivitySource,
): ActiveTransition[] {
  const { installedAt, uninstalledAt, events } = install;
  const transitions: ActiveTransition[] = [];
  const firstEventAt = events[0]?.occurredAt ?? null;

  if (firstEventAt === null) {
    // No events ever recorded: the fallback interval is the whole story.
    if (uninstalledAt === null || installedAt.getTime() < uninstalledAt.getTime()) {
      transitions.push({ at: installedAt, delta: 1 });
      if (uninstalledAt !== null) transitions.push({ at: uninstalledAt, delta: -1 });
    }
    return transitions;
  }

  // Fallback governs [installedAt, cutoff), where cutoff is whichever comes
  // first: the first event, or an uninstall that lands before it.
  const cutoff =
    uninstalledAt !== null && uninstalledAt.getTime() < firstEventAt.getTime()
      ? uninstalledAt
      : firstEventAt;
  if (installedAt.getTime() < cutoff.getTime()) {
    transitions.push({ at: installedAt, delta: 1 });
    if (cutoff.getTime() !== firstEventAt.getTime()) {
      // uninstalledAt cut the fallback interval short, before any event
      // took over — without this, the install would read as active forever.
      transitions.push({ at: cutoff, delta: -1 });
    }
  }

  // The event loop's starting state must match the fallback's own verdict
  // for the instant just before the first event, or the first event's
  // transition (or lack of one) would be evaluated against the wrong state.
  let currentlyActive = fallbackActiveJustBefore(
    installedAt,
    uninstalledAt,
    firstEventAt,
  );
  for (const event of events) {
    const newState = ACTIVATING_TYPES.has(event.type);
    if (newState !== currentlyActive) {
      transitions.push({ at: event.occurredAt, delta: newState ? 1 : -1 });
      currentlyActive = newState;
    }
  }

  return transitions;
}

export interface DailyInstallStock {
  activeInstallsAtDayStart: number;
  activeInstallsAtDayEnd: number;
}

/**
 * Every install's transitions folded into one shared per-day delta map, then
 * two running prefix sums — the only correct way to build this stock. Not a
 * `GROUP BY`: each day's value depends on every earlier day's, so a day can
 * only be computed once every prior day already has been.
 *
 * `days` must be UTC-midnight, ascending, and *contiguous* starting from the
 * account's true floor (or from a day whose starting stock is already known
 * to be `startingCumulative`, e.g. a chunked writer resuming from an
 * anchor) — a gap would silently break the running sum.
 */
export function buildDailyInstallStocks(
  installs: InstallActivitySource[],
  days: Date[],
  startingCumulative = 0,
): Map<number, DailyInstallStock> {
  const byDay = new Map<number, { atMidnight: number; duringDay: number }>();
  for (const install of installs) {
    for (const transition of installActiveTransitions(install)) {
      const dayKey = startOfUtcDay(transition.at).getTime();
      const entry = byDay.get(dayKey) ?? { atMidnight: 0, duringDay: 0 };
      if (transition.at.getTime() === dayKey) {
        entry.atMidnight += transition.delta;
      } else {
        entry.duringDay += transition.delta;
      }
      byDay.set(dayKey, entry);
    }
  }

  const result = new Map<number, DailyInstallStock>();
  let cumulativeBeforeDay = startingCumulative;
  for (const day of days) {
    const dayKey = day.getTime();
    const { atMidnight = 0, duringDay = 0 } = byDay.get(dayKey) ?? {};
    const activeInstallsAtDayStart = cumulativeBeforeDay + atMidnight;
    const activeInstallsAtDayEnd = activeInstallsAtDayStart + duringDay;
    result.set(dayKey, { activeInstallsAtDayStart, activeInstallsAtDayEnd });
    cumulativeBeforeDay = activeInstallsAtDayEnd;
  }
  return result;
}

/** UTC-midnight days, ascending, `[start, endExclusive)`. */
export function utcDayRange(start: Date, endExclusive: Date): Date[] {
  const days: Date[] = [];
  for (
    let day = startOfUtcDay(start);
    day.getTime() < endExclusive.getTime();
    day = addUtcDays(day, 1)
  ) {
    days.push(day);
  }
  return days;
}

// ---------------------------------------------------------------------------
// DB-touching writer. Everything above this line is pure and unit-tested in
// isolation; everything below assembles real `AppInstall`/`AccountLifecycleEvent`
// rows into the `InstallActivitySource` shape those pure functions expect,
// then persists the result. See the plan's Phase 3 for the incremental
// dirty-range design this implements.
// ---------------------------------------------------------------------------

const WRITE_BATCH_SIZE = 500;
const ID_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface TouchedInstallColumns {
  id: string;
  installedAt: Date;
  uninstalledAt: Date | null;
}

interface TouchedLifecycleEvent {
  type: string;
  occurredAt: Date;
  /** null for every type except UNINSTALLED. */
  isStoreClosure: boolean | null;
}

/**
 * Every install touched within `[dirtyFrom, todayStart)` — either a lifecycle
 * event landed in that window, or the install's own `installedAt`/
 * `uninstalledAt` columns moved into it (a brand-new install, or a real-time
 * webhook/API uninstall that hasn't produced a polled lifecycle event yet).
 * Untouched installs contribute zero transitions in this window by
 * definition, so omitting them from the fold is correct — their constant
 * contribution comes from the persisted anchor instead, corrected for
 * touched installs' own pre-window share (see
 * `preexistingActiveAtDirtyFromCount` below).
 */
async function loadTouchedInstallIds(
  appId: string,
  dirtyFrom: Date,
  todayStart: Date,
): Promise<string[]> {
  const [eventTouched, columnTouched] = await Promise.all([
    prisma.accountLifecycleEvent.findMany({
      where: { appId, occurredAt: { gte: dirtyFrom, lt: todayStart } },
      select: { appInstallId: true },
      distinct: ["appInstallId"],
    }),
    prisma.appInstall.findMany({
      where: {
        appId,
        OR: [
          { installedAt: { gte: dirtyFrom, lt: todayStart } },
          { uninstalledAt: { gte: dirtyFrom, lt: todayStart } },
        ],
      },
      select: { id: true },
    }),
  ]);
  return [
    ...new Set([
      ...eventTouched.map((e) => e.appInstallId),
      ...columnTouched.map((i) => i.id),
    ]),
  ];
}

async function loadInstallColumnsForIds(
  installIds: string[],
): Promise<Map<string, TouchedInstallColumns>> {
  const result = new Map<string, TouchedInstallColumns>();
  for (const idsChunk of chunk(installIds, ID_CHUNK_SIZE)) {
    const rows = await prisma.appInstall.findMany({
      where: { id: { in: idsChunk } },
      select: { id: true, installedAt: true, uninstalledAt: true },
    });
    for (const row of rows) result.set(row.id, row);
  }
  return result;
}

/**
 * Per touched install, the single latest lifecycle event strictly before
 * `dirtyFrom` — the "opening balance" this window resumes from, mirroring
 * `loadOpeningBalanceInstallEvents` in `analytics.server.ts` but scoped
 * directly by the denormalized `appId` column (no join needed) and by an
 * explicit install-id list rather than a whole-tenant scan.
 */
async function loadOpeningBalanceForInstalls(
  installIds: string[],
  dirtyFrom: Date,
): Promise<Map<string, { type: string; occurredAt: Date }>> {
  const result = new Map<string, { type: string; occurredAt: Date }>();
  for (const idsChunk of chunk(installIds, ID_CHUNK_SIZE)) {
    const rows = await prisma.$queryRaw<
      Array<{ appInstallId: string; type: string; occurredAt: Date }>
    >`
      SELECT t.appInstallId, t.type, t.occurredAt
      FROM (
        SELECT e.appInstallId, e.type, e.occurredAt,
          ROW_NUMBER() OVER (
            PARTITION BY e.appInstallId
            ORDER BY e.occurredAt DESC, e.id DESC
          ) AS rn
        FROM account_lifecycle_events e
        WHERE e.appInstallId IN (${Prisma.join(idsChunk)})
          AND e.occurredAt < ${dirtyFrom}
      ) t
      WHERE t.rn = 1
    `;
    for (const row of rows) {
      result.set(row.appInstallId, { type: row.type, occurredAt: row.occurredAt });
    }
  }
  return result;
}

/** Every lifecycle event within `[dirtyFrom, todayStart)` for the touched
 * installs — this is also the complete flow data for the window, reused for
 * both the stock (`InstallActivitySource.events`) and flow aggregation below
 * rather than running a second set of `GROUP BY` queries over the same rows. */
async function loadWindowedEventsForInstalls(
  installIds: string[],
  dirtyFrom: Date,
  todayStart: Date,
): Promise<Map<string, TouchedLifecycleEvent[]>> {
  const result = new Map<string, TouchedLifecycleEvent[]>();
  for (const idsChunk of chunk(installIds, ID_CHUNK_SIZE)) {
    const rows = await prisma.accountLifecycleEvent.findMany({
      where: {
        appInstallId: { in: idsChunk },
        occurredAt: { gte: dirtyFrom, lt: todayStart },
      },
      select: {
        appInstallId: true,
        type: true,
        occurredAt: true,
        uninstallDetail: { select: { isStoreClosure: true } },
      },
      orderBy: { occurredAt: "asc" },
    });
    for (const row of rows) {
      const list = result.get(row.appInstallId) ?? [];
      list.push({
        type: row.type,
        occurredAt: row.occurredAt,
        isStoreClosure: row.uninstallDetail?.isStoreClosure ?? null,
      });
      result.set(row.appInstallId, list);
    }
  }
  return result;
}

interface TouchedInstallSourcesResult {
  sources: InstallActivitySource[];
  /**
   * Count of touched, pre-existing installs that were already active at
   * `dirtyFrom` — must be *subtracted* from the persisted anchor before
   * folding, or they're counted twice: once implicitly (the anchor is a
   * plain total over every install, touched or not, as of the day before
   * `dirtyFrom`) and once explicitly (their own synthetic "become active"
   * transition, needed so their later real events fold correctly). A
   * genuinely new install (`installedAt >= dirtyFrom`) was never part of the
   * anchor in the first place, so it never contributes to this correction.
   */
  preexistingActiveAtDirtyFromCount: number;
}

/**
 * Builds one `InstallActivitySource` per touched install, resuming
 * mid-history via a synthetic opening-balance event where needed instead of
 * re-deriving `installActiveTransitions` for a windowed input — this is what
 * lets that already-tested pure function stay completely unchanged.
 *
 * Two cases per touched install:
 * - Genuinely new within the window (`installedAt >= dirtyFrom`): pass its
 *   real `installedAt`/`uninstalledAt` straight through — there is no prior
 *   state to resume from.
 * - Pre-existing (`installedAt < dirtyFrom`): represent "known state at
 *   `dirtyFrom`" as a synthetic event of matching type (`INSTALLED` if
 *   active, `DEACTIVATED` if not) placed exactly at `dirtyFrom`, combined
 *   with `installedAt: dirtyFrom, uninstalledAt: null`. This makes the
 *   fallback interval zero-width (non-interfering) and correctly seeds
 *   `installActiveTransitions`' event loop. The synthetic event is placed
 *   first in the array so a real event landing at the exact same instant
 *   (rare, but possible at exact UTC midnight) is still evaluated against
 *   the right starting state. See `preexistingActiveAtDirtyFromCount` above
 *   for why the anchor must be corrected to avoid double-counting this case.
 */
function buildTouchedInstallSources(
  touchedIds: string[],
  columns: Map<string, TouchedInstallColumns>,
  openingBalances: Map<string, { type: string; occurredAt: Date }>,
  eventsByInstall: Map<string, TouchedLifecycleEvent[]>,
  dirtyFrom: Date,
): TouchedInstallSourcesResult {
  const sources: InstallActivitySource[] = [];
  let preexistingActiveAtDirtyFromCount = 0;
  for (const id of touchedIds) {
    const install = columns.get(id);
    if (!install) continue; // Defensive: shouldn't happen outside a race.
    const events: InstallLifecycleEvent[] = (eventsByInstall.get(id) ?? []).map(
      (e) => ({ type: e.type, occurredAt: e.occurredAt }),
    );

    if (install.installedAt.getTime() >= dirtyFrom.getTime()) {
      sources.push({
        installedAt: install.installedAt,
        uninstalledAt: install.uninstalledAt,
        events,
      });
      continue;
    }

    const opening = openingBalances.get(id);
    const activeAtDirtyFrom = opening
      ? ACTIVATING_TYPES.has(opening.type)
      : fallbackActiveJustBefore(install.installedAt, install.uninstalledAt, dirtyFrom);
    if (activeAtDirtyFrom) preexistingActiveAtDirtyFromCount += 1;

    sources.push({
      installedAt: dirtyFrom,
      uninstalledAt: null,
      events: [
        { type: activeAtDirtyFrom ? "INSTALLED" : "DEACTIVATED", occurredAt: dirtyFrom },
        ...events,
      ],
    });
  }
  return { sources, preexistingActiveAtDirtyFromCount };
}

export interface DailyInstallFlow {
  newInstalls: number;
  uninstallsAll: number;
  logoLost: number;
  logoRecovered: number;
  reactivations: number;
  deactivations: number;
}

function emptyFlow(): DailyInstallFlow {
  return {
    newInstalls: 0,
    uninstallsAll: 0,
    logoLost: 0,
    logoRecovered: 0,
    reactivations: 0,
    deactivations: 0,
  };
}

/**
 * Day-additive by construction: each event/new-install is attributed to
 * exactly one day, so unlike the stock these can be summed freely across any
 * bucket without re-deriving anything.
 */
function buildDailyInstallFlows(
  touchedInstalls: Map<string, TouchedInstallColumns>,
  eventsByInstall: Map<string, TouchedLifecycleEvent[]>,
  days: Date[],
): Map<number, DailyInstallFlow> {
  const byDay = new Map<number, DailyInstallFlow>();
  for (const day of days) byDay.set(day.getTime(), emptyFlow());

  for (const install of touchedInstalls.values()) {
    const flow = byDay.get(startOfUtcDay(install.installedAt).getTime());
    if (flow) flow.newInstalls += 1;
  }

  for (const events of eventsByInstall.values()) {
    for (const event of events) {
      const flow = byDay.get(startOfUtcDay(event.occurredAt).getTime());
      if (!flow) continue;
      switch (event.type) {
        case "UNINSTALLED":
          flow.uninstallsAll += 1;
          if (!event.isStoreClosure) flow.logoLost += 1;
          break;
        case "REINSTALLED":
          flow.logoRecovered += 1;
          break;
        case "REACTIVATED":
          flow.reactivations += 1;
          break;
        case "DEACTIVATED":
          flow.deactivations += 1;
          break;
      }
    }
  }
  return byDay;
}

export interface InstallSnapshotRow extends DailyInstallStock, DailyInstallFlow {
  appId: string;
  snapshotDate: Date;
  builtFromLifecycleSyncedAt: Date | null;
}

/**
 * Computes one row per day in `[dirtyFrom, todayStart)`, anchored on
 * `anchorActiveInstalls` (the already-known-correct `activeInstallsAtDayEnd`
 * for the day before `dirtyFrom`). Pass `anchorActiveInstalls: 0` only when
 * `dirtyFrom` is the account's true floor date (nothing can be active
 * before it exists).
 */
export async function computeDirtyRangeSnapshotRows(
  appId: string,
  dirtyFrom: Date,
  todayStart: Date,
  anchorActiveInstalls: number,
  builtFromLifecycleSyncedAt: Date | null,
): Promise<InstallSnapshotRow[]> {
  const days = utcDayRange(dirtyFrom, todayStart);
  if (days.length === 0) return [];

  const touchedIds = await loadTouchedInstallIds(appId, dirtyFrom, todayStart);
  if (touchedIds.length === 0) {
    // Nothing changed in this window: every day is flat at the anchor.
    return days.map((day) => ({
      appId,
      snapshotDate: day,
      activeInstallsAtDayStart: anchorActiveInstalls,
      activeInstallsAtDayEnd: anchorActiveInstalls,
      ...emptyFlow(),
      builtFromLifecycleSyncedAt,
    }));
  }

  const [columns, openingBalances, eventsByInstall] = await Promise.all([
    loadInstallColumnsForIds(touchedIds),
    loadOpeningBalanceForInstalls(touchedIds, dirtyFrom),
    loadWindowedEventsForInstalls(touchedIds, dirtyFrom, todayStart),
  ]);

  const { sources, preexistingActiveAtDirtyFromCount } = buildTouchedInstallSources(
    touchedIds,
    columns,
    openingBalances,
    eventsByInstall,
    dirtyFrom,
  );
  // The persisted anchor is a plain total (touched + untouched installs)
  // as of the day before `dirtyFrom`; subtract the touched installs' own
  // pre-window contribution here so their synthetic "resume" transition
  // above doesn't double-count them — see `preexistingActiveAtDirtyFromCount`.
  const correctedAnchor = anchorActiveInstalls - preexistingActiveAtDirtyFromCount;
  const stocks = buildDailyInstallStocks(sources, days, correctedAnchor);
  const flows = buildDailyInstallFlows(columns, eventsByInstall, days);

  return days.map((day) => {
    const dayKey = day.getTime();
    const stock = stocks.get(dayKey)!;
    const flow = flows.get(dayKey)!;
    return {
      appId,
      snapshotDate: day,
      ...stock,
      ...flow,
      builtFromLifecycleSyncedAt,
    };
  });
}

async function writeInstallSnapshotRows(rows: InstallSnapshotRow[]): Promise<void> {
  for (const batch of chunk(rows, WRITE_BATCH_SIZE)) {
    if (batch.length === 0) continue;
    const valueRows = Prisma.join(
      batch.map(
        (row) => Prisma.sql`(${randomUUID()}, ${row.appId}, ${row.snapshotDate}, ${row.activeInstallsAtDayStart}, ${row.activeInstallsAtDayEnd}, ${row.newInstalls}, ${row.uninstallsAll}, ${row.logoLost}, ${row.logoRecovered}, ${row.reactivations}, ${row.deactivations}, ${row.builtFromLifecycleSyncedAt}, NOW(3), NOW(3))`,
      ),
    );
    await prisma.$executeRaw`
      INSERT INTO partner_daily_install_snapshots
        (id, appId, snapshotDate, activeInstallsAtDayStart, activeInstallsAtDayEnd,
         newInstalls, uninstallsAll, logoLost, logoRecovered, reactivations, deactivations,
         builtFromLifecycleSyncedAt, computedAt, updatedAt)
      VALUES ${valueRows}
      ON DUPLICATE KEY UPDATE
        activeInstallsAtDayStart = VALUES(activeInstallsAtDayStart),
        activeInstallsAtDayEnd = VALUES(activeInstallsAtDayEnd),
        newInstalls = VALUES(newInstalls),
        uninstallsAll = VALUES(uninstallsAll),
        logoLost = VALUES(logoLost),
        logoRecovered = VALUES(logoRecovered),
        reactivations = VALUES(reactivations),
        deactivations = VALUES(deactivations),
        builtFromLifecycleSyncedAt = VALUES(builtFromLifecycleSyncedAt),
        computedAt = NOW(3),
        updatedAt = NOW(3)
    `;
  }
}

/**
 * Marks a day dirty for the incremental install-snapshot writer — call this
 * from every write path that can move `AppInstall`/`AccountLifecycleEvent`
 * history: the polled-events derivation, the uninstall webhook, and the
 * `/api/installs` install/uninstall mutation. Only ever *lowers* the
 * watermark (a later call with a more recent day is a no-op) — the writer
 * always rewrites forward from the oldest known-dirty day.
 */
export async function markInstallSnapshotDirty(
  appId: string,
  occurredAt: Date,
): Promise<void> {
  const day = startOfUtcDay(occurredAt);
  await prisma.app.updateMany({
    where: {
      id: appId,
      OR: [{ installSnapshotDirtyFrom: null }, { installSnapshotDirtyFrom: { gt: day } }],
    },
    data: { installSnapshotDirtyFrom: day },
  });
}

async function computeInstallSnapshotFloorDate(appId: string): Promise<Date | null> {
  const [minInstall, minEvent] = await Promise.all([
    prisma.appInstall.aggregate({ where: { appId }, _min: { installedAt: true } }),
    prisma.accountLifecycleEvent.aggregate({ where: { appId }, _min: { occurredAt: true } }),
  ]);
  const candidates = [minInstall._min.installedAt, minEvent._min.occurredAt].filter(
    (d): d is Date => d !== null,
  );
  if (candidates.length === 0) return null;
  const earliest = candidates.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
  return startOfUtcDay(earliest);
}

/** Days rewritten per tick — bounds a single invocation's work regardless of
 * how far behind `installSnapshotDirtyFrom` has fallen (e.g. a years-old
 * historical backfill event, or the very first run). Subsequent ticks pick
 * up where this one left off via the persisted dirty watermark. */
const SNAPSHOT_CHUNK_DAYS = 90;

/** Always kept dirty on every normal tick, even with no known corruption —
 * mirrors `writeTrailingDailySnapshots`' unconditional trailing rewrite,
 * self-healing against any late fact that landed without flipping
 * `installSnapshotDirtyFrom` (e.g. a future write path that forgets to). */
const SNAPSHOT_TRAILING_DAYS = 7;

const THROTTLE_MS = 60_000;

export interface InstallSnapshotableApp {
  id: string;
  installSnapshotSyncedAt: Date | null;
  installSnapshotFloorDate: Date | null;
  installSnapshotBackfillCompletedAt: Date | null;
  installSnapshotDirtyFrom: Date | null;
  lifecycleEventsBackfillCompletedAt: Date | null;
  lifecycleEventsSyncedAt: Date | null;
}

/**
 * One writer, one chunk per call — rewrites the oldest still-dirty days
 * (bounded by `SNAPSHOT_CHUNK_DAYS`), anchored on the last-known-good day's
 * `activeInstallsAtDayEnd` rather than recomputing from scratch. Advances
 * `installSnapshotDirtyFrom` as it goes and clears it once caught up to
 * `todayStart`. Never throws — a snapshot-write failure must not fail the
 * underlying lifecycle sync, since raw facts remain strictly more important
 * than this derived cache.
 *
 * Gate: only call this once `lifecycleEventsBackfillCompletedAt` is set and
 * there's no pending derivation for the app (caller's responsibility — see
 * `runCustomerEventsCron`).
 */
export async function runInstallSnapshotSync(
  app: InstallSnapshotableApp,
  today: Date,
): Promise<void> {
  if (!app.lifecycleEventsBackfillCompletedAt) return;

  const claimed = await claimRedisThrottle(
    `snapshot-throttle:install:${app.id}`,
    THROTTLE_MS,
  );
  if (!claimed) return;

  const startedAt = Date.now();
  try {
    const todayStart = startOfUtcDay(today);

    let floorDate = app.installSnapshotFloorDate;
    if (!floorDate) {
      floorDate = await computeInstallSnapshotFloorDate(app.id);
      if (!floorDate) return; // No installs/events yet — nothing to snapshot.
      await prisma.app.update({
        where: { id: app.id },
        data: { installSnapshotFloorDate: floorDate },
      });
    }

    const trailingFloor = addUtcDays(todayStart, -SNAPSHOT_TRAILING_DAYS);
    const wantedStart = app.installSnapshotDirtyFrom
      ? (app.installSnapshotDirtyFrom.getTime() < trailingFloor.getTime()
          ? app.installSnapshotDirtyFrom
          : trailingFloor)
      : app.installSnapshotSyncedAt
        ? trailingFloor
        : floorDate;
    const dirtyFrom = wantedStart.getTime() < floorDate.getTime() ? floorDate : wantedStart;
    if (dirtyFrom.getTime() >= todayStart.getTime()) return; // Nothing to do.

    const chunkEnd = addUtcDays(dirtyFrom, SNAPSHOT_CHUNK_DAYS);
    const rangeEnd = chunkEnd.getTime() < todayStart.getTime() ? chunkEnd : todayStart;

    let anchor = 0;
    if (dirtyFrom.getTime() > floorDate.getTime()) {
      const anchorDay = addUtcDays(dirtyFrom, -1);
      const anchorRow = await prisma.partnerDailyInstallSnapshot.findUnique({
        where: { appId_snapshotDate: { appId: app.id, snapshotDate: anchorDay } },
        select: { activeInstallsAtDayEnd: true },
      });
      if (anchorRow) {
        anchor = anchorRow.activeInstallsAtDayEnd;
      } else {
        log.warn("install snapshot: missing anchor row, resuming from 0", {
          appId: app.id,
          anchorDay: anchorDay.toISOString(),
        });
      }
    }

    const rows = await computeDirtyRangeSnapshotRows(
      app.id,
      dirtyFrom,
      rangeEnd,
      anchor,
      app.lifecycleEventsSyncedAt,
    );
    await writeInstallSnapshotRows(rows);

    const caughtUp = rangeEnd.getTime() >= todayStart.getTime();
    await prisma.app.update({
      where: { id: app.id },
      data: {
        installSnapshotSyncedAt: addUtcDays(rangeEnd, -1),
        installSnapshotDirtyFrom: caughtUp ? null : rangeEnd,
        installSnapshotBackfillCompletedAt:
          caughtUp && !app.installSnapshotBackfillCompletedAt ? today : undefined,
      },
    });

    log.info("wrote install daily snapshots", {
      appId: app.id,
      days: rows.length,
      caughtUp,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    log.warn("install snapshot write failed", {
      appId: app.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
