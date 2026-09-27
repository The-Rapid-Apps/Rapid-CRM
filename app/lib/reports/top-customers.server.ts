import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "~/lib/db.server";
import { resolveCustomerNames } from "~/lib/customer-name.server";

/**
 * The Overview's "Top customers" card: biggest lifetime spenders, with the
 * average monthly revenue behind that total.
 *
 * Ranked from sale facts rather than `PartnerCustomerState`, because lifetime
 * value and months billed both span a shop's whole relationship — reading them
 * off current state would forget every plan they were on before this one.
 */

export type TopCustomerStatus = "active" | "churned" | "all";

export interface TopCustomer {
  shopDomain: string;
  name: string;
  /**
   * AMR — lifetime value over months billed, an annual payment counting as
   * twelve. The same definition the observed-plan subscriber list uses; see
   * `ObservedPlanSubscriber.amount` for why it is not "what they pay today".
   */
  amr: number;
  clv: number;
}

export async function getTopCustomers(params: {
  appIds: string[];
  status?: TopCustomerStatus;
  limit?: number;
}): Promise<TopCustomer[]> {
  const { appIds } = params;
  const status = params.status ?? "active";
  const limit = params.limit ?? 8;
  if (appIds.length === 0) return [];

  /* Active = holds at least one live charge right now. Churned is its exact
     complement over shops that have ever paid, so the two partition the "all"
     list rather than overlapping or leaving a gap. */
  const activeExists = Prisma.sql`
    EXISTS (
      SELECT 1 FROM partner_customer_states c
      WHERE c.shopDomain = s.shopDomain
        AND c.appId IN (${Prisma.join(appIds)})
        AND c.activeChargeCount > 0
    )`;
  const statusFilter =
    status === "active"
      ? Prisma.sql`AND ${activeExists}`
      : status === "churned"
        ? Prisma.sql`AND NOT ${activeExists}`
        : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{ shopDomain: string; clv: number; months: number }>
  >`
    SELECT s.shopDomain AS shopDomain,
           SUM(s.grossAmount) AS clv,
           SUM(CASE WHEN s.billingInterval = 'ANNUAL' THEN 12 ELSE 1 END) AS months
    FROM partner_subscription_sale_facts s
    WHERE s.appId IN (${Prisma.join(appIds)})
      AND s.shopDomain IS NOT NULL
      /* Shopify replaces a GDPR-erased shop's domain with the literal string
         "REDACTED" — thousands of sale facts carry it. Grouping by domain
         would fold them into one "customer" whose lifetime value tops the
         list and belongs to nobody. */
      AND s.shopDomain <> 'REDACTED'
      ${statusFilter}
    GROUP BY s.shopDomain
    ORDER BY clv DESC
    LIMIT ${limit}`;

  const names = await resolveCustomerNames(rows.map((row) => row.shopDomain));

  return rows.map((row) => {
    const clv = Number(row.clv);
    const months = Number(row.months) || 1;
    return {
      shopDomain: row.shopDomain,
      name:
        names.get(row.shopDomain) ??
        row.shopDomain.replace(/\.myshopify\.com$/, ""),
      amr: clv / months,
      clv,
    };
  });
}
