/**
 * Shared driver for the resumable Shopify synchronization lanes.
 *
 * Both `scripts/sync-shopify.ts` (the pm2 cron trigger, bounded so each run
 * fits its window) and `scripts/drain-backfill.ts` (manual catch-up, runs until
 * the backfill converges) use this, so the retry/completion semantics exist in
 * exactly one place. Adding a scheduled lane means adding it to LANE_NAMES and
 * nothing else — this is the only timer that drives them.
 *
 * It drives the lanes over loopback HTTP rather than importing the sync
 * functions directly: the work then happens inside the live server process, so
 * that process's in-memory analytics caches are invalidated by its own writes,
 * and the fenced cursor leases stay owned by the process that holds them.
 */
import { env } from "../env.server";

export const LANE_NAMES = [
  "subscription-events",
  "customer-events",
  // Local GA4 mirror (TrafficEventFact). Settles in one call — 200/503, never
  // 202 — advancing one bounded BACKFILL_CHUNK_DAYS window per tick rather
  // than resuming within a run.
  "traffic-events",
  // App Store reviews (app-reviews-sync.server.ts), read from each app's public
  // listing. Independent of every lane above. 200 (full reads done) / 202 (a
  // full read continues) / 503 (every app failed).
  "app-reviews",
] as const;

export type LaneName = (typeof LANE_NAMES)[number];

/**
 * Terminal state for a lane within a single run. Only `complete` means "no
 * work left"; every other state is safely retried on the next run because the
 * lanes resume from persisted cursors.
 */
export type LaneState =
  | "complete"
  | "unusable"
  | "timeout"
  | "error"
  | "incomplete";

export type LaneClassification = {
  /** All history imported — the lane needs no further runs. */
  complete: boolean;
  /** Cannot progress (no usable Partner connection); retrying now won't help. */
  unusable: boolean;
};

/**
 * Maps a cron endpoint's HTTP status onto lane progress. The endpoints answer
 * 200 = complete, 202 = progress made but more remains, 503 = unusable.
 * Anything else is treated as retryable rather than terminal, so an unexpected
 * status can never make a run declare the backfill finished.
 */
export function classifyLaneResponse(status: number): LaneClassification {
  return { complete: status === 200, unusable: status === 503 };
}

export type SyncRunSummary = {
  iterations: number;
  elapsedMs: number;
  lanes: Record<LaneName, LaneState>;
  /** True when every lane reached a terminal state that isn't an error. */
  settledCleanly: boolean;
};

export type RunSyncLanesOptions = {
  /** Stop *starting* iterations once this much time has passed. */
  deadlineMs?: number;
  maxIterations?: number;
  requestTimeoutMs?: number;
  /** Breather between iterations so a backlog cannot monopolise the API. */
  pauseMs?: number;
  baseUrl?: string;
  lanes?: readonly LaneName[];
  onEvent?: (event: SyncLaneEvent) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
};

export type SyncLaneEvent =
  | {
      type: "chunk";
      lane: LaneName;
      iteration: number;
      status: number;
      detail: string;
    }
  | { type: "lane-settled"; lane: LaneName; state: LaneState }
  | { type: "deadline"; iteration: number; pending: LaneName[] }
  | {
      type: "lane-failed";
      lane: LaneName;
      iteration: number;
      timedOut: boolean;
      error: string;
    };

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runSyncLanes(
  options: RunSyncLanesOptions = {},
): Promise<SyncRunSummary> {
  const {
    deadlineMs = 4 * 60 * 1000,
    maxIterations = 12,
    requestTimeoutMs = 480_000,
    pauseMs = 3_000,
    baseUrl = `http://127.0.0.1:${process.env.PORT ?? "3000"}`,
    lanes = LANE_NAMES,
    onEvent,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    nowImpl = Date.now,
  } = options;

  const startedAt = nowImpl();
  const pending = new Set<LaneName>(lanes);
  const states = {} as Record<LaneName, LaneState>;
  let iteration = 0;

  while (pending.size > 0 && iteration < maxIterations) {
    // Checked between iterations, never mid-request: aborting a lane call would
    // discard the Partner API pages it has already paid for.
    if (nowImpl() - startedAt >= deadlineMs) {
      onEvent?.({ type: "deadline", iteration, pending: [...pending] });
      break;
    }
    iteration += 1;

    for (const lane of [...pending]) {
      let settled: LaneState | null = null;
      try {
        const response = await fetchImpl(
          `${baseUrl}/api/flex/cron/${lane}`,
          {
            method: "POST",
            headers: {
              "X-Cron-Secret": env.CRON_SECRET,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(requestTimeoutMs),
          },
        );
        const body = await response.json().catch(() => ({}));
        const { complete, unusable } = classifyLaneResponse(response.status);
        onEvent?.({
          type: "chunk",
          lane,
          iteration,
          status: response.status,
          detail: JSON.stringify(body).slice(0, 400),
        });
        if (complete) settled = "complete";
        else if (unusable) settled = "unusable";
      } catch (error) {
        // One lane failing must not abandon the other or fail the run: the next
        // run resumes from the same cursor either way.
        const timedOut =
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError");
        onEvent?.({
          type: "lane-failed",
          lane,
          iteration,
          timedOut,
          error: error instanceof Error ? error.message : String(error),
        });
        settled = timedOut ? "timeout" : "error";
      }

      if (settled) {
        pending.delete(lane);
        states[lane] = settled;
        onEvent?.({ type: "lane-settled", lane, state: settled });
      }
    }

    if (pending.size > 0) await sleepImpl(pauseMs);
  }

  for (const lane of pending) states[lane] = "incomplete";

  return {
    iterations: iteration,
    elapsedMs: nowImpl() - startedAt,
    lanes: states,
    settledCleanly: Object.values(states).every(
      (state) => state === "complete" || state === "unusable",
    ),
  };
}
