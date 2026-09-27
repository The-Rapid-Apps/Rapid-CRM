/**
 * The Trials report's history filter.
 *
 * Pure and separate from the route so it can be tested: this predicate is the
 * whole reason the table's search became trustworthy. It used to run in the
 * browser over whichever rows had been shipped — the newest 200 of up to ~41k
 * — so a genuine match outside that slice read as "no such trial". Free plans
 * are exactly that case: real, but a fraction of a percent of volume.
 */

/** Structural on purpose, so this file pulls in no server module. */
export interface FilterableTrial {
  shopDomain: string;
  planName: string;
  monthlyAmount: number;
  status: string;
}

export interface TrialHistoryFilter {
  /** Already trimmed and lower-cased by the caller. */
  query: string;
  /** A `TrialHistoryFact["status"]`, or "all". */
  status: string;
  paidOnly: boolean;
  /**
   * Shops whose CUSTOMER NAME matches the query.
   *
   * A store's name isn't on these rows — it lives in `identified_customers` /
   * `app_installs` — so it can't be matched by scanning them. The caller
   * resolves the matching domains once and passes them in; `null` means no
   * text query, which is different from "a query that matched no names".
   */
  matchingDomains: Set<string> | null;
}

export function filterTrialHistory<T extends FilterableTrial>(
  facts: T[],
  filter: TrialHistoryFilter,
): T[] {
  return facts.filter(
    (row) =>
      (filter.status === "all" || row.status === filter.status) &&
      /* "Paid" is a $0 test on the plan's monthly amount — the same one the
         charts' `paidOnly` fold uses, so the toolbar means one thing. */
      (!filter.paidOnly || row.monthlyAmount > 0) &&
      (!filter.query ||
        row.shopDomain.toLowerCase().includes(filter.query) ||
        row.planName.toLowerCase().includes(filter.query) ||
        filter.matchingDomains?.has(row.shopDomain) === true),
  );
}
