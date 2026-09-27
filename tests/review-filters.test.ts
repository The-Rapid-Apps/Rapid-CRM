import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReviewFilters,
  parseReviewFilters,
  reviewFiltersQuery,
  shopifyPlanLabel,
  timeUsingBucket,
  timeUsingDays,
  type ReviewRow,
} from "../app/lib/reviews/review-filters";

const near = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test("time using the app: every wording the listing uses", () => {
  near(timeUsingDays("40 minutes using the app"), 40 / 1440);
  near(timeUsingDays("About 1 hour using the app"), 1 / 24);
  assert.equal(timeUsingDays("18 days using the app"), 18);
  assert.equal(timeUsingDays("About 2 months using the app"), 60);
  assert.equal(timeUsingDays("Over 1 year using the app"), 365);
  assert.equal(timeUsingDays("Almost 2 years using the app"), 730);
  assert.equal(timeUsingDays(null), null);
  assert.equal(timeUsingBucket("About 22 hours using the app"), "under_day");
  assert.equal(timeUsingBucket("1 day using the app"), "week");
  assert.equal(timeUsingBucket("7 days using the app"), "week");
  assert.equal(timeUsingBucket("8 days using the app"), "month");
  assert.equal(timeUsingBucket("5 months using the app"), "over_month");
});

test("Shopify plan codes read as Shopify names them", () => {
  assert.equal(shopifyPlanLabel("dormant"), "Pause and Build");
  assert.equal(shopifyPlanLabel("professional"), "Shopify");
  assert.equal(shopifyPlanLabel("unlimited"), "Advanced");
  assert.equal(shopifyPlanLabel("Basic"), "Basic", "case-insensitive");
  assert.equal(shopifyPlanLabel("Developer Preview"), "Developer preview");
  assert.equal(shopifyPlanLabel("some_new_plan"), "some_new_plan", "unknown codes shown as-is");
  assert.equal(shopifyPlanLabel(""), null);
});

test("URL round trip keeps only what was chosen, and drops junk", () => {
  const filters = parseReviewFilters(new URLSearchParams("appId=a1&rating=1,2,9,2&time=week,nope&after=2026-01-01&before=bad&plan=Basic&reply=replied&archive=gone&page=3"));
  assert.equal(filters.archive, "", "unknown archive value dropped");
  assert.deepEqual(filters.ratings, [1, 2]);
  assert.deepEqual(filters.timeUsing, ["week"]);
  assert.equal(filters.before, "");
  assert.equal(filters.page, 3);
  assert.equal(reviewFiltersQuery(filters), "appId=a1&rating=1%2C2&time=week&after=2026-01-01&plan=Basic&reply=replied&page=3");
  assert.equal(reviewFiltersQuery(parseReviewFilters(new URLSearchParams(""))), "");
});

const row = (over: Partial<ReviewRow>): ReviewRow => ({
  id: "r", appId: "a", rating: 5, body: "Great support from Arthur", reviewerName: "Acme",
  timeUsingApp: "3 days using the app", replyBody: null, reviewedAt: "2026-06-15T00:00:00.000Z",
  edited: false, archivedAt: null, shopDomain: null, shopifyPlan: null, ...over,
});

test("filters combine, and dates are inclusive calendar days", () => {
  const rows = [
    row({ id: "a" }),
    row({ id: "b", rating: 1, reviewedAt: "2026-06-01T00:00:00.000Z", replyBody: "Thanks" }),
    row({ id: "c", shopifyPlan: "Basic", shopDomain: "acme-x.myshopify.com", body: "meh", archivedAt: "2026-07-01T13:00:00.000Z" }),
  ];
  const run = (query: string) => applyReviewFilters(rows, parseReviewFilters(new URLSearchParams(query))).map((r) => r.id);
  assert.deepEqual(run("after=2026-06-15&before=2026-06-15"), ["a", "c"]);
  assert.deepEqual(run("rating=1"), ["b"]);
  assert.deepEqual(run("reply=replied"), ["b"]);
  assert.deepEqual(run("reply=unreplied&plan=Basic"), ["c"]);
  assert.deepEqual(run("q=ARTHUR"), ["a", "b"], "search is case-insensitive over text");
  assert.deepEqual(run("q=acme-x"), ["c"], "and over the matched shop domain");
  assert.deepEqual(run("time=over_month"), []);
  assert.deepEqual(run("archive=archived"), ["c"]);
  assert.deepEqual(run("archive=active"), ["a", "b"]);
});

test("Mantle's display names land on the same labels as Shopify's codes", () => {
  assert.equal(shopifyPlanLabel("Shopify Plus"), shopifyPlanLabel("shopify_plus"));
  assert.equal(shopifyPlanLabel("Shopify Starter"), shopifyPlanLabel("starter_2022"));
  assert.equal(shopifyPlanLabel("trial"), shopifyPlanLabel("Trial"));
  assert.equal(shopifyPlanLabel("Pause and Build"), "Pause and Build");
});
