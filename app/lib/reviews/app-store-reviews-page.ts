/**
 * Reads one page of an app's public App Store reviews
 * (apps.shopify.com/<handle>/reviews?sort_by=newest&page=N).
 *
 * The listing page is the only source of reviews — the Partner API exposes
 * none — so this parses Shopify's HTML. It is strict on purpose: a review block
 * missing its id, rating, date or store name throws `ReviewsPageLayoutError`
 * rather than yielding a partial review, because a redesign of the page must
 * surface as a failed sync, never as a quiet drop to zero reviews.
 */

export interface ParsedReview {
  platformReviewId: string;
  rating: number;
  body: string;
  reviewerName: string;
  reviewerCountry: string | null;
  timeUsingApp: string | null;
  replyBody: string | null;
  /** UTC midnight of the day shown; the listing publishes no time of day. */
  reviewedAt: Date;
  /** The listing shows "Edited <date>" in place of the date; `reviewedAt`
   * is then the edit's day. */
  edited: boolean;
}

export interface ParsedReviewsPage {
  reviews: ParsedReview[];
  hasNextPage: boolean;
  /** The listing's headline rating and review count (JSON-LD), when present. */
  ratingValue: number | null;
  ratingCount: number | null;
}

export class ReviewsPageLayoutError extends Error {
  constructor(message: string) {
    super(`App Store reviews page layout changed: ${message}`);
    this.name = "ReviewsPageLayoutError";
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DATE_PATTERN = new RegExp(`\\b(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})(?!\\d)`);
const EDITED_PATTERN = new RegExp(`\\bEdited\\s+(${MONTHS.join("|")}) \\d`);

/* `data-merchant-review` itself, not `data-merchant-review-reply`. */
const REVIEW_OPEN_TAG = /<div\b[^>]*\sdata-merchant-review(?=[\s=>])[^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”",
};

/**
 * The HTML of the element whose opening `<div>` tag starts at `start`,
 * through its own closing tag — found by counting nested divs. A review must
 * end where its markup ends: reading "up to the next review" gave the LAST
 * review on a page the pagination and footer as its reply.
 */
function divElementAt(html: string, start: number): string {
  const tag = /<div\b[^>]*>|<\/div\s*>/gi;
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  throw new ReviewsPageLayoutError("a review's markup never closes");
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1].toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Visible text of an HTML fragment: paragraphs and line breaks kept. */
function htmlToText(fragment: string): string {
  const text = fragment
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    // Block ends break the line, so text from neighbouring elements can never
    // run together ("2026" + "Line one" must not read as one word).
    .replace(/<\/(div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseDay(text: string): Date | null {
  const match = DATE_PATTERN.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]);
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseReviewBlock(block: string): ParsedReview {
  const id = /data-review-content-id="(\d+)"/.exec(block)?.[1];
  if (!id) throw new ReviewsPageLayoutError("review without an id");
  const fail = (what: string) => {
    throw new ReviewsPageLayoutError(`review ${id} has no ${what}`);
  };

  const rating = Number(/aria-label="(\d) out of 5 stars"/.exec(block)?.[1]);
  if (!(rating >= 1 && rating <= 5)) fail("star rating");

  // The reply sits in its own container at the end of the block; everything
  // about the review itself comes before it.
  const replyTagAt = block.search(/<div\b[^>]*\sdata-merchant-review-reply\b/);
  const own = replyTagAt === -1 ? block : block.slice(0, replyTagAt);
  const replyText =
    replyTagAt === -1 ? "" : htmlToText(divElementAt(block, replyTagAt));

  const ownText = htmlToText(own);
  const reviewedAt = parseDay(ownText);
  if (!reviewedAt) fail("date");

  const nameAttr = /<span\b[^>]*\stitle="([^"]*)"/.exec(own)?.[1];
  const reviewerName = nameAttr ? decodeEntities(nameAttr).trim() : "";
  if (!reviewerName) fail("store name");

  const copy = /<div\b[^>]*\sdata-truncate-content-copy\b[^>]*>([\s\S]*?)<\/div>/.exec(own);
  const body = copy ? htmlToText(copy[1]) : "";

  // Country and time-using-the-app are bare <div>s under the store name; the
  // one that says "using the app" is the duration, the other the country.
  const facts = [...own.matchAll(/<div>([^<]+)<\/div>/g)]
    .map((match) => decodeEntities(match[1]).replace(/\s+/g, " ").trim())
    .filter((fact) => fact && !DATE_PATTERN.test(fact));
  const timeUsingApp = facts.find((fact) => /using the app/i.test(fact)) ?? null;
  const reviewerCountry = facts.find((fact) => fact !== timeUsingApp) ?? null;

  return {
    platformReviewId: id,
    rating,
    body,
    reviewerName,
    reviewerCountry,
    timeUsingApp,
    replyBody: replyText || null,
    reviewedAt: reviewedAt!,
    edited: EDITED_PATTERN.test(ownText),
  };
}

export function parseReviewsPage(html: string): ParsedReviewsPage {
  const reviews = [...html.matchAll(REVIEW_OPEN_TAG)].map((match) =>
    parseReviewBlock(divElementAt(html, match.index!)),
  );
  const ratingValue = /"ratingValue"\s*:\s*"?([\d.]+)/.exec(html)?.[1];
  const ratingCount = /"ratingCount"\s*:\s*"?(\d+)/.exec(html)?.[1];
  return {
    reviews,
    hasNextPage: /<a\b[^>]*\srel="next"/.test(html),
    ratingValue: ratingValue ? Number(ratingValue) : null,
    ratingCount: ratingCount ? Number(ratingCount) : null,
  };
}
