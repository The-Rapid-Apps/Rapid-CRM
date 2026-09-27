/** A review's star rating, five glyphs with the empty ones muted. Colours are
 * the `--review-star` tokens in app.css. */
export function ReviewStars({ rating }: { rating: number }) {
  return (
    <span className="overview-review__stars" role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          aria-hidden="true"
          className={star <= rating ? undefined : "overview-review__star--empty"}
        >
          ★
        </span>
      ))}
    </span>
  );
}
