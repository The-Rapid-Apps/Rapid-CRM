import { SkeletonDisplayText } from "@shopify/polaris";
import { Link } from "react-router";

/**
 * The dashboard's KPI tile, extracted from the Overview page so every section can
 * lead with its figures the same way.
 *
 * The class names stay `overview-*` on purpose: they are defined once in
 * app/app.css, including the `html[data-theme="dark"]` overrides and the
 * responsive rules, and renaming them would mean editing three places to change
 * nothing a user can see.
 *
 * `href` is optional here, unlike the Overview's own copy. A figure that has
 * somewhere to go should link there — but a tile on the page it would link
 * to should not, since a tile that navigates to itself is worse than one that
 * does not move.
 */
export interface MetricTileProps {
  label: string;
  value: string | number | null | undefined;
  detail?: string;
  loading?: boolean;
  href?: string;
}

export function MetricTile({
  label,
  value,
  detail,
  loading,
  href,
}: MetricTileProps) {
  const body = (
    <div className="overview-metric">
      <span className="overview-metric-label">{label}</span>
      <div className="overview-metric-value">
        {loading ? <SkeletonDisplayText size="medium" /> : (value ?? "—")}
      </div>
      {detail ? <span className="overview-metric-detail">{detail}</span> : null}
    </div>
  );

  if (!href) return body;
  return (
    <Link className="overview-metric-link" to={href}>
      {body}
    </Link>
  );
}
