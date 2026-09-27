import assert from "node:assert/strict";
import test from "node:test";
import {
  filterRecentReviews,
  reviewDaysAgo,
  reviewDaysAgoLabel,
  reviewWindowStart,
} from "../app/lib/reviews/reviews.shared";

const now = new Date("2026-09-25T15:30:00Z");
const review = (id: string, day: string, rating: number, appId = "a") => ({
  id, appId, rating, body: "", reviewerName: id, reviewedAt: `${day}T00:00:00.000Z`,
});

test("days ago counts calendar days, not hours", () => {
  assert.equal(reviewDaysAgo("2026-09-25T00:00:00.000Z", now), 0);
  assert.equal(reviewDaysAgo("2026-09-24T00:00:00.000Z", now), 1);
  assert.equal(reviewDaysAgo("2026-09-24T00:00:00.000Z", new Date("2026-09-25T00:01:00Z")), 1);
  assert.equal(reviewDaysAgoLabel(0), "Today");
  assert.equal(reviewDaysAgoLabel(1), "1 day ago");
  assert.equal(reviewDaysAgoLabel(12), "12 days ago");
});

test("'last 7 days' is today plus the six days before it", () => {
  assert.equal(reviewWindowStart(7, now).toISOString(), "2026-09-19T00:00:00.000Z");
  const reviews = [review("in", "2026-09-19", 5), review("out", "2026-09-18", 5)];
  assert.deepEqual(filterRecentReviews(reviews, { appId: "", days: 7, rating: "all" }, now).map((r) => r.id), ["in"]);
});

test("rating groups leave 3 stars out of both, like Mantle", () => {
  const reviews = [1, 2, 3, 4, 5].map((stars) => review(`r${stars}`, "2026-09-25", stars));
  const ids = (rating: "negative" | "positive" | "all") =>
    filterRecentReviews(reviews, { appId: "", days: 30, rating }, now).map((r) => r.id);
  assert.deepEqual(ids("negative"), ["r1", "r2"]);
  assert.deepEqual(ids("positive"), ["r4", "r5"]);
  assert.equal(ids("all").length, 5);
});

test("app filter: empty means all apps", () => {
  const reviews = [review("x", "2026-09-25", 5, "a"), review("y", "2026-09-25", 5, "b")];
  assert.deepEqual(filterRecentReviews(reviews, { appId: "b", days: 30, rating: "all" }, now).map((r) => r.id), ["y"]);
  assert.equal(filterRecentReviews(reviews, { appId: "", days: 30, rating: "all" }, now).length, 2);
});
