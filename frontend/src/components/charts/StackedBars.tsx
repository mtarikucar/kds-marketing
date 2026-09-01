import { useMemo, useState } from 'react';
import {
  ChartFrame,
  ChartLegend,
  ChartDataTable,
  ChartTooltip,
  useChartWidth,
  fullNumber,
} from './ChartFrame';
import { seriesVar } from './palette';

export interface BarCategory {
  key: string;
  label: string;
  /** One value per label, same length and order. */
  values: number[];
  colorVar?: string;
}

export interface StackedBarsProps {
  labels: string[];
  categories: BarCategory[];
  title: React.ReactNode;
  value?: React.ReactNode;
  caption?: React.ReactNode;
  action?: React.ReactNode;
  isLoading?: boolean;
  emptyText?: string;
  height?: number;
  formatLabel?: (label: string) => string;
  formatValue?: (n: number) => string;
  ariaLabel: string;
  tableCaption?: string;
  className?: string;
}

/**
 * A rect with its two TOP corners rounded and its bottom edge square.
 *
 * The radius is clamped to half the width and to the height, so a one-pixel
 * sliver of a bar degrades to a plain rectangle instead of folding in on itself.
 */
function topRoundedPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return [
    `M${x},${y + h}`,
    `V${y + rr}`,
    `A${rr},${rr} 0 0 1 ${x + rr},${y}`,
    `H${x + w - rr}`,
    `A${rr},${rr} 0 0 1 ${x + w},${y + rr}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

const PAD = { top: 10, right: 4, bottom: 18, left: 4 };
/** Bars are capped rather than made to fill their slot; the leftover is air. */
const MAX_BAR = 24;
/** The surface gap that separates touching marks — stack segments and neighbours alike. */
const GAP = 2;
const RADIUS = 4;

/**
 * Day buckets, each a stack of categories.
 *
 * Separation is done with SURFACE, not with strokes: a 2px gap in the background
 * colour between every touching pair — between the segments of one stack and
 * between adjacent columns — at one consistent width. Outlining each segment
 * instead would add ink that encodes nothing, and at this bar width the outline
 * would be a meaningful fraction of the mark.
 *
 * Only the top segment of a stack gets rounded corners, and only on its top
 * edge: the data-end is rounded, the baseline is square. A rounded bottom would
 * lift the mark off the axis it is measured from.
 */
export function StackedBars({
  labels,
  categories,
  title,
  value,
  caption,
  action,
  isLoading,
  emptyText,
  height = 150,
  formatLabel,
  formatValue,
  ariaLabel,
  tableCaption,
  className,
}: StackedBarsProps) {
  const { ref, width } = useChartWidth();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  const fmtLabel = formatLabel ?? ((l: string) => l);
  const fmtValue = formatValue ?? ((n: number) => fullNumber(n));

  const resolved = useMemo(
    () => categories.map((c, i) => ({ ...c, colorVar: c.colorVar ?? seriesVar(i) })),
    [categories],
  );

  const totals = useMemo(
    () => labels.map((_, i) => resolved.reduce((n, c) => n + Math.max(c.values[i] ?? 0, 0), 0)),
    [labels, resolved],
  );
  const max = useMemo(() => Math.max(0, ...totals), [totals]);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = Math.max(0, height - PAD.top - PAD.bottom);
  const baseline = PAD.top + plotH;

  const slot = labels.length ? plotW / labels.length : plotW;
  const barW = Math.max(2, Math.min(MAX_BAR, slot - GAP));
  const slotX = (i: number) => PAD.left + i * slot;
  const barX = (i: number) => slotX(i) + (slot - barW) / 2;

  const isEmpty = !labels.length || max === 0;

  return (
    <ChartFrame
      title={title}
      value={value}
      caption={caption}
      action={action}
      isLoading={isLoading}
      height={height}
      empty={isEmpty ? (emptyText ?? '—') : undefined}
      className={className}
      legend={
        <ChartLegend
          mark="rect"
          items={resolved.map((c) => ({ key: c.key, label: c.label, colorVar: c.colorVar }))}
        />
      }
      table={
        <ChartDataTable
          caption={tableCaption ?? ariaLabel}
          columns={['', ...resolved.map((c) => c.label)]}
          rows={labels.map((l, i) => [fmtLabel(l), ...resolved.map((c) => fmtValue(c.values[i] ?? 0))])}
        />
      }
    >
      <div ref={ref} className="relative w-full">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          className="block touch-none"
        >
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={baseline}
            y2={baseline}
            stroke="var(--border)"
            strokeWidth={1}
          />

          {labels.map((label, i) => {
            const total = totals[i];
            let y = baseline;
            // Walk the stack from the baseline UP so the first category is
            // always the bottom segment — colour must follow the entity, and a
            // stack that reorders itself per day would repaint the same network
            // a different colour on a day it happened to lead.
            const segments = resolved
              .map((c) => ({ c, v: Math.max(c.values[i] ?? 0, 0) }))
              .filter((s) => s.v > 0);

            return (
              <g key={label}>
                {segments.map(({ c, v }, si) => {
                  const raw = max > 0 ? (v / max) * plotH : 0;
                  const isTop = si === segments.length - 1;
                  const top = y - raw;
                  y = top;
                  // The gap is taken off the TOP of every segment except the
                  // topmost, so it always falls BETWEEN two segments. Taking it
                  // off the bottom instead would work everywhere but the first
                  // segment, where it would lift the whole column two pixels off
                  // the baseline it is measured from.
                  const drawY = isTop ? top : top + GAP;
                  const h = Math.max(1, raw - (isTop ? 0 : GAP));
                  return isTop ? (
                    // Only the data-end is rounded, and only on its top edge. An
                    // `rx` on a <rect> rounds all four corners, which would notch
                    // the underside of the top segment against the gap; the path
                    // is the way to round two corners and leave two square.
                    <path key={c.key} d={topRoundedPath(barX(i), drawY, barW, h, RADIUS)} fill={c.colorVar} />
                  ) : (
                    <rect
                      key={c.key}
                      x={barX(i)}
                      y={drawY}
                      width={barW}
                      height={h}
                      fill={c.colorVar}
                    />
                  );
                })}
                {/*
                  The hit target, not the mark. A one-post day is a two-pixel
                  sliver nobody can point at; this covers the whole slot from the
                  baseline to the top of the plot, which is what people actually
                  aim at.
                */}
                <rect
                  x={slotX(i)}
                  y={PAD.top}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={(e) => {
                    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                    setHover({
                      i,
                      x: barX(i) + barW / 2,
                      y: rect ? e.clientY - rect.top : PAD.top,
                    });
                  }}
                  onPointerMove={(e) => {
                    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                    setHover({
                      i,
                      x: barX(i) + barW / 2,
                      y: rect ? e.clientY - rect.top : PAD.top,
                    });
                  }}
                  onPointerLeave={() => setHover(null)}
                />
                {/* The hovered slot lifts, so the reader sees the chart respond. */}
                {hover?.i === i && total > 0 && (
                  <rect
                    x={slotX(i)}
                    y={PAD.top}
                    width={slot}
                    height={plotH}
                    fill="var(--muted-foreground)"
                    opacity={0.08}
                    pointerEvents="none"
                  />
                )}
              </g>
            );
          })}
        </svg>

        {hover && totals[hover.i] > 0 && (
          <ChartTooltip x={hover.x} y={hover.y} width={width}>
            <div className="font-medium text-foreground">{fmtLabel(labels[hover.i])}</div>
            <ul className="mt-0.5 space-y-0.5">
              {resolved
                .filter((c) => (c.values[hover.i] ?? 0) > 0)
                .map((c) => (
                  <li key={c.key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: c.colorVar }}
                    />
                    <span className="font-medium tabular-nums text-foreground">
                      {fmtValue(c.values[hover.i] ?? 0)}
                    </span>
                    <span className="truncate text-muted-foreground">{c.label}</span>
                  </li>
                ))}
            </ul>
          </ChartTooltip>
        )}
      </div>

      {labels.length > 1 && (
        <div className="flex justify-between text-micro text-muted-foreground">
          <span>{fmtLabel(labels[0])}</span>
          <span>{fmtLabel(labels[labels.length - 1])}</span>
        </div>
      )}
    </ChartFrame>
  );
}
