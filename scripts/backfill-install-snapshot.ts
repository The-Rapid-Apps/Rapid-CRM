/**
 * Drive `PartnerDailyInstallSnapshot` to fully cover today.
 *
 * The writer normally advances one chunk per customer-events cron tick, which
 * is right for steady state but leaves the table stale wherever that cron has
 * not been running — a dev machine, or any environment where it stalled. A
 * stale snapshot is not a correctness problem (`installSnapshotReadiness`
 * detects the gap and the reports fall back to the live install scan), but the
 * fallback pages every install row to produce one number: tens of thousands
 * of rows and seconds per request for a large app.
 *
 * Safe to re-run. It only calls the same writer the cron calls, which is
 * idempotent per day and anchored on the last known-good day. Clearing the
 * per-app throttle between iterations is the only thing this adds — the
 * throttle exists to stop a cron from re-entering itself, not to bound a
 * deliberate catch-up.
 *
 *   npm run snapshot:install          # every live app
 *   APP="Rapi Bundle" npm run snapshot:install
 */
import { prisma } from "../app/lib/db.server";
import { runInstallSnapshotSync } from "../app/lib/reports/install-snapshot.server";
import { invalidateRedisCachePattern } from "../app/lib/cache/redis-cache.server";

const SELECT = {
  id: true,
  name: true,
  installSnapshotSyncedAt: true,
  installSnapshotFloorDate: true,
  installSnapshotBackfillCompletedAt: true,
  installSnapshotDirtyFrom: true,
  lifecycleEventsBackfillCompletedAt: true,
  lifecycleEventsSyncedAt: true,
} as const;

const name = process.env.APP?.trim();
const apps = await prisma.app.findMany({
  where: { removed: false, ...(name ? { name } : {}) },
  select: SELECT,
});

for (const app of apps) {
  if (!app.lifecycleEventsBackfillCompletedAt) {
    console.log(`${app.name}: skipped — lifecycle backfill not complete`);
    continue;
  }
  let current = app;
  let passes = 0;
  const startedAt = Date.now();

  /* Bounded rather than `while (true)`: if a pass stops advancing
     `installSnapshotDirtyFrom`, looping again will not help and the run should
     say so instead of spinning. */
  while (passes < 50) {
    const before = current.installSnapshotDirtyFrom?.getTime() ?? null;
    await invalidateRedisCachePattern(`snapshot-throttle:install:${current.id}`);
    await runInstallSnapshotSync(current, new Date());
    passes++;

    const next = await prisma.app.findUniqueOrThrow({
      where: { id: current.id },
      select: SELECT,
    });
    const after = next.installSnapshotDirtyFrom?.getTime() ?? null;
    current = next;
    if (after === null) break;          // caught up
    if (after === before) break;        // no progress — report it below
  }

  const remaining = current.installSnapshotDirtyFrom;
  console.log(
    `${app.name}: ${remaining ? `STILL DIRTY from ${remaining.toISOString().slice(0, 10)}` : "caught up"}` +
      ` after ${passes} pass(es), ${Date.now() - startedAt}ms`,
  );
}
await prisma.$disconnect();
