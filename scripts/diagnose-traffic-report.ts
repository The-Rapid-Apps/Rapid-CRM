/**
 * Runs the Traffic Source report exactly as the page does, and prints what came
 * back — including the `error` string the UI only ever shows as a banner.
 *
 * `npm run diagnose:traffic-report` (read-only).
 *
 * The sibling `diagnose:traffic` proves the PLUMBING is healthy (credentials,
 * IAM, GA4 export, local mirror). This one answers the next question: given
 * healthy plumbing, what does the report itself actually return? It reports the
 * trend series separately from the table, because "trends stopped" and "the
 * report stopped" are different faults — the trend buckets can come back empty
 * while `rows` is full, and only one of those is a charting problem.
 *
 * Each app is run twice, once per source: through `getTrafficSourcesReport`
 * (Redis-cached, i.e. what a visitor gets) and again with the local mirror
 * forced off, so a fault that only exists on one of the two paths is visible
 * rather than averaged away.
 */
import { prisma } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";
import { getTrafficSourcesReport } from "../app/lib/reports/traffic-sources.server";

const DAY_MS = 86_400_000;
const days = Number(process.env.DAYS ?? 30);
const now = new Date();
const start = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    days * DAY_MS,
);
const range = { start, end: now, interval: "day" as const };

const apps = await prisma.app.findMany({
  where: { NOT: { bigqueryDataset: null } },
  select: {
    id: true,
    name: true,
    bigqueryDataset: true,
    gcpProjectId: true,
    trafficEventsBackfillCompletedAt: true,
    trafficEventsSyncedAt: true,
  },
  orderBy: { name: "asc" },
});

console.log(
  `range ${start.toISOString().slice(0, 10)} -> ${now.toISOString().slice(0, 10)} (${days}d)\n`,
);

for (const app of apps) {
  const projectId = app.gcpProjectId ?? env.GCP_PROJECT_ID ?? null;
  console.log(`=== ${app.name}`);

  for (const mode of ["as the page runs it", "local mirror forced OFF"]) {
    const forceBigQuery = mode.includes("OFF");
    const startedAt = Date.now();
    try {
      const report = await getTrafficSourcesReport(
        range,
        undefined,
        undefined,
        1,
        undefined,
        {},
        undefined,
        app.bigqueryDataset,
        projectId,
        app.id,
        forceBigQuery ? null : app.trafficEventsBackfillCompletedAt,
        forceBigQuery ? null : app.trafficEventsSyncedAt,
      );
      const trendPoints = Object.values(report.totalsTrend ?? {}).reduce(
        (total, series) =>
          total + (Array.isArray(series) ? series.length : 0),
        0,
      );
      console.log(`  --- ${mode} (${Date.now() - startedAt}ms)`);
      console.log(`      available     : ${report.available}`);
      if (report.error) console.log(`      ERROR         : ${report.error}`);
      console.log(
        `      rows          : ${report.rows?.length ?? 0} (page 1 of ${report.totalPages ?? "?"})`,
      );
      console.log(
        `      totals keys   : ${Object.keys(report.totals ?? {}).join(", ") || "(none)"}`,
      );
      console.log(
        `      trendBuckets  : ${report.trendBuckets?.length ?? 0}` +
          `   totalsTrend series: ${Object.keys(report.totalsTrend ?? {}).length}` +
          `   points: ${trendPoints}`,
      );
      if ((report.trendBuckets?.length ?? 0) === 0 && report.available) {
        console.log(
          "      ^ available with NO trend buckets — this is the 'trends stopped' shape",
        );
      }
    } catch (error) {
      console.log(`  --- ${mode}: THREW`);
      console.log(
        `      ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  }
  console.log("");
}

await prisma.$disconnect();
process.exit(0);
