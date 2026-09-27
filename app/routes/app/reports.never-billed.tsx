import { useMemo, useState } from "react";
import {
  BlockStack,
  Card,
  IndexTable,
  InlineGrid,
  Page,
  Pagination,
  Text,
  TextField,
} from "@shopify/polaris";
import type { Route } from "./+types/reports.never-billed";
import { requireUser } from "~/lib/auth/session.server";
import { requireCurrentOrganization } from "~/lib/current-org.server";
import { AppPicker } from "~/components/app-picker";
import { prisma } from "~/lib/db.server";
import { formatMoney } from "~/lib/format";
import { listNeverBilledPastDueCharges } from "~/lib/shopify/partner-mrr.server";
import { useBackAction } from "~/lib/use-back-action";

/** Matches the reports' own tables; enough to scan, short enough to skim. */
const PAGE_SIZE = 15;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const org = await requireCurrentOrganization(request);
  const url = new URL(request.url);

  const apps = await prisma.app.findMany({
    where: { organizationId: org.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, logoUrl: true },
  });

  const requestedAppId = url.searchParams.get("appId")?.trim() ?? "";
  const appId = apps.some((app) => app.id === requestedAppId)
    ? requestedAppId
    : (apps[0]?.id ?? "");

  /* Every charge, unfiltered and unpaged. Searching and paging happen in the
     browser, and this is why: `listNeverBilledPastDueCharges` has to load the
     app's whole event+sale history to decide which charges qualify, so the
     server has no cheaper answer for "just page 2" than for all of it.

     Its Redis cache does not help either — `factsCacheKey` includes
     `periodEnd.toISOString()` at millisecond precision and the default `at` is
     `new Date()`, so every request is a fresh key and a guaranteed miss. (The
     traffic report hit the same trap and fixed it by flooring the timestamp to
     the cache window; this path never got that treatment.)

     Sending the rows once and filtering locally therefore turns a
     seconds-per-keystroke round trip into an instant one, at the cost of a
     payload that is 127 rows for the largest app today. */
  const charges = appId ? await listNeverBilledPastDueCharges(appId) : [];

  return { apps, appId, charges };
}

export function meta() {
  return [{ title: "Never billed · Rapid" }];
}

export default function NeverBilledReport({ loaderData }: Route.ComponentProps) {
  const { apps, appId, charges: allCharges } = loaderData;
  const backAction = useBackAction({
    content: "Reports",
    url: `/app/reports?report=growth${appId ? `&appId=${appId}` : ""}`,
  });
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const needle = q.trim().toLowerCase();
  const charges = useMemo(
    () =>
      needle
        ? allCharges.filter((charge) =>
            charge.shopDomain.toLowerCase().includes(needle),
          )
        : allCharges,
    [allCharges, needle],
  );

  const totalPages = Math.max(1, Math.ceil(charges.length / PAGE_SIZE));
  /* Clamped on read rather than reset in an effect: narrowing a search while
     on page 5 would otherwise render an empty table for a frame before the
     effect fired. */
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const shown = charges.slice(start, start + PAGE_SIZE);

  return (
    <Page
      fullWidth
      /* Reached from the Recurring revenue section of the MRR report, so the
         arrow goes back there rather than to the reports index — and it carries
         the app through, so returning lands on the report you left. */
      backAction={backAction}
      title="Never billed"
      subtitle="Active charges currently contributing $0 to MRR because their shop has never paid on any charge for this app and the current one is 30+ days past due with no sale — real Shopify behavior (a slow first invoice, or a manual permanent discount), not a rendering bug."
    >
      <BlockStack gap="400">
        <Card>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
            {/* Filters as you type, with no button and no navigation — the
                rows are already here (see the loader). Any new search returns
                to page 1, or you would be looking at page 4 of a result set
                that now has one page. */}
            <TextField
              label="Search by shop domain"
              labelHidden
              placeholder="Search by shop domain…"
              value={q}
              onChange={(value) => {
                setQ(value);
                setPage(1);
              }}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => {
                setQ("");
                setPage(1);
              }}
            />
            {/* main's shared picker, kept over the plain Select this file used
                before — it carries the app logos the rest of Reports shows. */}
            <AppPicker
              label="App"
              labelHidden
              allowAll={false}
              apps={apps}
              value={appId}
              onChange={(value) => {
                // The one control that still needs the server: a different app
                // is a different fact load.
                const params = new URLSearchParams(window.location.search);
                params.set("appId", value);
                window.location.search = params.toString();
              }}
            />
          </InlineGrid>
        </Card>

        <Card padding="0">
          <IndexTable
            resourceName={{ singular: "charge", plural: "charges" }}
            itemCount={shown.length}
            selectable={false}
            emptyState={
              <div style={{ padding: 24 }}>
                <Text as="p" tone="subdued">
                  {needle
                    ? `No zeroed charges for a shop matching “${q.trim()}”.`
                    : "No charges are currently being zeroed for this app."}
                </Text>
              </div>
            }
            headings={[
              { title: "Shop" },
              { title: "Charge" },
              { title: "Billing on" },
              { title: "Days overdue" },
              { title: "Listed amount" },
            ]}
          >
            {shown.map((charge, index) => (
              <IndexTable.Row
                id={charge.chargePlatformId}
                key={charge.chargePlatformId}
                position={index}
              >
                <IndexTable.Cell>{charge.shopDomain}</IndexTable.Cell>
                <IndexTable.Cell>{charge.chargeName}</IndexTable.Cell>
                <IndexTable.Cell>
                  {new Date(charge.billingOn).toLocaleDateString()}
                </IndexTable.Cell>
                <IndexTable.Cell>{charge.daysOverdue.toLocaleString()}</IndexTable.Cell>
                <IndexTable.Cell>
                  {formatMoney(charge.listedAmount, charge.currencyCode)}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
          {totalPages > 1 ? (
            <div className="never-billed-pagination">
              <Pagination
                hasPrevious={safePage > 1}
                onPrevious={() => setPage(safePage - 1)}
                hasNext={safePage < totalPages}
                onNext={() => setPage(safePage + 1)}
                label={`${(start + 1).toLocaleString()}–${Math.min(
                  start + PAGE_SIZE,
                  charges.length,
                ).toLocaleString()} of ${charges.length.toLocaleString()}`}
              />
            </div>
          ) : null}
        </Card>
      </BlockStack>
    </Page>
  );
}
