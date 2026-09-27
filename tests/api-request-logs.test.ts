import assert from "node:assert/strict";
import test from "node:test";
import {
  redactApiLogQuery,
  redactApiLogValue,
  shouldCaptureApiRequest,
} from "../app/lib/api-request-logs.server";

test("captures only developer-facing platform APIs", () => {
  assert.equal(
    shouldCaptureApiRequest(new URL("https://rapid.test/api/flex/usage")),
    true,
  );
  assert.equal(
    shouldCaptureApiRequest(new URL("https://rapid.test/api/discounts/resolve")),
    true,
  );
  assert.equal(
    shouldCaptureApiRequest(new URL("https://rapid.test/api/metrics/mrr")),
    false,
  );
  assert.equal(
    shouldCaptureApiRequest(new URL("https://rapid.test/app/reports")),
    false,
  );
});

test("filters credentials embedded in query strings", () => {
  assert.equal(
    redactApiLogQuery(
      new URL(
        "https://rapid.test/api/flex/plans?shopDomain=example.myshopify.com&access_token=secret",
      ),
    ),
    "shopDomain=example.myshopify.com&access_token=%5BFILTERED%5D",
  );
});

test("filters nested credentials while preserving useful request context", () => {
  assert.deepEqual(
    redactApiLogValue({
      shopDomain: "example.myshopify.com",
      authorization: "Bearer secret",
      customFields: {
        accessToken: "shop-token",
        plan: "Starter",
      },
      headers: [{ api_key: "secret" }, { accept: "application/json" }],
    }),
    {
      shopDomain: "example.myshopify.com",
      authorization: "[FILTERED]",
      customFields: {
        accessToken: "[FILTERED]",
        plan: "Starter",
      },
      headers: [{ api_key: "[FILTERED]" }, { accept: "application/json" }],
    },
  );
});
