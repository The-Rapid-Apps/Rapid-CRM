import {
  Badge,
  BlockStack,
  Card,
  ChoiceList,
  EmptyState,
  Filters,
  IndexTable,
  InlineStack,
  Page,
  Pagination,
  Text,
  TextField,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/reviews";
import { AppName } from "~/components/app-identity";
import { AppPicker } from "~/components/app-picker";
import { ReviewStars } from "~/components/review-stars";
import { customerUrl } from "~/lib/app-events/types";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { formatDate } from "~/lib/format";
import { EMPTY_STATE_IMAGE } from "~/lib/ui";
import { SearchIcon } from "@shopify/polaris-icons";
import {
  ARCHIVE_FILTERS,
  parseReviewFilters,
  REPLY_FILTERS,
  reviewFiltersQuery,
  TIME_USING_BUCKETS,
  type ArchiveFilter,
  type ReplyFilter,
  type ReviewFilters,
  type TimeUsingBucket,
} from "~/lib/reviews/review-filters";
import { getFilteredReviews } from "~/lib/reviews/reviews-page.server";

const PAGE_SIZE = 20;

export const meta: Route.MetaFunction = () => [{ title: "Reviews" }];

export async function loader({ request }: Route.LoaderArgs) {
  const org = await requireCurrentOrganization(request);
  const filters = parseReviewFilters(new URL(request.url).searchParams);
  const { apps, appId, plans, total, rows } = await getFilteredReviews(org.id, filters);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(filters.page, totalPages);
  return {
    apps,
    plans,
    filters: { ...filters, appId, page },
    total,
    matching: rows.length,
    totalPages,
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  };
}

export default function Reviews({ loaderData }: Route.ComponentProps) {
  const { apps, plans, filters, total, matching, totalPages, rows } = loaderData;
  const navigate = useNavigate();
  const [query, setQuery] = useState(filters.q);

  // A new URL (back button, a filter chip) brings its own search text.
  useEffect(() => setQuery(filters.q), [filters.q]);

  /** Any filter change starts again at page 1. */
  const go = (next: Partial<ReviewFilters>) => {
    const search = reviewFiltersQuery({ ...filters, page: 1, ...next });
    navigate(`/app/reviews${search ? `?${search}` : ""}`, { preventScrollReset: true });
  };

  // Typing searches after a pause rather than on every keystroke.
  useEffect(() => {
    if (query === filters.q) return;
    const timer = setTimeout(() => go({ q: query }), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const showApp = !filters.appId;
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const exportUrl = `/app/reviews/export${
    reviewFiltersQuery({ ...filters, page: 1 }) ? `?${reviewFiltersQuery({ ...filters, page: 1 })}` : ""
  }`;

  const filterBar = [
    {
      key: "rating",
      label: "Star rating",
      pinned: true,
      filter: (
        <ChoiceList
          title="Star rating"
          titleHidden
          allowMultiple
          choices={[5, 4, 3, 2, 1].map((stars) => ({
            label: `${stars} star${stars === 1 ? "" : "s"}`,
            value: String(stars),
          }))}
          selected={filters.ratings.map(String)}
          onChange={(selected) => go({ ratings: selected.map(Number) })}
        />
      ),
    },
    {
      key: "time",
      label: "Time spent using app",
      pinned: true,
      filter: (
        <ChoiceList
          title="Time spent using app"
          titleHidden
          allowMultiple
          choices={(Object.keys(TIME_USING_BUCKETS) as TimeUsingBucket[]).map((key) => ({
            label: TIME_USING_BUCKETS[key].label,
            value: key,
          }))}
          selected={filters.timeUsing}
          onChange={(selected) => go({ timeUsing: selected as TimeUsingBucket[] })}
        />
      ),
    },
    {
      key: "after",
      label: "Written after",
      pinned: true,
      filter: (
        <TextField
          label="Written on or after"
          type="date"
          value={filters.after}
          onChange={(value) => go({ after: value })}
          autoComplete="off"
        />
      ),
    },
    {
      key: "before",
      label: "Written before",
      pinned: true,
      filter: (
        <TextField
          label="Written on or before"
          type="date"
          value={filters.before}
          onChange={(value) => go({ before: value })}
          autoComplete="off"
        />
      ),
    },
    {
      key: "plan",
      label: "Shopify plan",
      pinned: true,
      filter:
        plans.length === 0 ? (
          <Text as="p" tone="subdued">
            No plans known for these reviewers yet.
          </Text>
        ) : (
          <ChoiceList
            title="Shopify plan"
            titleHidden
            allowMultiple
            choices={plans.map((plan) => ({ label: plan, value: plan }))}
            selected={filters.plans}
            onChange={(selected) => go({ plans: selected })}
          />
        ),
    },
    {
      key: "reply",
      label: "Reply",
      pinned: true,
      filter: (
        <ChoiceList
          title="Reply"
          titleHidden
          choices={[
            { label: "Any", value: "" },
            ...(Object.keys(REPLY_FILTERS) as ReplyFilter[]).map((key) => ({
              label: REPLY_FILTERS[key],
              value: key,
            })),
          ]}
          selected={[filters.reply]}
          onChange={(selected) => go({ reply: (selected[0] ?? "") as ReplyFilter | "" })}
        />
      ),
    },
    {
      key: "archive",
      label: "Archive status",
      pinned: true,
      filter: (
        <ChoiceList
          title="Archive status"
          titleHidden
          choices={[
            { label: "Any", value: "" },
            ...(Object.keys(ARCHIVE_FILTERS) as ArchiveFilter[]).map((key) => ({
              label: ARCHIVE_FILTERS[key],
              value: key,
            })),
          ]}
          selected={[filters.archive]}
          onChange={(selected) => go({ archive: (selected[0] ?? "") as ArchiveFilter | "" })}
        />
      ),
    },
  ];

  const applied = [
    filters.ratings.length && {
      key: "rating",
      label: `Rating: ${[...filters.ratings].sort((a, b) => b - a).join(", ")}★`,
      onRemove: () => go({ ratings: [] }),
    },
    filters.timeUsing.length && {
      key: "time",
      label: `Using the app: ${filters.timeUsing.map((key) => TIME_USING_BUCKETS[key].label).join(", ")}`,
      onRemove: () => go({ timeUsing: [] }),
    },
    filters.after && {
      key: "after",
      label: `Written on or after ${formatDate(`${filters.after}T12:00:00Z`)}`,
      onRemove: () => go({ after: "" }),
    },
    filters.before && {
      key: "before",
      label: `Written on or before ${formatDate(`${filters.before}T12:00:00Z`)}`,
      onRemove: () => go({ before: "" }),
    },
    filters.plans.length && {
      key: "plan",
      label: `Plan: ${filters.plans.join(", ")}`,
      onRemove: () => go({ plans: [] }),
    },
    filters.reply && {
      key: "reply",
      label: REPLY_FILTERS[filters.reply],
      onRemove: () => go({ reply: "" }),
    },
    filters.archive && {
      key: "archive",
      label: ARCHIVE_FILTERS[filters.archive],
      onRemove: () => go({ archive: "" }),
    },
  ].filter((item): item is { key: string; label: string; onRemove: () => void } => Boolean(item));

  return (
    <Page
      title="Reviews"
      subtitle={
        matching === total
          ? `${total.toLocaleString()} reviews from the App Store`
          : `${matching.toLocaleString()} of ${total.toLocaleString()} reviews`
      }
      fullWidth
      secondaryActions={[
        {
          content: "Export",
          disabled: matching === 0,
          // A download, not a page: a full request so the browser saves the file.
          onAction: () => window.location.assign(exportUrl),
        },
      ]}
    >
      <BlockStack gap="400">
        <Card padding="0">
          {/* App picker left of the search, as one row. Polaris's Filters can
              only place extra content to the RIGHT of its own search field,
              so the search is ours and Filters shows just the chips below. */}
          <div className="reviews-page__toolbar">
            <AppPicker
              label="App"
              labelHidden
              value={filters.appId}
              apps={apps}
              onChange={(appId) => go({ appId, plans: [] })}
            />
            <div className="reviews-page__search">
              <TextField
                label="Search reviews"
                labelHidden
                prefix={<SearchIcon width={20} height={20} fill="currentColor" />}
                placeholder={`Search ${total.toLocaleString()} reviews`}
                value={query}
                onChange={setQuery}
                clearButton
                onClearButtonClick={() => {
                  setQuery("");
                  go({ q: "" });
                }}
                autoComplete="off"
              />
            </div>
          </div>
          <Filters
            hideQueryField
            queryValue={query}
            onQueryChange={setQuery}
            onQueryClear={() => undefined}
            filters={filterBar}
            appliedFilters={applied}
            onClearAll={() => {
              setQuery("");
              go({ ratings: [], timeUsing: [], after: "", before: "", plans: [], reply: "", archive: "", q: "" });
            }}
          />
          {apps.length === 0 ? (
            <EmptyState heading="No App Store listings set up" image={EMPTY_STATE_IMAGE}>
              <Text as="p" tone="subdued">
                Add an app&apos;s App Store handle on its settings page to start
                collecting its reviews.
              </Text>
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState heading="No reviews match these filters" image={EMPTY_STATE_IMAGE}>
              <Text as="p" tone="subdued">
                Try removing a filter or searching for something else.
              </Text>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "review", plural: "reviews" }}
              itemCount={rows.length}
              selectable={false}
              headings={[
                { title: "Date" },
                { title: "Customer" },
                ...(showApp ? [{ title: "App" }] : []),
                { title: "Shopify plan" },
                { title: "Rating" },
                { title: "Content" },
                { title: "Time spent using app" },
              ]}
            >
              {rows.map((row, index) => {
                const app = appsById.get(row.appId);
                return (
                  <IndexTable.Row id={row.id} key={row.id} position={index}>
                    <IndexTable.Cell>
                      <span className="reviews-page__date">
                        {formatDate(row.reviewedAt)}
                        {row.edited ? (
                          <span className="reviews-page__edited" title="Edited — this is the date of the edit">
                            ✎
                          </span>
                        ) : null}
                      </span>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="150" blockAlign="center" wrap={false}>
                      {row.shopDomain ? (
                        <Link
                          className="customer-primary-link"
                          to={customerUrl(row.appId, row.shopDomain)}
                          title={row.shopDomain}
                        >
                          {row.reviewerName}
                        </Link>
                      ) : (
                        // No single customer carries this store name.
                        <span>{row.reviewerName}</span>
                      )}
                      {row.archivedAt ? (
                        <span title={`No longer on the App Store listing since ${formatDate(row.archivedAt)}`}>
                          <Badge size="small">Archived</Badge>
                        </span>
                      ) : null}
                      </InlineStack>
                    </IndexTable.Cell>
                    {showApp ? (
                      <IndexTable.Cell>
                        <AppName appName={app?.name ?? ""} logoUrl={app?.logoUrl ?? null} />
                      </IndexTable.Cell>
                    ) : null}
                    <IndexTable.Cell>{row.shopifyPlan ?? "—"}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <ReviewStars rating={row.rating} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <div className="reviews-page__content">
                        {row.body ? (
                          <span className="reviews-page__body" title={row.body}>
                            {row.body}
                          </span>
                        ) : (
                          <span className="reviews-page__body reviews-page__body--empty">
                            Rating only
                          </span>
                        )}
                        {row.replyBody ? (
                          <span className="reviews-page__replied" title={row.replyBody}>
                            ↩ Replied
                          </span>
                        ) : null}
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.timeUsingApp?.replace(/ using the app$/i, "") ?? "—"}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>

        {totalPages > 1 ? (
          <InlineStack align="center">
            <Pagination
              hasPrevious={filters.page > 1}
              hasNext={filters.page < totalPages}
              onPrevious={() => go({ page: filters.page - 1 })}
              onNext={() => go({ page: filters.page + 1 })}
              label={`Page ${filters.page} of ${totalPages}`}
            />
          </InlineStack>
        ) : null}
      </BlockStack>
    </Page>
  );
}
