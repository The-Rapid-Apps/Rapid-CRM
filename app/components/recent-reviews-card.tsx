import { ActionList, Button, Card, Popover, Text } from "@shopify/polaris";
import { useMemo, useState } from "react";
import { AppPicker } from "~/components/app-picker";
import { ReviewStars } from "~/components/review-stars";
import {
  filterRecentReviews,
  REVIEW_RATING_FILTERS,
  REVIEW_WINDOW_DAYS,
  reviewDaysAgo,
  reviewDaysAgoLabel,
  type RecentReview,
  type ReviewRatingFilter,
  type ReviewWindowDays,
} from "~/lib/reviews/reviews.shared";

/**
 * The Overview's "Recent reviews" card, after Mantle's: App / period / rating
 * filters over the last 30 days of App Store reviews, which the loader sends
 * whole — a few dozen rows — so filtering never waits on the server.
 */

interface ReviewApp {
  id: string;
  name: string;
  logoUrl?: string | null;
  appStoreHandle: string | null;
}

/** One disclosure button over a single-choice menu — the card's filters. */
function FilterMenu<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      active={open}
      activator={
        <Button disclosure onClick={() => setOpen((current) => !current)} accessibilityLabel={label}>
          {options.find((option) => option.value === value)?.label ?? ""}
        </Button>
      }
      autofocusTarget="first-node"
      onClose={() => setOpen(false)}
    >
      <ActionList
        actionRole="menuitemradio"
        items={options.map((option) => ({
          content: option.label,
          active: option.value === value,
          onAction: () => {
            setOpen(false);
            onChange(option.value);
          },
        }))}
      />
    </Popover>
  );
}

/** "View all" opens the Reviews page — for the chosen app, or everything. */
function ViewAllLink({ apps, selectedAppId }: { apps: ReviewApp[]; selectedAppId: string }) {
  const selected = apps.find((app) => app.id === selectedAppId);
  return (
    <Button
      variant="plain"
      url={selected ? `/app/reviews?appId=${encodeURIComponent(selected.id)}` : "/app/reviews"}
    >
      {selected ? `View all for ${selected.name}` : "View all"}
    </Button>
  );
}

export function RecentReviewsCard({
  reviews,
  apps,
  now,
}: {
  reviews: RecentReview[];
  apps: ReviewApp[];
  /** Server's "now", so server and browser agree on "today". */
  now: string;
}) {
  const [appId, setAppId] = useState("");
  const [days, setDays] = useState<ReviewWindowDays>(30);
  const [rating, setRating] = useState<ReviewRatingFilter>("all");
  const today = useMemo(() => new Date(now), [now]);

  const visible = useMemo(
    () => filterRecentReviews(reviews, { appId, days, rating }, today),
    [reviews, appId, days, rating, today],
  );
  const appNames = useMemo(() => new Map(apps.map((app) => [app.id, app.name])), [apps]);

  return (
    <Card padding="0">
      <div className="overview-card__head">
        <div>
          <Text as="h2" variant="headingSm">
            Recent reviews
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {`${visible.length} review${visible.length === 1 ? "" : "s"} in the last ${days} days`}
          </Text>
        </div>
        <ViewAllLink apps={apps} selectedAppId={appId} />
      </div>
      <div className="overview-card__filters">
        <AppPicker label="App" labelHidden value={appId} apps={apps} onChange={setAppId} />
        <FilterMenu
          label="Period"
          value={days}
          options={REVIEW_WINDOW_DAYS.map((value) => ({ value, label: `Last ${value} days` }))}
          onChange={setDays}
        />
        <FilterMenu
          label="Rating"
          value={rating}
          options={(Object.keys(REVIEW_RATING_FILTERS) as ReviewRatingFilter[]).map((value) => ({
            value,
            label: REVIEW_RATING_FILTERS[value].label,
          }))}
          onChange={setRating}
        />
      </div>
      {visible.length === 0 ? (
        <div className="overview-card__empty">
          <Text as="p" tone="subdued">
            No reviews for this selection.
          </Text>
        </div>
      ) : (
        <ul className="overview-reviews">
          {visible.map((review) => (
            <li key={review.id} className="overview-review">
              <div className="overview-review__who">
                <span className="overview-review__name" title={review.reviewerName}>
                  {review.reviewerName}
                </span>
                <span className="overview-review__meta">
                  {reviewDaysAgoLabel(reviewDaysAgo(review.reviewedAt, today))}
                  {/* With every app shown, say which app it is about. */}
                  {appId ? null : ` · ${appNames.get(review.appId) ?? ""}`}
                </span>
              </div>
              <div className="overview-review__content">
                <ReviewStars rating={review.rating} />
                {review.body ? (
                  <p className="overview-review__body" title={review.body}>
                    {review.body}
                  </p>
                ) : (
                  <p className="overview-review__body overview-review__body--empty">
                    Rating only, no written review.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
