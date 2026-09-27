/**
 * The report index's own contents, in one place.
 *
 * Extracted from reports.tsx so the workspace search can offer reports as a
 * result group without importing a route module (and without keeping a second
 * copy of these labels that would quietly drift from the page they describe).
 * Client-safe: plain data, no Prisma, no server imports.
 */
export const REPORTS = [
  "traffic",
  "insights",
  "revenue",
  "growth",
  "ltv",
  "churn",
  "retention",
  "usage",
] as const;

export type ReportName = (typeof REPORTS)[number];

export const REPORT_META: Record<
  ReportName,
  { label: string; description: string }
> = {
  traffic: {
    label: "Traffic source trends",
    description:
      "View trends in how different campaigns, search terms, and other traffic sources are performing over time.",
  },
  insights: {
    label: "Traffic source insights",
    description:
      "See where each event comes from — page type, search term, medium, language and country — at a glance.",
  },
  revenue: {
    label: "Earnings",
    description:
      "Dig deeper into your revenue streams and how much you're getting paid.",
  },
  growth: {
    label: "Monthly recurring revenue",
    description: "Explore how your MRR is growing and shrinking over time.",
  },
  ltv: {
    label: "Subscriptions",
    description:
      "Understand how many active subscriptions you have, and metrics such as ARPU and LTV.",
  },
  churn: {
    label: "Churn",
    description:
      "Understand and track how your churn rate is changing over time.",
  },
  retention: {
    label: "Retention",
    description:
      "Visualize how much revenue and how many customers you're retaining over time.",
  },
  usage: {
    label: "Trials",
    description:
      "Get an overview of trial conversion rate, recent trial conversions, and trial cancellations.",
  },
};
