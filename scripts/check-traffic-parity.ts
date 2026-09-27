/**
 * Compares the local `TrafficEventFact` mirror against live BigQuery, day by
 * day, for every tracked event and every configured app.
 *
 * `npm run check:traffic-parity` (DAYS=90 to change the span, APP="My App"
 * to limit it to one app).
 *
 * READ-ONLY and safe to run against production: it issues one BigQuery count
 * query and one MySQL count query per app/event and writes nothing.
 *
 * WHY THIS EXISTS. `TRAFFIC_LOCAL_READ_PATH_ENABLED`'s own documentation says
 * to flip it on "only after an app's backfill completes and the production-data
 * parity check passes for that app" — this is that check, which until now was
 * something improvised by hand each time. It is worth having as a command
 * because the failure it catches is invisible: a mirror that is quietly short
 * serves plausible numbers, never an error. On 2026-09-11 it was short by 19%
 * on the newest 30 days and nothing anywhere reported a problem.
 *
 * Exits non-zero when parity fails, so it can gate a deploy or a cron.
 *
 * TOLERANCES. A tiny drift is expected and is not a failure: the two sides are
 * counted seconds apart, so events arriving in between land on one and not the
 * other. A REAL gap does not look like that — it is one-directional and
 * concentrated in recent days. Hence both a total-percentage bound and a
 * worst-single-day bound; a systematic shortfall trips the second long before
 * the first, because it is always many events on one day rather than one event
 * on many days.
 */
import { prisma } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";
import { getClient } from "../app/lib/reports/traffic-sources.server";

/** Mirrors TRACKED_EVENT_NAMES in traffic-events-sync.server.ts — the only
 * three GA4 events the mirror stores, so the only three worth comparing. */
const TRACKED = ["view_item", "shopify_app_install", "installs"];
const MAX_TOTAL_DRIFT_PCT = 0.5;
const MAX_DAY_DRIFT = 2;

const DAYS = Number(process.env.DAYS ?? "90");
const ONLY_APP = process.env.APP?.trim();
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  throw new Error(`DAYS must be a positive number, got "${process.env.DAYS}"`);
}

const apps = await prisma.app.findMany({
  where: { bigqueryDataset: { not: null }, ...(ONLY_APP ? { name: ONLY_APP } : {}) },
  orderBy: { name: "asc" },
  select: {
    id: true,
    name: true,
    bigqueryDataset: true,
    gcpProjectId: true,
    trafficEventsBackfillCompletedAt: true,
    trafficEventsSyncedAt: true,
  },
});

if (apps.length === 0) {
  console.log(
    ONLY_APP
      ? `No app named "${ONLY_APP}" has a BigQuery dataset configured.`
      : "No app has a BigQuery dataset configured — nothing to compare.",
  );
  await prisma.$disconnect();
  process.exit(0);
}

const start = new Date(Date.now() - DAYS * 86_400_000);
console.log(
  `Comparing mirror vs BigQuery over ${DAYS} days, from ${start
    .toISOString()
    .slice(0, 10)}\n` +
    `Tolerances: total within ${MAX_TOTAL_DRIFT_PCT}%, no single day off by more than ${MAX_DAY_DRIFT}.\n`,
);
console.log(`read path currently: ${env.TRAFFIC_LOCAL_READ_PATH_ENABLED ? "LOCAL MIRROR (flag on)" : "live BigQuery (flag off)"}\n`);

let failed = false;

for (const app of apps) {
  const projectId = app.gcpProjectId ?? env.GCP_PROJECT_ID ?? null;
  if (!projectId) {
    console.log(`${app.name}: no GCP project resolved — skipped`);
    continue;
  }
  const syncAgeMin = app.trafficEventsSyncedAt
    ? (Date.now() - app.trafficEventsSyncedAt.getTime()) / 60_000
    : Infinity;
  console.log(
    `${app.name}  (backfill ${app.trafficEventsBackfillCompletedAt ? "done" : "NOT DONE"},` +
      ` last sync ${Number.isFinite(syncAgeMin) ? `${syncAgeMin.toFixed(0)}min ago` : "never"})`,
  );

  for (const eventName of TRACKED) {
    /* Both sides are bucketed by the SAME clock — the event's UTC instant.
       Grouping BigQuery by its own `event_date` instead would compare against
       the GA4 property's local calendar, shifting events across midnight and
       manufacturing a per-day difference that is purely a timezone artifact. */
    const [bqRows] = await getClient().query({
      query: `
        SELECT FORMAT_TIMESTAMP('%Y%m%d', TIMESTAMP_MICROS(event_timestamp)) AS d,
               COUNT(*) AS n
        FROM \`${projectId}.${app.bigqueryDataset}.events_*\`
        WHERE event_name = @eventName
          AND TIMESTAMP_MICROS(event_timestamp) >= @start
        GROUP BY d
      `,
      params: { eventName, start },
    });
    const bq = new Map<string, number>();
    for (const row of bqRows as Array<{ d: string; n: number | bigint }>) {
      bq.set(String(row.d), Number(row.n));
    }

    const localRows = await prisma.$queryRawUnsafe<Array<{ d: string; n: bigint }>>(
      `SELECT DATE_FORMAT(eventTimestamp, '%Y%m%d') d, COUNT(*) n
         FROM traffic_event_facts
        WHERE appId = ? AND eventName = ? AND eventTimestamp >= ?
        GROUP BY d`,
      app.id,
      eventName,
      start,
    );
    const local = new Map<string, number>();
    for (const row of localRows) local.set(row.d, Number(row.n));

    const days = [...new Set([...bq.keys(), ...local.keys()])].sort();
    let bqTotal = 0;
    let localTotal = 0;
    let exact = 0;
    let worstDay = "";
    let worstDrift = 0;
    for (const day of days) {
      const b = bq.get(day) ?? 0;
      const l = local.get(day) ?? 0;
      bqTotal += b;
      localTotal += l;
      if (b === l) exact += 1;
      if (Math.abs(l - b) > Math.abs(worstDrift)) {
        worstDrift = l - b;
        worstDay = day;
      }
    }

    const pct = bqTotal > 0 ? ((localTotal - bqTotal) / bqTotal) * 100 : 0;
    const ok =
      Math.abs(pct) <= MAX_TOTAL_DRIFT_PCT && Math.abs(worstDrift) <= MAX_DAY_DRIFT;
    if (!ok) failed = true;

    console.log(
      `  ${eventName.padEnd(21)} bq=${String(bqTotal).padStart(7)}` +
        ` local=${String(localTotal).padStart(7)}` +
        ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)` +
        `  ${exact}/${days.length} days exact` +
        (worstDrift !== 0 ? `, worst ${worstDay} ${worstDrift > 0 ? "+" : ""}${worstDrift}` : "") +
        `  ${ok ? "PASS" : "FAIL"}`,
    );
  }
  console.log("");
}

if (failed) {
  console.log(
    "PARITY FAILS — do NOT serve this app from the mirror.\n" +
      "Run `npm run repair:traffic-mirror` (widen DAYS to cover the affected span)," +
      " then re-check. If it still fails, the gap is not staleness and needs" +
      " investigating before TRAFFIC_LOCAL_READ_PATH_ENABLED is trusted.",
  );
} else {
  console.log("PARITY PASSES — the mirror matches BigQuery for every app and event.");
}

await prisma.$disconnect();
process.exit(failed ? 1 : 0);
