import assert from "node:assert/strict";
import test from "node:test";
import { metricsQuerySchema } from "../app/lib/reports/metrics-query";
import { TRIAL_HISTORY_PAGE_SIZE } from "../app/lib/reports/analytics.shared";

/**
 * Guards a silent failure mode, hit for real on 2026-09-22.
 *
 * The schema is `.strict()`, so a param the client sends but the schema does
 * not declare fails the whole request with a 400 before any metric branch
 * runs. When the trials history filters moved server-side, they were added to
 * the URL but not to the schema: every search 400'd, the browser ignored it,
 * and the table kept its previous rows — indistinguishable from a search that
 * simply matched nothing.
 *
 * So: whenever the Reports page learns to send a new param, add it here too.
 */

/** Exactly what `UsagePanel`'s trials effect puts on the URL. */
function trialsRequestParams() {
  const params = new URLSearchParams({ period: "last_30_days", interval: "day" });
  params.set("appId", "app_123");
  params.set("historyQuery", "free");
  params.set("historyStatus", "on_trial");
  params.set("historyPaidOnly", "1");
  params.set("historyPage", "3");
  return Object.fromEntries(params);
}

test("the trials history filters the page actually sends are accepted", () => {
  const parsed = metricsQuerySchema.safeParse(trialsRequestParams());

  assert.equal(
    parsed.success,
    true,
    `strict schema rejected a param the client sends: ${
      parsed.success ? "" : JSON.stringify(parsed.error.issues)
    }`,
  );
});

test("history filters parse into the types the route branch expects", () => {
  const parsed = metricsQuerySchema.parse(trialsRequestParams());

  assert.equal(parsed.historyQuery, "free");
  assert.equal(parsed.historyStatus, "on_trial");
  assert.equal(parsed.historyPaidOnly, true, "'1' becomes a boolean");
  assert.equal(parsed.historyPage, 3, "the page arrives as a number, not a string");
});

test("omitting the history filters yields the unfiltered defaults", () => {
  const parsed = metricsQuerySchema.parse({ period: "last_30_days" });

  assert.equal(parsed.historyStatus, "all");
  assert.equal(parsed.historyPaidOnly, false);
  assert.equal(parsed.historyPage, 1);
  assert.equal(parsed.historyQuery, undefined);
});

test("an undeclared param is still rejected, which is the point of .strict()", () => {
  const parsed = metricsQuerySchema.safeParse({
    period: "last_30_days",
    historyQeury: "typo",
  });

  assert.equal(parsed.success, false);
});

test("a nonsense page number is rejected rather than coerced to NaN", () => {
  assert.equal(
    metricsQuerySchema.safeParse({ period: "last_30_days", historyPage: "abc" })
      .success,
    false,
  );
  assert.equal(
    metricsQuerySchema.safeParse({ period: "last_30_days", historyPage: "0" })
      .success,
    false,
    "pages are 1-based",
  );
});

test("the page size is shared, so the server cuts the page the table renders", () => {
  assert.equal(TRIAL_HISTORY_PAGE_SIZE, 25);
});
