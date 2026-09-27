/**
 * The Shopify synchronization trigger.
 *
 * Runs on the server under pm2 (`rapi-management-sync`, `cron_restart` every
 * 5 minutes — see ecosystem.config.cjs), and since 2026-08-21 it is the only
 * trigger: the `Synchronize Shopify analytics facts` GitHub Actions workflow
 * that used to SSH in and curl the same endpoints is gone. That schedule was
 * best-effort and was observed skipping runs for hours, which left
 * `historyComplete` false indefinitely and pinned the dashboard to fast
 * estimates.
 *
 * Which lanes run is decided entirely by LANE_NAMES in sync-lanes.server.ts —
 * this script only supplies the budget.
 *
 * Every lane is resumable, so this does deliberately bounded work and exits;
 * whatever is left resumes on the next tick from the saved cursors. It exits 0
 * even when lanes remain incomplete — an unconverged backfill is the normal
 * steady state, not a failure, and a non-zero exit would make pm2 log every
 * healthy run as a crash.
 *
 * Run: npm run sync:shopify
 */
import "dotenv/config";
import { runSyncLanes } from "../app/lib/shopify/sync-lanes.server";
import { logJson, logJsonError } from "./lib/script-log";

async function main(): Promise<void> {
  const summary = await runSyncLanes({
    deadlineMs: Number(process.env.SYNC_DEADLINE_MS ?? 4 * 60 * 1000),
    maxIterations: Number(process.env.SYNC_MAX_ITERATIONS ?? 12),
    onEvent: (event) => {
      switch (event.type) {
        case "chunk":
          logJson("sync-shopify", "lane chunk finished", {
            lane: event.lane,
            iteration: event.iteration,
            status: event.status,
            detail: event.detail,
          });
          break;
        case "deadline":
          logJson("sync-shopify", "deadline reached; remainder resumes next tick", {
            iteration: event.iteration,
            pending: event.pending,
          });
          break;
        case "lane-failed":
          logJsonError(
            "sync-shopify",
            event.timedOut ? "lane request timed out" : "lane request failed",
            { lane: event.lane, iteration: event.iteration, error: event.error },
          );
          break;
        case "lane-settled":
          if (event.state === "unusable") {
            logJsonError("sync-shopify", "lane unusable; skipped this run", {
              lane: event.lane,
            });
          }
          break;
      }
    },
  });

  logJson("sync-shopify", "sync run finished", {
    iterations: summary.iterations,
    elapsedMs: summary.elapsedMs,
    lanes: summary.lanes,
  });
}

main().catch((error) => {
  logJsonError("sync-shopify", "sync run crashed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
