import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decodeEntities,
  parseReviewsPage,
  ReviewsPageLayoutError,
} from "../app/lib/reviews/app-store-reviews-page";

/** A real listing page (2026-09-24), anonymised and trimmed to what the parser reads. */
const page = readFileSync(new URL("fixtures/app-store-reviews-page.html", import.meta.url), "utf8");

/** One review block in the listing's markup, for the edge cases below. */
function block({
  id = "900",
  stars = '<div aria-label="4 out of 5 stars" role="img"></div>',
  date = "<div>March 3, 2026</div>",
  // Shopify sends accented letters as-is and escapes only &, <, >, quotes.
  name = '<span title="Café &amp; Co&#39;s">Café &amp; Co&#39;s</span>',
  copy = '<div data-truncate-content-copy class="x"><p class="tw-break-words">Line one<br>Line two</p><p>Second &quot;para&quot;</p></div>',
  facts = "<div>France</div><div>About 2 hours using the app</div>",
  reply = "",
} = {}) {
  return `<div data-merchant-review="" data-review-content-id="${id}" class="x"><div>${stars}${date}</div><div data-truncate-review>${copy}</div><div class="side">${name}${facts}</div><div class="y" data-merchant-review-reply><div>${reply}</div></div></div>`;
}

test("reads every review on a real listing page", () => {
  const parsed = parseReviewsPage(page);
  assert.equal(parsed.reviews.length, 10);
  assert.equal(parsed.hasNextPage, true);
  assert.equal(parsed.ratingValue, 4.9);
  assert.equal(parsed.ratingCount, 68);
  assert.deepEqual(parsed.reviews[0], {
    platformReviewId: "2369401",
    rating: 5,
    body: "Thanks to the support team for the help",
    reviewerName: "Store One",
    reviewerCountry: "United States",
    timeUsingApp: "1 day using the app",
    replyBody: null,
    reviewedAt: new Date("2026-09-22T00:00:00.000Z"),
    edited: false,
  });
  assert.equal(new Set(parsed.reviews.map((r) => r.platformReviewId)).size, 10, "ids are unique");
  for (const review of parsed.reviews) {
    assert.ok(review.rating >= 1 && review.rating <= 5);
    assert.ok(review.reviewerName.length > 0);
  }
});

test("the last page has no next link", () => {
  assert.equal(parseReviewsPage(block()).hasNextPage, false);
});

test("text: entities decoded, paragraphs and line breaks kept", () => {
  const [review] = parseReviewsPage(block()).reviews;
  assert.equal(review.reviewerName, "Café & Co's");
  assert.equal(review.body, 'Line one\nLine two\n\nSecond "para"');
  assert.equal(review.rating, 4);
  assert.equal(review.reviewerCountry, "France");
  assert.equal(review.timeUsingApp, "About 2 hours using the app");
  assert.deepEqual(review.reviewedAt, new Date("2026-03-03T00:00:00.000Z"));
});

test("an edited review is flagged, and dated by its edit", () => {
  // As the listing shows it (DİDEM BUTİK, rapid-tracking page 3, 2026-09-25).
  const [review] = parseReviewsPage(block({ date: '<div class="tw-text-body-xs">Edited April 24, 2026</div>' })).reviews;
  assert.equal(review.edited, true);
  assert.deepEqual(review.reviewedAt, new Date("2026-04-24T00:00:00.000Z"));
  assert.equal(parseReviewsPage(block()).reviews[0].edited, false);
});

test("a star-only review has empty text, not an error", () => {
  const [review] = parseReviewsPage(
    block({ copy: '<div data-truncate-content-copy><p class="tw-break-words"></p></div>' }),
  ).reviews;
  assert.equal(review.body, "");
});

test("a missing country or duration is null, whichever it is", () => {
  const [onlyTime] = parseReviewsPage(block({ facts: "<div>5 days using the app</div>" })).reviews;
  assert.equal(onlyTime.reviewerCountry, null);
  assert.equal(onlyTime.timeUsingApp, "5 days using the app");
});

test("a developer reply is captured, and never mistaken for the review", () => {
  const [review] = parseReviewsPage(
    block({ reply: "<p>Acme Apps replied April 1, 2026</p><p>Thanks!</p>" }),
  ).reviews;
  assert.equal(review.replyBody, "Acme Apps replied April 1, 2026\n\nThanks!");
  assert.deepEqual(review.reviewedAt, new Date("2026-03-03T00:00:00.000Z"), "date from the review, not the reply");
});

test("the last review on a page ends at its own markup, not at the footer", () => {
  const footer = '<nav><a href="?page=2">2</a> Next</nav><footer><div>App categories</div></footer>';
  const [review] = parseReviewsPage(block() + footer).reviews;
  assert.equal(review.replyBody, null);
  for (const r of parseReviewsPage(page).reviews) assert.equal(r.replyBody, null, "no replies on the fixture page");
});

test("a changed layout fails loudly instead of yielding partial reviews", () => {
  assert.throws(() => parseReviewsPage(block({ stars: "<div></div>" })), ReviewsPageLayoutError);
  assert.throws(() => parseReviewsPage(block({ date: "<div>yesterday</div>" })), ReviewsPageLayoutError);
  assert.throws(() => parseReviewsPage(block({ name: "<span>no title</span>" })), ReviewsPageLayoutError);
});

test("entity decoding", () => {
  assert.equal(decodeEntities("&#233;&#x1F600;&amp;&nbsp;&unknown;"), "é😀& &unknown;");
});
