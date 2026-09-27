import { after } from "node:test";
import { closeRedis } from "../app/lib/redis.server";

/**
 * `node --test` isolates each `tests/*.test.ts` file into its own child
 * process. redis.server.ts's ioredis connection keeps that process's event
 * loop alive, so any test file that imports it (even transitively, e.g. via
 * partner.server.ts) hangs forever after its own tests finish instead of
 * letting the runner move on to the next file. Preloaded into every child via
 * `--import` (see package.json's "test" script) so this is automatic instead
 * of a per-file opt-in that's easy to miss — partner.server.ts is a deep,
 * widely-imported dependency (poll.server.ts, billing.server.ts,
 * partner-analytics.server.ts, and more), not something to track by hand.
 */
after(async () => {
  await closeRedis();
});
