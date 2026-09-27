/**
 * Drive the historical Shopify backfill to completion in one sitting.
 *
 * The pm2 cron (`npm run sync:shopify`) converges the backfill on its own in
 * bounded 5-minute chunks. This script is the manual catch-up for when you do
 * not want to wait — after a long scheduler outage, after adding an app, or
 * when verifying that `historyComplete` can actually be reached.
 *
 * It is the same resumable work, just with a much larger budget, so it is safe
 * to interrupt at any point: every lane resumes from its saved cursor.
 *
 * Run: npm run backfill:drain
 *      SYNC_MAX_ITERATIONS=40 npm run backfill:drain
 */
import "dotenv/config";
import { runSyncLanes } from "../app/lib/shopify/sync-lanes.server";
import { logJson, logJsonError } from "./lib/script-log";

async function main(): Promise<void> {
  const summary = await runSyncLanes({
    // Deliberately generous: the point of this script is to finish, and the
    // work is idempotent, so the only real cost of a long run is Partner API
    // quota — which the pause between iterations already paces.
    deadlineMs: Number(process.env.SYNC_DEADLINE_MS ?? 60 * 60 * 1000),
    maxIterations: Number(process.env.SYNC_MAX_ITERATIONS ?? 150),
    onEvent: (event) => {
      switch (event.type) {
        case "chunk":
          logJson("drain-backfill", "lane chunk finished", {
            lane: event.lane,
            iteration: event.iteration,
            status: event.status,
            detail: event.detail,
          });
          break;
        case "lane-settled":
          logJson("drain-backfill", "lane settled", {
            lane: event.lane,
            state: event.state,
          });
          break;
        case "deadline":
          logJson("drain-backfill", "deadline reached before convergence", {
            iteration: event.iteration,
            pending: event.pending,
          });
          break;
        case "lane-failed":
          logJsonError(
            "drain-backfill",
            event.timedOut ? "lane request timed out" : "lane request failed",
            { lane: event.lane, iteration: event.iteration, error: event.error },
          );
          break;
      }
    },
  });

  logJson("drain-backfill", "drain finished", {
    iterations: summary.iterations,
    elapsedMs: summary.elapsedMs,
    lanes: summary.lanes,
  });

  const incomplete = Object.entries(summary.lanes).filter(
    ([, state]) => state !== "complete" && state !== "unusable",
  );
  if (incomplete.length > 0) {
    // Unlike the cron trigger, this script is run by a human who asked for
    // convergence, so not reaching it is worth a non-zero exit.
    logJsonError("drain-backfill", "lanes did not converge", {
      lanes: Object.fromEntries(incomplete),
      hint: "Re-run to continue from the saved cursors, or raise SYNC_MAX_ITERATIONS.",
    });
    process.exit(1);
  }
}

main().catch((error) => {
  logJsonError("drain-backfill", "drain crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
