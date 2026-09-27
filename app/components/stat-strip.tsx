import { Icon } from "@shopify/polaris";
import { Link } from "react-router";
import type { CSSProperties, FunctionComponent, SVGProps } from "react";

/**
 * A row of headline figures in one card, icon beside each.
 *
 * Distinct from `MetricTile` on purpose: a tile is a large, clickable card that
 * dominates a page, and five of them across the top of a page push the content
 * below the fold. This is the compact arrangement — one card, one row, one
 * glance.
 *
 * A stat links only when it has somewhere else to go: a figure that navigates to
 * the page it is already on is worse than one that does not move.
 */
export interface Stat {
  label: string;
  value: string;
  /** Second line, for the qualifier a figure needs to be read correctly. */
  detail?: string;
  icon: FunctionComponent<SVGProps<SVGSVGElement>>;
  href?: string;
}

export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    /*
      The column count comes from the data, not from a breakpoint guess. `auto-fit`
      packs as many as fit and wraps the remainder, which with five stats and room for
      four leaves one tile alone under a stretch of empty card — a layout that reads as
      broken rather than as five figures. An explicit count divides the row evenly at
      any width, and the media queries below step it down rather than orphaning.
    */
    <div
      className="stat-strip"
      style={{ "--stat-strip-cols": stats.length } as CSSProperties}
    >
      {stats.map((stat) => {
        const body = (
          <>
            <span className="stat-strip-icon" aria-hidden="true">
              <Icon source={stat.icon} tone="subdued" />
            </span>
            <span className="stat-strip-text">
              <span className="stat-strip-label">{stat.label}</span>
              <span className="stat-strip-value">{stat.value}</span>
              {stat.detail ? (
                <span className="stat-strip-detail">{stat.detail}</span>
              ) : null}
            </span>
          </>
        );

        return stat.href ? (
          <Link className="stat-strip-item" to={stat.href} key={stat.label}>
            {body}
          </Link>
        ) : (
          <div className="stat-strip-item" key={stat.label}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
