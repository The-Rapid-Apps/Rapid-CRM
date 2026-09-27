/**
 * Re-reads recent GA4 days into the local `TrafficEventFact` mirror, repairing
 * days the sync's old 2-hour re-read window skipped past while they were still
 * incomplete.
 *
 * `npm run repair:traffic-mirror` (DAYS=45 to change the span, APP="My App"
 * to limit it to one app).
 *
 * WHY THIS EXISTS. GA4's daily `events_YYYYMMDD` table does not exist while the
 * day is current — the day is served by `events_intraday_YYYYMMDD`, which is
 * partial and is REPLACED by the finalized table about two days later. The
 * recent lane used to re-read only the last 2 hours, so it saw each day exactly
 * once, while it was still intraday, and never returned. Every day kept
 * whatever partial count it had at that instant.
 *
 * `TRAFFIC_EVENT_REREAD_MS` is now 4 days, which stops this happening again —
 * but it cannot fix a day that is already older than that. Hence a one-off pass
 * over however far back the damage goes.
 *
 * SAFE TO RUN REPEATEDLY. Each day is REPLACED with what GA4 currently
 * reports for it, not merged into, so running twice leaves exactly the same
 * rows as running once. That is also why replacing matters rather than
 * inserting: GA4 re-timestamps `shopify_app_install` when a day finalizes, so
 * an insert-only re-read stores the intraday copy AND the finalized copy of
 * every install — which is what an earlier version of this script did, roughly
 * doubling installs on every day it touched. See `resyncTrafficEventWindow`.
 *
 * A day whose BigQuery read comes back empty is left alone rather than
 * emptied, so a transient upstream failure cannot blank history.
 *
 * It does not touch `trafficEventsSyncedAt`, so it cannot disturb the sync's
 * own position or its lease — the recent lane carries on exactly where it was.
 *
 * The report's live BigQuery path is unaffected by any of this; only the local
 * mirror behind `TRAFFIC_LOCAL_READ_PATH_ENABLED` reads these rows.
 */
import { prisma } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";
import { resyncTrafficEventWindow } from "../app/lib/reports/traffic-events-sync.server";

const DAYS = Number(process.env.DAYS ?? "45");
const ONLY_APP = process.env.APP?.trim();
const DAY_MS = 86_400_000;

if (!Number.isFinite(DAYS) || DAYS <= 0) {
  throw new Error(`DAYS must be a positive number, got "${process.env.DAYS}"`);
}

const apps = await prisma.app.findMany({
  where: {
    bigqueryDataset: { not: null },
    ...(ONLY_APP ? { name: ONLY_APP } : {}),
  },
  orderBy: { name: "asc" },
  select: {
    id: true,
    name: true,
    bigqueryDataset: true,
    gcpProjectId: true,
    trafficEventsSyncedAt: true,
    trafficEventsBackfillCursor: true,
    trafficEventsBackfillCompletedAt: true,
    trafficEventsSyncLeaseToken: true,
    trafficEventsSyncLeaseExpiresAt: true,
  },
});

if (apps.length === 0) {
  console.log(
    ONLY_APP
      ? `No app named "${ONLY_APP}" with a BigQuery dataset configured.`
      : "No app has a BigQuery dataset configured — nothing to repair.",
  );
  await prisma.$disconnect();
  process.exit(0);
}

const now = new Date();
const end = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
);
const start = new Date(end.getTime() - DAYS * DAY_MS);
console.log(
  `Repairing ${DAYS} days (${start.toISOString().slice(0, 10)} .. ${end
    .toISOString()
    .slice(0, 10)}) for ${apps.length} app(s)\n`,
);

/* One day at a time rather than one wide window. A single 45-day query would
   work, but a failure partway through would lose every day's progress, and a
   per-day figure is what actually shows where the damage was. Day-aligned to
   UTC midnight so each pass replaces whole days — a window offset by the time
   of day would leave two half-days per boundary, which still replaces
   correctly but makes the output much harder to read against GA4. */
for (const app of apps) {
  const projectId = app.gcpProjectId ?? env.GCP_PROJECT_ID ?? null;
  if (!projectId) {
    console.log(`${app.name}: no GCP project resolved — skipped`);
    continue;
  }
  console.log(`${app.name} (${projectId}.${app.bigqueryDataset})`);

  const before = await prisma.trafficEventFact.count({
    where: { appId: app.id, eventTimestamp: { gte: start, lt: end } },
  });

  let daysChanged = 0;
  for (let dayStart = start.getTime(); dayStart < end.getTime(); dayStart += DAY_MS) {
    const from = new Date(dayStart);
    const to = new Date(dayStart + DAY_MS);
    const wasStored = await prisma.trafficEventFact.count({
      where: { appId: app.id, eventTimestamp: { gte: from, lt: to } },
    });
    const nowStored = await resyncTrafficEventWindow(app, projectId, from, to);
    if (nowStored !== wasStored) {
      daysChanged += 1;
      const delta = nowStored - wasStored;
      console.log(
        `  ${from.toISOString().slice(0, 10)}  ${wasStored} -> ${nowStored}` +
          ` (${delta > 0 ? "+" : ""}${delta})`,
      );
    }
  }

  const after = await prisma.trafficEventFact.count({
    where: { appId: app.id, eventTimestamp: { gte: start, lt: end } },
  });
  const delta = after - before;
  console.log(
    `  ${before} -> ${after} rows (${delta > 0 ? "+" : ""}${delta} net across` +
      ` ${daysChanged} corrected day(s))\n`,
  );
}

console.log(
  "Done. Re-run the parity check against live BigQuery before enabling" +
    " TRAFFIC_LOCAL_READ_PATH_ENABLED for an app.",
);
await prisma.$disconnect();
process.exit(0);
