/**
 * Why has the Traffic Source report stopped returning data?
 *
 * `npm run diagnose:traffic` (read-only — runs SELECTs and metadata reads).
 *
 * `computeTrafficSourcesReport` wraps everything in one try/catch and hands
 * back `{ available: false, error }`, so the real cause is captured but only
 * ever seen as a banner. Worse, several very different faults present
 * identically as "no data":
 *
 *   1. credentials  — the ADC key file is gone, or its key was disabled in GCP
 *   2. IAM          — the service account lost BigQuery Data Viewer / Job User
 *   3. export       — GA4 stopped writing `events_YYYYMMDD` into the dataset
 *   4. config       — `App.bigqueryDataset` / `gcpProjectId` is unset or wrong
 *   5. freshness    — the export runs but is lagging, so recent ranges are empty
 *
 * Only 1 and 2 are "a token expired". 3 is the common one and needs a fix in
 * GA4, not here — so the point of this script is to say WHICH before anyone
 * starts rotating keys.
 *
 * Each app is checked independently: apps can live in different GCP projects,
 * so one app breaking tells you nothing about the others.
 */
import { existsSync, statSync } from "node:fs";
import { BigQuery } from "@google-cloud/bigquery";
import { prisma } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";

const DAY_MS = 86_400_000;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => console.log(`  FAIL  ${m}`);
const info = (m: string) => console.log(`        ${m}`);

console.log("=== 1. Application Default Credentials ===");
const keyPath = env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  info(
    "GOOGLE_APPLICATION_CREDENTIALS is not set. That is only OK if this host " +
      "has a GCP metadata server (a GCE/Cloud Run instance). On a plain VPS it " +
      "means every BigQuery call is unauthenticated.",
  );
} else if (!existsSync(keyPath)) {
  bad(`GOOGLE_APPLICATION_CREDENTIALS points at ${keyPath}, which does not exist`);
  info("This alone breaks every app. Restore the key file, or re-point the var.");
} else {
  const stat = statSync(keyPath);
  ok(`key file present (${stat.size} bytes, modified ${stat.mtime.toISOString()})`);
  info(
    "Presence is not validity: a key that was DISABLED or DELETED in GCP still " +
      "sits on disk and still parses. Step 3 below is what actually proves it works.",
  );
}
console.log(`        default GCP_PROJECT_ID: ${env.GCP_PROJECT_ID ?? "(unset)"}`);

console.log("\n=== 2. Per-app report configuration ===");
const apps = await prisma.app.findMany({
  select: {
    id: true,
    name: true,
    ga4PropertyId: true,
    bigqueryDataset: true,
    gcpProjectId: true,
    trafficEventsSyncedAt: true,
  },
  orderBy: { name: "asc" },
});

const configured = apps.filter((app) => app.bigqueryDataset);
for (const app of apps) {
  const project = app.gcpProjectId ?? env.GCP_PROJECT_ID ?? null;
  if (!app.bigqueryDataset) {
    info(`${app.name.padEnd(22)} no bigqueryDataset — report is off for this app`);
    continue;
  }
  ok(
    `${app.name.padEnd(22)} dataset=${app.bigqueryDataset} project=${project ?? "(none!)"}` +
      ` ga4Property=${app.ga4PropertyId ?? "(unset)"}`,
  );
  if (!project) {
    bad(
      `${app.name}: no gcpProjectId and no GCP_PROJECT_ID default — nothing to query`,
    );
  }
}
if (configured.length === 0) {
  console.log("\nNo app has a dataset configured; nothing further to check.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("\n=== 3. Live BigQuery check, per app ===");
console.log("(this is the step that distinguishes auth from export)\n");

for (const app of configured) {
  const projectId = app.gcpProjectId ?? env.GCP_PROJECT_ID ?? undefined;
  console.log(`--- ${app.name} (${projectId}/${app.bigqueryDataset})`);
  const bigquery = new BigQuery({ projectId });

  // 3a. Can we authenticate and list the dataset's tables at all? This fails
  // on a bad key (401/invalid_grant) or missing IAM (403), and those two read
  // very differently — so the raw message matters more than any summary.
  let tables: string[] = [];
  try {
    const [list] = await bigquery
      .dataset(app.bigqueryDataset!, { projectId })
      .getTables({ maxResults: 500 });
    tables = list.map((table) => table.id ?? "").filter(Boolean);
    ok(`dataset readable, ${tables.length} tables visible`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bad(`cannot read dataset: ${message}`);
    if (/invalid_grant|invalid grant|Invalid JWT|account not found|disabled/i.test(message)) {
      info("-> CREDENTIALS. The service-account key is disabled, deleted, or its clock/JWT is invalid. Rotate the key.");
    } else if (/Permission|403|Access Denied|denied/i.test(message)) {
      info("-> IAM. The key works but this service account lacks access to THIS project.");
      info("   Grant it BigQuery Data Viewer + BigQuery Job User on " + projectId);
    } else if (/Not found|404/i.test(message)) {
      info("-> CONFIG. The dataset or project name is wrong, or the dataset was deleted.");
    } else {
      info("-> Unrecognised. Treat the message above as the primary evidence.");
    }
    console.log("");
    continue;
  }

  /* 3b. Is GA4 still WRITING? The daily tables are named events_YYYYMMDD, so
     the newest suffix is the export's own high-water mark.
 
     Read from INFORMATION_SCHEMA, NOT from `getTables()`. The first version of
     this script listed tables with `maxResults: 500`, got exactly 500 back, took
     the max of a TRUNCATED page and reported the export as 144 days dead — while
     its own next query happily returned data from today. A paginated listing is
     not a source of truth about the newest anything. */
  let newest: string | undefined;
  let dailyCount = 0;
  try {
    const [meta] = await bigquery.query({
      query: `
        SELECT table_name
          FROM \`${projectId}.${app.bigqueryDataset}.INFORMATION_SCHEMA.TABLES\`
         WHERE REGEXP_CONTAINS(table_name, r'^events_[0-9]{8}$')`,
    });
    const suffixes = meta
      .map((row: { table_name: string }) => row.table_name.slice("events_".length))
      .sort();
    dailyCount = suffixes.length;
    newest = suffixes.at(-1);
  } catch (error) {
    bad(
      `could not read INFORMATION_SCHEMA: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  info(`(table listing returned ${tables.length}; metadata says ${dailyCount} daily tables)`);
  if (!newest) {
    bad("no events_YYYYMMDD tables at all — this dataset has never received a GA4 export");
    console.log("");
    continue;
  }
  const newestDate = new Date(
    `${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6, 8)}T00:00:00Z`,
  );
  const lagDays = Math.floor((Date.now() - newestDate.getTime()) / DAY_MS);
  const line = `newest daily table events_${newest} (${lagDays} day(s) old), ${dailyCount} daily tables`;
  if (lagDays <= 2) ok(line);
  else {
    bad(line);
    info(
      "-> EXPORT. GA4 has stopped delivering. Nothing in this codebase can fix " +
        "that: check the GA4 property's BigQuery Links page for an error, and " +
        "that the linked billing account is still active.",
    );
  }

  // 3c. Can we actually run a JOB? Listing tables needs only Data Viewer;
  // running a query needs Job User as well, and losing just the second is a
  // failure mode that step 3a cannot see.
  try {
    const [rows] = await bigquery.query({
      query: `SELECT COUNT(*) AS n FROM \`${projectId}.${app.bigqueryDataset}.events_${newest}\``,
      // Cheap by design: one day, one aggregate.
      maximumBytesBilled: String(2 * 1024 * 1024 * 1024),
    });
    ok(`query jobs work — events_${newest} holds ${rows[0]?.n ?? "?"} rows`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bad(`cannot run a query job: ${message}`);
    if (/Permission|403|denied/i.test(message)) {
      info(`-> IAM. Add roles/bigquery.jobUser to the service account on ${projectId}.`);
      info("   Listing tables only needs Data Viewer, so this can break on its own.");
    } else if (/quota|billing|exceeded/i.test(message)) {
      info("-> QUOTA/BILLING on the GCP project, not a credential problem.");
    }
  }

  // 3d. Recent activity, which is what the report's default range asks for.
  // A dataset can be perfectly healthy and still return nothing if the app
  // genuinely had no listing traffic — worth ruling out before blaming plumbing.
  try {
    const [rows] = await bigquery.query({
      query: `
        SELECT event_date, COUNT(*) AS events,
               COUNTIF(event_name = 'view_item') AS listing_views,
               COUNTIF(event_name = 'shopify_app_install') AS installs
          FROM \`${projectId}.${app.bigqueryDataset}.events_*\`
         WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 10 DAY))
         GROUP BY event_date
         ORDER BY event_date DESC
         LIMIT 10`,
      maximumBytesBilled: String(20 * 1024 * 1024 * 1024),
    });
    if (rows.length === 0) {
      bad("no events in the last 10 days — the report has nothing to show");
    } else {
      ok("recent daily volume:");
      for (const row of rows) {
        info(
          `${row.event_date}  events=${row.events}  view_item=${row.listing_views}  installs=${row.installs}`,
        );
      }
    }
  } catch (error) {
    bad(
      `recent-volume query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log("");
}

console.log("=== 4. The local TrafficEventFact mirror ===");
info(
  "The report does not always read BigQuery. When an app's traffic backfill has " +
    "COMPLETED and its sync is fresher than 20 minutes, reads are served from the " +
    "local mirror instead — all-or-nothing per request. So a stalled mirror sync, " +
    "or a mirror that is being written but is missing recent rows, stops the report " +
    "dead while BigQuery itself is perfectly healthy.",
);
console.log("");
for (const app of configured) {
  const [count, newest] = await Promise.all([
    prisma.trafficEventFact.count({ where: { appId: app.id } }),
    prisma.trafficEventFact.findFirst({
      where: { appId: app.id },
      orderBy: { eventTimestamp: "desc" },
      select: { eventTimestamp: true, fetchedAt: true },
    }),
  ]);
  const full = await prisma.app.findUnique({
    where: { id: app.id },
    select: {
      trafficEventsSyncedAt: true,
      trafficEventsBackfillCompletedAt: true,
    },
  });
  const syncedAt = full?.trafficEventsSyncedAt ?? null;
  const backfillDone = full?.trafficEventsBackfillCompletedAt ?? null;
  const syncLagMin = syncedAt
    ? Math.floor((Date.now() - syncedAt.getTime()) / 60_000)
    : null;
  const localActive = Boolean(backfillDone) && syncLagMin !== null && syncLagMin <= 20;

  console.log(`--- ${app.name}`);
  info(`backfillCompletedAt : ${backfillDone?.toISOString() ?? "(null — mirror never trusted)"}`);
  info(`syncedAt            : ${syncedAt?.toISOString() ?? "(null)"}${syncLagMin === null ? "" : ` (${syncLagMin} min ago)`}`);
  info(`mirror rows         : ${count}`);
  info(`newest mirrored row : ${newest?.eventTimestamp.toISOString() ?? "(none)"}`);
  if (localActive) {
    ok("reads are being served from the LOCAL MIRROR, not BigQuery");
    if (!newest) {
      bad("...but the mirror holds no rows at all — this is why the report is empty");
    } else {
      const rowLagDays = Math.floor(
        (Date.now() - newest.eventTimestamp.getTime()) / DAY_MS,
      );
      if (rowLagDays > 2) {
        bad(
          `...and its newest row is ${rowLagDays} days old, so recent ranges are empty ` +
            "even though the sync timestamp looks fresh",
        );
      } else ok(`mirror is current (newest row ${rowLagDays} day(s) old)`);
    }
  } else if (backfillDone && syncLagMin !== null) {
    info(
      `mirror is STALE (${syncLagMin} min > 20), so reads fall back to BigQuery — ` +
        "correct behaviour, but it means the mirror sync is not running",
    );
  } else {
    info("mirror not in use; reads go to BigQuery");
  }
  console.log("");
}

console.log("=== 5. Cached failures ===");
info(
  "The report is Redis-cached by every query parameter, so a fault that has " +
    "since been fixed can still be served from cache. If steps 1-3 all pass " +
    "but the UI is still empty, clear the traffic cache keys and retry.",
);

await prisma.$disconnect();
process.exit(0);
