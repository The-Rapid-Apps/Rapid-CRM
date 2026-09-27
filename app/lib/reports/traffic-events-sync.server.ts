import { createHash, randomUUID } from "node:crypto";
import type { App } from "../../../generated/prisma/client";
import { prisma } from "../db.server";
import { logger } from "../logger.server";
import { env } from "../env.server";
import {
  getClient,
  parseEventDate,
  TABLE_SUFFIX_IN_RANGE,
  tableSuffix,
} from "./traffic-sources.server";

const log = logger.scope("traffic-events-sync");

/**
 * Local mirror of the 3 GA4 event names the Traffic report actually reads
 * (see traffic-sources.server.ts's GA4_EVENT_BY_FUNNEL). Everything else in
 * GA4's raw export is irrelevant here and is never queried.
 */
const TRACKED_EVENT_NAMES = ["view_item", "shopify_app_install", "installs"];

const DAY_MS = 86_400_000;
/**
 * How far back the recent lane re-reads on every tick.
 *
 * This was 2 hours — Mantle's own documented figure for this sync — and that
 * quietly made the mirror permanently incomplete. GA4's daily
 * `events_YYYYMMDD` table does not exist while the day is current: the day is
 * served by `events_intraday_YYYYMMDD`, which is partial and gets REPLACED
 * (not appended to) by the finalized table roughly two days later. A 2-hour
 * window therefore read each day exactly once, while it was still intraday,
 * advanced past it, and never came back — so every day kept whatever partial
 * count it happened to have at that moment.
 *
 * Measured on Rapi Bundle 2026-09-11, before this change: the 61 days covered
 * by the one-time backfill (which reads finalized tables) matched live
 * BigQuery to -0.4%, while the newest 30 days — everything the recent lane has
 * owned — were short by a uniform 19%: -22.3% over the last 7 days, -21.5%
 * over 14, -20.5% over 21. That is what failed
 * `TRAFFIC_LOCAL_READ_PATH_ENABLED`'s documented parity check.
 *
 * Four days is Google's ~2-day finalization lag plus two days of slack. The
 * re-reading is free at both ends: `TrafficEventFact.dedupeKey` is unique and
 * the write uses `skipDuplicates`, so a day already stored costs nothing to
 * see again; and the scan is under BigQuery's 10 MB per-job minimum billing at
 * every window size measured (3.4 MB for 4 days, 5.9 MB for 7), so this bills
 * exactly what the 2-hour window billed.
 *
 * Widening this does NOT repair days the old window already skipped past —
 * those stay partial until re-read explicitly. See
 * `npm run repair:traffic-mirror`.
 */
const TRAFFIC_EVENT_REREAD_MS = 4 * DAY_MS;
/** Chunk size for the one-time historical backfill, matching
 * SNAPSHOT_BACKFILL_CHUNK_DAYS's precedent in partner-mrr-snapshot.server.ts. */
const BACKFILL_CHUNK_DAYS = 90;
/** Own lease duration — mirrors BILLING_SYNC_LEASE_MS's reasoning (production
 * cron callers allow ~20 minutes; keep the lease longer, renew on every write). */
const TRAFFIC_SYNC_LEASE_MS = 25 * 60_000;
export const TRAFFIC_SYNC_FRESHNESS_MS = 5 * 60_000;

export interface SyncableTrafficApp {
  id: string;
  name: string;
  bigqueryDataset: string | null;
  gcpProjectId: string | null;
  trafficEventsSyncedAt: Date | null;
  trafficEventsBackfillCursor: Date | null;
  trafficEventsBackfillCompletedAt: Date | null;
  trafficEventsSyncLeaseToken: string | null;
  trafficEventsSyncLeaseExpiresAt: Date | null;
}

interface RawTrafficRow {
  event_name: string;
  event_date: string;
  event_timestamp: string | number;
  user_pseudo_id: string | null;
  shop_url: string | null;
  page_location: string | null;
  page_referrer: string | null;
  campaign: string | null;
  traffic_source_name: string | null;
  traffic_source_medium: string | null;
  traffic_source_source: string | null;
  language: string | null;
  country: string | null;
}

function dedupeKey(params: {
  appId: string;
  eventName: string;
  userPseudoId: string;
  eventTimestamp: string;
}): string {
  return createHash("sha256")
    .update(
      [params.appId, params.eventName, params.userPseudoId, params.eventTimestamp].join(
        "",
      ),
    )
    .digest("hex");
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/**
 * Advances sync metadata only while this worker still owns the lease —
 * mirrors updateAppWithinBillingLease's exact reasoning/shape in
 * partner-subscription-sync.server.ts, against its own lease pair since GA4/
 * BigQuery is independent infrastructure from Shopify's Partner API.
 */
async function updateAppWithinTrafficSyncLease(
  appId: string,
  leaseToken: string,
  data: Parameters<typeof prisma.app.updateMany>[0]["data"],
): Promise<void> {
  const now = new Date();
  const updated = await prisma.app.updateMany({
    where: {
      id: appId,
      trafficEventsSyncLeaseToken: leaseToken,
      trafficEventsSyncLeaseExpiresAt: { gt: now },
    },
    data: {
      ...data,
      trafficEventsSyncLeaseExpiresAt: new Date(now.getTime() + TRAFFIC_SYNC_LEASE_MS),
    },
  });
  if (updated.count !== 1) {
    throw new Error("Traffic events sync lease was lost; progress was not changed.");
  }
}

function resolveProjectId(app: SyncableTrafficApp): string | null {
  return app.gcpProjectId ?? env.GCP_PROJECT_ID ?? null;
}

const SELECT_LIST = `
  event_name,
  event_date,
  event_timestamp,
  user_pseudo_id,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = "shop_url") AS shop_url,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = "page_location") AS page_location,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = "page_referrer") AS page_referrer,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = "campaign") AS campaign,
  traffic_source.name AS traffic_source_name,
  traffic_source.medium AS traffic_source_medium,
  traffic_source.source AS traffic_source_source,
  device.language AS language,
  geo.country AS country
`;

/**
 * REPLACES one [start, end) window of the local mirror with what GA4 currently
 * reports for it, and returns the number of rows now stored for that window.
 *
 * Replace, not merge, and that distinction is the whole correctness of
 * re-reading. `dedupeKey` is a hash of (app, event name, user, timestamp), so
 * it can only collapse two reads of an event if GA4 reports the same timestamp
 * both times. It does not: `shopify_app_install` is re-timestamped when the
 * day is finalized, so the intraday copy and the finalized copy hash
 * differently and an insert-only write keeps BOTH. Measured on Rapi Bundle
 * 2026-09-11: 2026-08-18 held 224 install rows — 104 written live while the
 * day was intraday, 120 written by a later re-read — against a true 120. Every
 * re-read day was inflated to almost exactly double, while `view_item` (a
 * client-side event, whose timestamp is stable) was unaffected.
 *
 * That was survivable only while the recent lane never revisited a day. Now
 * that it re-reads four days on every tick, an insert-only write would
 * re-duplicate installs every few minutes forever. So the window is deleted
 * and rewritten in one transaction, which is idempotent no matter how GA4
 * re-timestamps anything. `dedupeKey`'s uniqueness stays as the guard against
 * duplicates WITHIN a single read.
 *
 * Bounded by the exact instants queried, never by whole days, so a window that
 * starts mid-day cannot delete rows outside what it is about to replace.
 *
 * Exported so the repair pass re-reads through the identical query, projection
 * and write path as the live sync.
 */
export async function resyncTrafficEventWindow(
  app: SyncableTrafficApp,
  projectId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const bigquery = getClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT ${SELECT_LIST}
      FROM \`${projectId}.${app.bigqueryDataset}.events_*\`
      WHERE ${TABLE_SUFFIX_IN_RANGE}
        AND event_name IN UNNEST(@eventNames)
        AND TIMESTAMP_MICROS(event_timestamp) >= @preciseStart
        AND TIMESTAMP_MICROS(event_timestamp) < @preciseEnd
    `,
    params: {
      /* One day of slack on each side, and it is load-bearing now that this
         function DELETES the window before rewriting it.

         GA4 names each daily table for the PROPERTY's local date, while this
         window is a UTC instant range, so an event's table and its UTC day
         disagree whenever the property is not on UTC. Measured on Rapi Bundle
         2026-09-11: of the events timestamped on UTC day 2026-07-29, 378 sit
         in `events_20260729` and 50 sit in `events_20260728`. A suffix range
         of exactly [20260729, 20260730] skips that second table — so the
         delete removed those 50 rows and the read never brought them back,
         losing ~40 rows a day across every day the repair touched.

         `_TABLE_SUFFIX` is only a partition-pruning hint here; the
         `TIMESTAMP_MICROS` bounds below are what actually decide which rows
         come back. Widening it can therefore only add tables to scan, never
         rows to the result. */
      start: tableSuffix(new Date(windowStart.getTime() - DAY_MS)),
      end: tableSuffix(new Date(windowEnd.getTime() + DAY_MS)),
      eventNames: TRACKED_EVENT_NAMES,
      preciseStart: windowStart,
      preciseEnd: windowEnd,
    },
    types: { eventNames: ["STRING"] },
  });

  const typedRows = rows as RawTrafficRow[];

  const existing = await prisma.trafficEventFact.count({
    where: {
      appId: app.id,
      eventName: { in: TRACKED_EVENT_NAMES },
      eventTimestamp: { gte: windowStart, lt: windowEnd },
    },
  });

  /* An empty result for a window we already hold data for is not a real
     emptiness — a window that had events does not lose them. Treat it as a
     transient upstream problem and leave what is stored alone, rather than
     letting one odd read blank a day. (A genuinely empty window that is also
     empty locally is the common case on a quiet app and falls straight
     through.) */
  if (typedRows.length === 0) {
    if (existing > 0) {
      log.warn("traffic window came back empty but local data exists — kept", {
        appId: app.id,
        app: app.name,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        existing,
      });
    }
    return existing;
  }

  const data = typedRows
    .filter((row) => row.user_pseudo_id)
    .map((row) => {
      const userPseudoId = String(row.user_pseudo_id);
      const eventTimestampIso = new Date(Number(row.event_timestamp) / 1000).toISOString();
      return {
        appId: app.id,
        dedupeKey: dedupeKey({
          appId: app.id,
          eventName: row.event_name,
          userPseudoId,
          eventTimestamp: eventTimestampIso,
        }),
        eventName: row.event_name,
        eventDate: parseEventDate(row.event_date),
        eventTimestamp: new Date(eventTimestampIso),
        userPseudoId,
        shopUrl: row.shop_url,
        pageLocation: row.page_location,
        pageReferrer: row.page_referrer,
        campaign: row.campaign,
        trafficSourceName: row.traffic_source_name,
        trafficSourceMedium: row.traffic_source_medium,
        trafficSourceSource: row.traffic_source_source,
        language: row.language,
        country: row.country,
      };
    });

  const [, inserted] = await prisma.$transaction([
    prisma.trafficEventFact.deleteMany({
      where: {
        appId: app.id,
        eventName: { in: TRACKED_EVENT_NAMES },
        eventTimestamp: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.trafficEventFact.createMany({ data, skipDuplicates: true }),
  ]);
  return inserted.count;
}

/**
 * Recent lane: one BigQuery query per tick over a rolling overlap window,
 * mirroring syncLatestEventPages's freshness short-circuit and immutable-
 * window shape (no Relay-style pagination needed — a date-bounded SQL query
 * returns its whole result in one round-trip, unlike the Partner API).
 */
export async function syncRecentTrafficEvents(
  app: SyncableTrafficApp,
  leaseToken: string,
  fetchStartedAt: Date,
): Promise<{ inserted: number; fresh: boolean }> {
  const projectId = resolveProjectId(app);
  if (!app.bigqueryDataset || !projectId) return { inserted: 0, fresh: false };

  if (
    app.trafficEventsSyncedAt &&
    app.trafficEventsSyncedAt.getTime() >=
      fetchStartedAt.getTime() - TRAFFIC_SYNC_FRESHNESS_MS
  ) {
    return { inserted: 0, fresh: true };
  }

  const windowStart = new Date(
    (app.trafficEventsSyncedAt?.getTime() ?? fetchStartedAt.getTime()) -
      TRAFFIC_EVENT_REREAD_MS,
  );
  const inserted = await resyncTrafficEventWindow(
    app,
    projectId,
    windowStart,
    fetchStartedAt,
  );
  // Unlike a dirty-watermark (which must NEVER advance on a no-op tick — see
  // the fix just shipped for persistEventEdges/persistSaleEdges in
  // partner-subscription-sync.server.ts), this is a plain high-water mark
  // meaning "checked up to here," matching billingEventsSyncedAt's own
  // semantics exactly: it advances every tick regardless of insert count,
  // since the window was genuinely covered either way (0 new facts is a
  // valid, common outcome, not a failure to record).
  await updateAppWithinTrafficSyncLease(app.id, leaseToken, {
    trafficEventsSyncedAt: fetchStartedAt,
  });
  return { inserted, fresh: true };
}

/**
 * Backfill lane: walks backward from trafficEventsBackfillCursor (or now, on
 * first run) BACKFILL_CHUNK_DAYS at a time, oldest-first within each chunk.
 * Stops (marks complete) once a chunk at the very start of the property's
 * history returns nothing — GA4 properties have a real creation date, no
 * need to guess a fixed depth.
 */
export async function backfillTrafficEvents(
  app: SyncableTrafficApp,
  leaseToken: string,
  now: Date,
): Promise<{ inserted: number; days: number; completed: boolean }> {
  if (app.trafficEventsBackfillCompletedAt) return { inserted: 0, days: 0, completed: true };
  const projectId = resolveProjectId(app);
  if (!app.bigqueryDataset || !projectId) return { inserted: 0, days: 0, completed: false };

  const cursor = app.trafficEventsBackfillCursor
    ? startOfUtcDay(app.trafficEventsBackfillCursor)
    : startOfUtcDay(now);
  const chunkStart = new Date(cursor.getTime() - BACKFILL_CHUNK_DAYS * DAY_MS);

  const inserted = await resyncTrafficEventWindow(app, projectId, chunkStart, cursor);
  const days = BACKFILL_CHUNK_DAYS;

  // An empty chunk means we've walked past the property's earliest data —
  // done. A non-empty chunk always advances the cursor and tries again next
  // tick, even if this chunk turns out to also be the last one with data
  // (the following tick's empty chunk is what actually marks completion).
  if (inserted === 0) {
    await updateAppWithinTrafficSyncLease(app.id, leaseToken, {
      trafficEventsBackfillCursor: chunkStart,
      trafficEventsBackfillCompletedAt: now,
    });
    log.info("traffic events backfill completed", { appId: app.id, floor: chunkStart.toISOString() });
    return { inserted, days, completed: true };
  }

  await updateAppWithinTrafficSyncLease(app.id, leaseToken, {
    trafficEventsBackfillCursor: chunkStart,
  });
  return { inserted, days, completed: false };
}

async function syncTrafficEventsUnlocked(
  app: SyncableTrafficApp,
  leaseToken: string,
  fetchStartedAt: Date,
  options: { backfill?: boolean } = {},
): Promise<{ inserted: number; backfillInserted: number; fresh: boolean }> {
  const recent = await syncRecentTrafficEvents(app, leaseToken, fetchStartedAt);
  const runBackfill = options.backfill !== false;
  const backfill = runBackfill
    ? await backfillTrafficEvents(app, leaseToken, fetchStartedAt)
    : { inserted: 0, days: 0, completed: Boolean(app.trafficEventsBackfillCompletedAt) };

  log.info("traffic events sync chunk completed", {
    appId: app.id,
    appName: app.name,
    inserted: recent.inserted,
    fresh: recent.fresh,
    backfillInserted: backfill.inserted,
    backfillCompleted: backfill.completed,
  });
  return { inserted: recent.inserted, backfillInserted: backfill.inserted, fresh: recent.fresh };
}

/**
 * Uses a database lease so concurrent triggers (cron + interactive + multi-
 * worker) return quickly instead of racing the same cursors — same shape as
 * syncPartnerSubscriptionFactsWithLease, against the dedicated
 * trafficEventsSyncLease* pair.
 */
async function syncTrafficEventsWithLease(
  app: SyncableTrafficApp,
  options: { backfill?: boolean } = {},
): Promise<{ inserted: number; backfillInserted: number; fresh: boolean; inProgress?: boolean }> {
  const requestedAt = new Date();
  const leaseToken = randomUUID();
  const acquired = await prisma.app.updateMany({
    where: {
      id: app.id,
      OR: [
        { trafficEventsSyncLeaseExpiresAt: null },
        { trafficEventsSyncLeaseExpiresAt: { lt: requestedAt } },
      ],
    },
    data: {
      trafficEventsSyncLeaseToken: leaseToken,
      trafficEventsSyncLeaseExpiresAt: new Date(
        requestedAt.getTime() + TRAFFIC_SYNC_LEASE_MS,
      ),
    },
  });
  if (acquired.count === 0) {
    return { inserted: 0, backfillInserted: 0, fresh: false, inProgress: true };
  }

  try {
    const freshApp = await prisma.app.findFirst({
      where: { id: app.id, trafficEventsSyncLeaseToken: leaseToken },
    });
    if (!freshApp) return { inserted: 0, backfillInserted: 0, fresh: false, inProgress: true };
    return await syncTrafficEventsUnlocked(freshApp, leaseToken, requestedAt, options);
  } finally {
    await prisma.app.updateMany({
      where: { id: app.id, trafficEventsSyncLeaseToken: leaseToken },
      data: { trafficEventsSyncLeaseToken: null, trafficEventsSyncLeaseExpiresAt: null },
    });
  }
}

const TRAFFIC_SYNC_APP_SELECT = {
  id: true,
  name: true,
  bigqueryDataset: true,
  gcpProjectId: true,
  trafficEventsSyncedAt: true,
  trafficEventsBackfillCursor: true,
  trafficEventsBackfillCompletedAt: true,
  trafficEventsSyncLeaseToken: true,
  trafficEventsSyncLeaseExpiresAt: true,
} as const;

async function syncTrafficEventsForApps(
  apps: SyncableTrafficApp[],
  backfill: boolean | undefined,
): Promise<{
  appsProcessed: number;
  eventsInserted: number;
  errors: Array<{ appId: string; appName: string; message: string }>;
}> {
  let eventsInserted = 0;
  const errors: Array<{ appId: string; appName: string; message: string }> = [];

  // Sequential, same reasoning as the Partner sync: parallel BigQuery
  // backfills across apps would just contend for the same quota/connection
  // pool for no benefit — each app's own backfill is already chunked.
  for (const app of apps) {
    try {
      const result = await syncTrafficEventsWithLease(app, { backfill });
      eventsInserted += result.inserted + result.backfillInserted;
    } catch (error) {
      errors.push({
        appId: app.id,
        appName: app.name,
        message: error instanceof Error ? error.message : "Traffic events sync failed.",
      });
    }
  }

  return { appsProcessed: apps.length, eventsInserted, errors };
}

/**
 * Entrypoint for an organization's whole app set — mirrors
 * syncOrganizationPartnerSubscriptionFacts's shape. Only apps with a
 * configured bigqueryDataset are synced; everything else is skipped
 * silently, matching how GA4 config is already optional per-app.
 */
export async function syncOrganizationTrafficEvents(params: {
  organizationId: string;
  appId?: string;
  backfill?: boolean;
}): Promise<{
  appsProcessed: number;
  eventsInserted: number;
  errors: Array<{ appId: string; appName: string; message: string }>;
}> {
  const apps = await prisma.app.findMany({
    where: {
      organizationId: params.organizationId,
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
      bigqueryDataset: { not: null },
      ...(params.appId ? { id: params.appId } : {}),
    },
    select: TRAFFIC_SYNC_APP_SELECT,
  });
  return syncTrafficEventsForApps(apps, params.backfill);
}

/**
 * Cron backstop entrypoint — mirrors runCustomerEventsCron's shape (queries
 * every enabled app directly, no organization scoping, matching this
 * platform's current single-tenant-admin reality). Unlike the interactive
 * `/api/metrics-sync` trigger, this runs WITH backfill enabled — it's the
 * only place the one-time historical backfill actually advances.
 */
export async function runTrafficEventsCron(): Promise<{
  appsProcessed: number;
  eventsInserted: number;
  errors: Array<{ appId: string; appName: string; message: string }>;
}> {
  const apps = await prisma.app.findMany({
    where: {
      enabled: true,
      removed: false,
      scheduledForDeletionAt: null,
      bigqueryDataset: { not: null },
    },
    select: TRAFFIC_SYNC_APP_SELECT,
  });
  return syncTrafficEventsForApps(apps, true);
}
