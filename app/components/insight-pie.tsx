import { useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A pie with percentages inside the big slices and names outside on leader
 * lines — the Traffic source insights layout, as Mantle draws it.
 *
 * Hand-drawn SVG because polaris-viz has no pie that places labels outside the
 * slices; its donut only offers a legend beside the chart.
 *
 * Two deliberate departures from Mantle, both from the charting rules rather
 * than taste:
 *
 * - Only the top eight values get a colour; the tail folds into a grey
 *   "Other". Mantle draws ~25 slices but can only label about eight — the rest
 *   are hairlines nobody can identify, and past eight categorical colours
 *   neighbours stop being distinguishable.
 * - The palette is Mantle's order with one fix. Its first two slices, purple
 *   beside blue, measure ΔE 1.3 for deuteranopes and 12.0 even with normal
 *   vision — and those are the two biggest slices on every pie. See the
 *   `--insight-*` tokens in app.css for the validated order.
 */

export interface PieDatum {
  value: string;
  count: number;
}

/** Past this many colours, adjacent slices stop being told apart. */
const MAX_COLOURED = 8;
/** A slice needs this share before its percentage fits inside it. */
const INNER_LABEL_SHARE = 0.07;
/** Below this share a slice is a hairline; naming it only causes collisions. */
const OUTER_LABEL_SHARE = 0.015;

/* Sized for TWO pies per row (see `.insight-grid`). Everything in the SVG
   scales with the card, text included, so the canvas is matched to the card
   rather than the pie simply scaled up: on a ~720px card this renders the pie
   ~360px across (Mantle's is ~340px) with labels near 14px. Kept at the
   three-column canvas, two columns would have pushed labels to ~19px.

   The pie is half the canvas width, leaving ~130 units either side for the
   names on leader lines — room for full terms like "facebook pixel". */
const WIDTH = 600;
const HEIGHT = 380;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const R = 150;
/** Horizontal gap from the pie's edge to where an outside label starts. */
const LABEL_OFFSET = 18;
/** Minimum vertical distance between two outside labels on the same side. */
const LABEL_GAP = 16;
const LABEL_MAX_CHARS = 20;

interface Arc {
  label: string;
  count: number;
  share: number;
  start: number;
  end: number;
  colour: string;
  isOther: boolean;
  /** For "Other": how many values it folds together. */
  folded: number;
}

function buildArcs(data: PieDatum[], total: number): Arc[] {
  const head = data.slice(0, MAX_COLOURED);
  const tail = data.slice(MAX_COLOURED).reduce((n, d) => n + d.count, 0);
  const items = head.map((d, i) => ({
    label: d.value,
    count: d.count,
    colour: `var(--insight-${i + 1})`,
    isOther: false,
    folded: 1,
  }));
  if (tail > 0) {
    items.push({
      label: "Other",
      count: tail,
      colour: "var(--insight-other)",
      isOther: true,
      folded: data.length - MAX_COLOURED,
    });
  }
  // 12 o'clock, clockwise, biggest first — the order Mantle reads in.
  let angle = -Math.PI / 2;
  return items.map((item) => {
    const share = item.count / total;
    const start = angle;
    angle += share * Math.PI * 2;
    return { ...item, share, start, end: angle };
  });
}

function point(radius: number, angle: number) {
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
}

/**
 * The pale band just outside a hovered slice — Mantle's way of lifting the
 * slice the tooltip is describing. An annular sector from `inner` to `outer`.
 */
function haloPath(start: number, end: number, inner: number, outer: number) {
  const a = point(outer, start);
  const b = point(outer, end);
  const c = point(inner, end);
  const d = point(inner, start);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${a.x} ${a.y} A ${outer} ${outer} 0 ${large} 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${inner} ${inner} 0 ${large} 0 ${d.x} ${d.y} Z`;
}

function slicePath(start: number, end: number): string {
  // A single value is the whole disc, and an arc from a point back to itself
  // draws nothing — so it is drawn as two halves.
  if (end - start >= Math.PI * 2 - 1e-6) {
    return `M ${CX} ${CY - R} A ${R} ${R} 0 1 1 ${CX} ${CY + R} A ${R} ${R} 0 1 1 ${CX} ${CY - R} Z`;
  }
  const a = point(R, start);
  const b = point(R, end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${CX} ${CY} L ${a.x} ${a.y} A ${R} ${R} 0 ${large} 1 ${b.x} ${b.y} Z`;
}

function truncate(text: string): string {
  return text.length > LABEL_MAX_CHARS
    ? `${text.slice(0, LABEL_MAX_CHARS - 1)}…`
    : text;
}

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

interface OuterLabel {
  arcIndex: number;
  text: string;
  side: "left" | "right";
  anchor: { x: number; y: number };
  elbow: { x: number; y: number };
  y: number;
}

/**
 * Names outside the pie, pushed apart so neighbours never overlap.
 *
 * Small adjacent slices put their natural label positions a few pixels apart;
 * drawn as-is they stack into an unreadable smear. Each side is sorted by
 * height and nudged down until every pair clears `LABEL_GAP`, then pulled back
 * up if that pushed the last one off the bottom. The leader line still starts
 * at the slice's true angle, so the eye can follow it home.
 */
function layoutOuterLabels(arcs: Arc[]): OuterLabel[] {
  const labels: OuterLabel[] = arcs.flatMap((arc, arcIndex) => {
    if (arc.share < OUTER_LABEL_SHARE) return [];
    const mid = (arc.start + arc.end) / 2;
    const anchor = point(R + 2, mid);
    const elbow = point(R + 12, mid);
    return [
      {
        arcIndex,
        text: truncate(arc.label),
        side: Math.cos(mid) >= 0 ? ("right" as const) : ("left" as const),
        anchor,
        elbow,
        y: elbow.y,
      },
    ];
  });

  for (const side of ["left", "right"] as const) {
    const column = labels
      .filter((label) => label.side === side)
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i += 1) {
      column[i].y = Math.max(column[i].y, column[i - 1].y + LABEL_GAP);
    }
    const overflow = column.length
      ? column[column.length - 1].y - (HEIGHT - 10)
      : 0;
    if (overflow > 0) {
      for (const label of column) label.y -= overflow;
      for (let i = column.length - 2; i >= 0; i -= 1) {
        column[i].y = Math.min(column[i].y, column[i + 1].y - LABEL_GAP);
      }
    }
  }
  return labels;
}

const formatCount = (value: number) => value.toLocaleString();

export function InsightPie({
  data,
  total,
  title,
  valueLabel = "Count",
  formatValue = formatCount,
  additive = true,
  emptyText = "No data for this period.",
}: {
  data: PieDatum[];
  total: number;
  /** Names the chart for assistive tech; the card shows it visibly. */
  title: string;
  /** What a slice's number is — "Count", "Average CLV"… */
  valueLabel?: string;
  formatValue?: (value: number) => string;
  /** False for averages and medians: "Other" then gets no value of its own,
   * since the sum of several averages is not a figure anyone can use. */
  additive?: boolean;
  emptyText?: string;
}) {
  const tableId = useId();
  const arcs = useMemo(
    () => (total > 0 ? buildArcs(data, total) : []),
    [data, total],
  );
  const labels = useMemo(() => layoutOuterLabels(arcs), [arcs]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{
    index: number;
    left: number;
    top: number;
    /** Too close to the top of the window to fit above: show it below. */
    below: boolean;
  } | null>(null);

  /* Anchored to the SLICE, as Mantle does, not to the cursor: just outside
     the slice's edge at its middle angle. It stays put while the pointer moves
     within the slice, instead of chasing it. SVG units are mapped to the
     window through the rendered size, since the SVG scales with its card. */
  const hoverSlice = (index: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const arc = arcs[index];
    const at = point(R + 14, (arc.start + arc.end) / 2);
    const top = rect.top + (at.y / HEIGHT) * rect.height;
    setHover({
      index,
      left: rect.left + (at.x / WIDTH) * rect.width,
      top,
      below: top < 110,
    });
  };

  if (total === 0) {
    return (
      <div className="insight-pie-empty">
        <span>{emptyText}</span>
      </div>
    );
  }

  const hovered = hover ? (arcs[hover.index] ?? null) : null;

  return (
    <>
      <svg
        ref={svgRef}
        className="insight-pie"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}: ${arcs
          .slice(0, 3)
          .map((arc) => `${arc.label} ${percent(arc.share)}`)
          .join(", ")}`}
        aria-describedby={tableId}
        onMouseLeave={() => setHover(null)}
      >
        {arcs.map((arc, index) => (
          <path
            key={arc.label}
            d={slicePath(arc.start, arc.end)}
            fill={arc.colour}
            className="insight-pie__slice"
            /* Everything but the hovered slice recedes, so the eye lands on
               the one the tooltip is describing. */
            opacity={hover && hover.index !== index ? 0.35 : 1}
            onMouseEnter={() => hoverSlice(index)}
          >
            <title>
              {arc.isOther && !additive
                ? `${arc.label}: ${percent(arc.share)}`
                : `${arc.label}: ${formatValue(arc.count)} (${percent(arc.share)})`}
            </title>
          </path>
        ))}

        {hovered && hovered.end - hovered.start < Math.PI * 2 - 1e-6 ? (
          <path
            d={haloPath(hovered.start, hovered.end, R + 3, R + 12)}
            fill={hovered.colour}
            className="insight-pie__halo"
          />
        ) : null}

        {arcs.map((arc, index) => {
          if (arc.share < INNER_LABEL_SHARE) return null;
          const at = point(R * 0.62, (arc.start + arc.end) / 2);
          return (
            <text
              key={`pct-${arc.label}`}
              x={at.x}
              y={at.y}
              className="insight-pie__percent"
              opacity={hover && hover.index !== index ? 0.35 : 1}
            >
              {percent(arc.share)}
            </text>
          );
        })}

        {labels.map((label) => {
          const x =
            label.side === "right"
              ? CX + R + LABEL_OFFSET
              : CX - R - LABEL_OFFSET;
          return (
            <g
              key={`label-${label.arcIndex}`}
              opacity={hover && hover.index !== label.arcIndex ? 0.35 : 1}
            >
              <polyline
                className="insight-pie__leader"
                stroke={arcs[label.arcIndex].colour}
                points={`${label.anchor.x},${label.anchor.y} ${label.elbow.x},${label.elbow.y} ${label.side === "right" ? x - 4 : x + 4},${label.y}`}
              />
              <text
                x={x}
                y={label.y}
                className="insight-pie__label"
                textAnchor={label.side === "right" ? "start" : "end"}
              >
                {label.text}
              </text>
            </g>
          );
        })}
      </svg>

      {/* The same numbers as a table, for screen readers — the pie alone
          encodes the values only as angles and colours. Hidden via a wrapping
          DIV, never the table itself: see `.insight-pie__sr` in app.css. */}
      <div className="insight-pie__sr">
      <table id={tableId}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Value</th>
            <th scope="col">{valueLabel}</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.value}>
              <th scope="row">{datum.value}</th>
              <td>{formatValue(datum.count)}</td>
              <td>{percent(datum.count / total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {hovered && hover && typeof document !== "undefined"
        ? createPortal(
            <div
              className="insight-tooltip"
              style={{
                left: hover.left,
                top: hover.top,
                /* Centred on the anchor, sitting above the slice — or below
                   it when there's no room above. Done with a transform so the
                   tooltip's own size never has to be measured. */
                transform: hover.below
                  ? "translate(-50%, 12px)"
                  : "translate(-50%, calc(-100% - 12px))",
              }}
            >
              <div className="insight-tooltip__title">
                {hovered.isOther
                  ? `Other (${hovered.folded.toLocaleString()} values)`
                  : hovered.label}
              </div>
              {hovered.isOther && !additive ? null : (
                <div className="insight-tooltip__row">
                  <span>{valueLabel}</span>
                  <strong>{formatValue(hovered.count)}</strong>
                </div>
              )}
              <div className="insight-tooltip__row">
                <span>Percentage</span>
                <strong>{percent(hovered.share)}</strong>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
