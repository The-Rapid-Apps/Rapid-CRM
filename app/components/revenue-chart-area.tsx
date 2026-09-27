import { useId } from "react";

/** Fill measured revenue to zero, including below-zero growth rates. */
export function RevenueChartArea({
  values,
  xScale,
  yScale,
  drawableHeight,
}: {
  values: number[];
  xScale: (value: number) => number;
  yScale: (value: number) => number;
  drawableHeight: number;
}) {
  const gradientId = useId();
  if (values.length < 2) return null;
  const baseline = yScale(0);
  const path = [
    `M ${xScale(0)} ${baseline}`,
    ...values.map((value, index) => `L ${xScale(index)} ${yScale(value)}`),
    `L ${xScale(values.length - 1)} ${baseline} Z`,
  ].join(" ");

  return (
    <g aria-hidden="true" pointerEvents="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2={drawableHeight}
          gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#9364ff" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#9364ff" stopOpacity="0.025" />
        </linearGradient>
      </defs>
      <path d={path} fill={`url(#${gradientId})`} />
    </g>
  );
}
