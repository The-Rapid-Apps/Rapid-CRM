import "dotenv/config";
import { env } from "../app/lib/env.server";
import { logJson, logJsonError } from "./lib/script-log";

/**
 * The live-discount check's scheduler.
 *
 * Runs on the server under pm2 (`rapid-live-discounts` — see
 * ecosystem.config.cjs) as a `cron_restart` job: run to completion, exit.
 *
 * It exists because `POST /api/flex/cron/live-discount-check` once shipped with
 * no scheduler at all, so its rows went stale far past the job's own 24-hour
 * staleness floor.
 *
 * Why that is not cosmetic: `contributionAt` consumes those rows as
 * `liveDiscountEffectiveAmount` and prefers them over its inference chain, so
 * they lower reported MRR directly. A discount that has since ended keeps
 * depressing the number until something re-checks the charge.
 *
 * Drives the work over loopback HTTP like the sibling cron scripts rather than
 * importing the engine, so it runs inside the live web process (cache locality,
 * and the Partner API rate limiter is shared there).
 *
 * Loops while the endpoint answers 202. The route is bounded per invocation on
 * purpose — an unbounded first run against a real backlog timed out the reverse
 * proxy on 2026-09-02 — so one tick is not guaranteed to drain the candidate
 * set, and a scheduler that fired once per hour and accepted a 202 would take
 * days to catch up after any gap.
 *
 * Run: npm run sync:live-discounts
 */

const SCOPE = "sync-live-discount-checks";
/**
 * The app's own port, not Shopify's — this script drives the cron ROUTE.
 *
 * Defaults to 3000, what server.js serves on. The Vite dev server listens on
 * 5173, so point a local run at it with `APP_PORT`, which is honoured ahead of
 * `PORT` because `PORT` is often already set in a shell that has sourced the
 * server's env.
 */
const PORT = process.env.APP_PORT ?? process.env.PORT ?? "3000";
const BASE_URL = `http://127.0.0.1:${PORT}`;
/** Well inside the hourly tick, so a run never overlaps its successor. */
const DEADLINE_MS = 45 * 60_000;
/** Bounded so a permanently-202 endpoint cannot spin for the whole window. */
const MAX_PASSES = 40;

async function main(): Promise<void> {
  const startedAt = Date.now();
  let passes = 0;
  let checked = 0;
  let skipped = 0;
  let errors = 0;

  for (;;) {
    if (Date.now() - startedAt > DEADLINE_MS) {
      logJson(SCOPE, "deadline reached with a backlog still open", {
        passes,
        checked,
      });
      break;
    }
    if (passes >= MAX_PASSES) {
      logJson(SCOPE, "pass cap reached with a backlog still open", {
        passes,
        checked,
      });
      break;
    }

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/api/flex/cron/live-discount-check`, {
        method: "POST",
        headers: { "X-Cron-Secret": env.CRON_SECRET, Accept: "application/json" },
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      /* `fetch` reports a refused connection as the bare string "fetch failed",
         which names neither the port nor the cause. Since the single most
         likely cause is that nothing is serving this port, say so. */
      logJsonError(SCOPE, "could not reach the app", {
        url: BASE_URL,
        port: PORT,
        message: error instanceof Error ? error.message : String(error),
        hint:
          "Is the app running and serving this port? server.js serves 3000; the Vite " +
          "dev server serves 5173 — run with APP_PORT=5173 against a dev server.",
      });
      process.exit(1);
    }
    const body = await response.json().catch(() => ({}) as Record<string, unknown>);
    passes += 1;

    if (response.status !== 200 && response.status !== 202) {
      logJsonError(SCOPE, "check returned an unexpected status", {
        status: response.status,
        body: JSON.stringify(body).slice(0, 500),
      });
      process.exit(1);
    }

    /* Per organization, so a run that quietly stopped checking anything is
       greppable next to the ones that did. */
    for (const run of (body.organizations as Array<Record<string, unknown>>) ?? []) {
      checked += Number(run.checked ?? 0);
      skipped += Number(run.skipped ?? 0);
      /* The route returns `errors` as an ARRAY of {appId, message}, not a
         count. `Number([])` is 0 and `Number([oneEntry])` is NaN, so summing
         it directly made a single failing app read as "no errors" and the
         `errors > 0` exit check below pass anyway. */
      const runErrors = run.errors;
      errors += Array.isArray(runErrors) ? runErrors.length : Number(runErrors ?? 0);
      if (Array.isArray(runErrors) && runErrors.length > 0) {
        logJsonError(SCOPE, "organization reported per-app failures", {
          organizationId: String(run.organizationId ?? "?"),
          errors: JSON.stringify(runErrors).slice(0, 500),
        });
      }
    }

    // 200 means the candidate set is drained for now.
    if (response.status === 200) break;
  }

  logJson(SCOPE, "live discount checks finished", {
    passes,
    checked,
    skipped,
    errors,
    durationMs: Date.now() - startedAt,
  });
  if (errors > 0) process.exit(1);
}

main().catch((error) => {
  logJsonError(SCOPE, "run failed", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
