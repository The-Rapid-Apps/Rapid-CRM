import { z } from "zod";
import {
  ANALYTICS_INTERVALS,
  ANALYTICS_PERIODS,
} from "~/lib/reports/analytics.shared";

/**
 * Query params accepted by `/api/metrics/:metric`.
 *
 * Lives here rather than in the route so it can be tested without pulling in
 * Prisma, Redis and the whole analytics graph. That matters because the schema
 * is `.strict()`: a param the client sends but the schema doesn't declare
 * fails the request with a 400 *before* any branch runs. It is a silent class
 * of bug — the caller sees a rejected request, not a wrong answer — and it hit
 * the trials history filters exactly that way.
 */
export const metricsQuerySchema = z
  .object({
    appId: z.string().trim().min(1).max(191).optional(),
    period: z.enum(ANALYTICS_PERIODS).default("last_30_days"),
    interval: z.enum(ANALYTICS_INTERVALS).optional(),
    mode: z.enum(["fast", "sampled", "exact"]).default("fast"),
    /* `recurring` only: also build the per-bucket series. Off by default
       because the cheap summary path is what made Overview fast, and most
       callers only need the current figures — see the recurring branch. */
    series: z
      .enum(["0", "1"])
      .optional()
      .transform((value) => value === "1"),
    /** `revenue` only: also return the preceding window, for the dashed
     * previous-period line. */
    compare: z
      .enum(["0", "1"])
      .optional()
      .transform((value) => value === "1"),
    refresh: z.string().trim().min(1).max(64).optional(),
    /* `trials` only: the history table's filters. They must be DECLARED even
       though the branch could read them off the URL directly — the schema is
       `.strict()`, so an undeclared param 400s the whole request before the
       branch runs. Left out, the table silently kept its unfiltered rows. */
    historyQuery: z.string().trim().max(200).optional(),
    historyStatus: z
      .enum(["all", "on_trial", "paying", "churned_during_trial"])
      .default("all"),
    historyPaidOnly: z
      .enum(["0", "1"])
      .optional()
      .transform((value) => value === "1"),
    historyPage: z.coerce.number().int().min(1).max(100_000).default(1),
  })
  .strict();
