/**
 * The MRR-movement vocabulary, shared by the server reports and the client panel.
 *
 * Client-safe half, split out for the reason the `*.shared.ts` convention
 * exists: `MRR_MOVEMENT_ROWS` is a VALUE the Reports panel renders, and
 * importing a value from `analytics.server.ts` inside a component pulls that
 * whole server module — Prisma and all — into the client bundle. React Router
 * only strips server code from `loader`/`action`/`middleware`/`headers`, so
 * `npm run typecheck` passes and `npm run build` is what fails.
 */

/** The category keys that carry money — excludes the period bounds. */
export type MrrMovementCategory =
  | "new"
  | "reactivation"
  | "expansion"
  | "contraction"
  | "churn"
  | "frozen"
  | "unfrozen";

/**
 * One period's movement figures. `periodStart`/`periodEnd` are absent on the
 * whole-range total, which is otherwise the same shape so the table's Total
 * column needs no second type.
 */
export interface MrrMovementBucket {
  periodStart?: string;
  periodEnd?: string;
  new: number;
  reactivation: number;
  expansion: number;
  contraction: number;
  churn: number;
  frozen: number;
  unfrozen: number;
  /**
   * A DISCLOSURE, not a category: already counted inside `new`, reporting how
   * much of it is really first-period plan shopping. Adding it to the others
   * would double-count.
   */
  earlyPlanChange: number;
  /** gains - losses. Equals the change in MRR the level reports, to ~0.2%. */
  net: number;
}

export interface MrrMovementSummary {
  currency: string;
  /** One entry per chart bucket, in range order — Mantle's month columns. */
  buckets: MrrMovementBucket[];
  /** The whole range. Summed from the buckets, so the Total column closes. */
  total: MrrMovementBucket;
}

/**
 * Display order and sign for the movement table, in Mantle's own row order:
 * gains first, then losses, then Net. `loss` is what makes a row render
 * negative — every stored column is positive, and the sign is applied at the
 * point of display so the chart and the table cannot disagree about direction.
 *
 * Annotated rather than `as const satisfies`, so `loss` is optional-on-every-row
 * instead of absent from the gain rows' narrowed types.
 */
export const MRR_MOVEMENT_ROWS: ReadonlyArray<{
  key: MrrMovementCategory;
  label: string;
  loss?: true;
}> = [
  { key: "new", label: "New" },
  { key: "expansion", label: "Expansion" },
  { key: "reactivation", label: "Reactivation" },
  { key: "unfrozen", label: "Unfrozen" },
  { key: "churn", label: "Churn", loss: true },
  { key: "contraction", label: "Contraction", loss: true },
  { key: "frozen", label: "Frozen", loss: true },
];

export const EMPTY_MRR_MOVEMENT_BUCKET: MrrMovementBucket = {
  new: 0,
  reactivation: 0,
  expansion: 0,
  contraction: 0,
  churn: 0,
  frozen: 0,
  unfrozen: 0,
  earlyPlanChange: 0,
  net: 0,
};

/** gains - losses, from a bucket's own figures. One definition, used by both paths. */
export function mrrMovementNet(bucket: MrrMovementBucket): number {
  return (
    bucket.new +
    bucket.reactivation +
    bucket.expansion +
    bucket.unfrozen -
    bucket.churn -
    bucket.contraction -
    bucket.frozen
  );
}

/**
 * One plan's MRR over the chart buckets — Mantle's "Top plans by MRR".
 *
 * A plan is the charge's `chargeName` as Shopify reported it at that instant,
 * not a local Plan row: the Partner feed is the only place a charge's plan name
 * exists for merchants who never went through this platform's own billing.
 */
export interface PlanMrrSeries {
  plan: string;
  currency: string;
  /** Aligned 1:1 with the recurring `timeSeries` buckets, in range order. */
  points: Array<{ periodStart: string; mrr: number }>;
  /** MRR at the last bucket, which is what the card ranks and headlines. */
  current: number;
  /** current - first bucket, for the card's up/down figure. */
  change: number;
}

