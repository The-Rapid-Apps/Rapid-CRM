/** Client-safe formatters for the dashboard (no server imports). */

export function formatMoney(amount: string | number, currency = "USD"): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number.isFinite(n) ? n : 0);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/**
 * "2 hours ago" for recent instants; falls back to the absolute date once the
 * instant is older than ~7 days (past that, relative labels stop being useful).
 */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  const diffSeconds = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return "just now";
  if (abs > 7 * 24 * 3600) return formatDate(d);
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (abs >= seconds) return RELATIVE.format(Math.round(diffSeconds / seconds), unit);
  }
  return "just now";
}

export type StatusTone = "success" | "info" | "attention" | "warning" | "critical" | undefined;

/** Map a subscription status to a Polaris Badge tone. */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "PENDING":
      return "attention";
    case "FROZEN":
      return "warning";
    case "CANCELLED":
    case "DECLINED":
    case "EXPIRED":
      return "critical";
    default:
      return undefined;
  }
}
