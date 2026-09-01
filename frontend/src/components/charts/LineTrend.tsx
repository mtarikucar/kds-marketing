import { useMemo, useState } from 'react';
import {
  ChartFrame,
  ChartLegend,
  ChartDataTable,
  ChartTooltip,
  useChartWidth,
  useChartCursor,
  compactNumber,
  fullNumber,
} from './ChartFrame';
import { seriesVar } from './palette';

export interface LineSeries {
  key: string;
  label: string;
  /** One value per label, same length and order. Zero-fill before passing. */
  points: number[];
  /** Override the slot colour. Leave unset to take the next categorical slot. */
  colorVar?: string;
}

export interface LineTrendProps {
  /** X positions — `YYYY-MM-DD` day keys, ascending, already dense. */
  labels: string[];
  series: LineSeries[];
  title: React.ReactNode;
  /** The headline number beside the title. */
  value?: React.ReactNode;
  caption?: React.ReactNode;
  action?: React.ReactNode;
  isLoading?: boolean;
  emptyText?: string;
  height?: number;
  /** Human label for an x position (a date, formatted). Defaults to the raw key. */
  formatLabel?: (label: string) => string;
  /** Human value in the tooltip and the table. Defaults to grouped digits. */
  formatValue?: (n: number) => string;
  /** Sentence describing what the picture shows, for assistive tech. */
  ariaLabel: string;
  tableCaption?: string;
  className?: string;
}

const PAD = { top: 10, right: 10, bottom: 18, left: 10 };

/**
 * A line — or, for a single series, a line over a wash of its own colour.
 *
 * ONE Y-AXIS, always. Two measures of different magnitude do not belong on one
 * plot: aligning two scales is an arbitrary choice, and whatever correlation the
 * reader then sees was invented by that choice rather than found in the data.
 * Plot the second measure as its own `LineTrend` beside this one (small
 * multiples), which is what the Growth Studio does — reach, engagement, spend
 * and followers each keep their own scale and share only the x-axis.
 *
 * Several series ARE allowed when they are the same measure for different
 * entities — followers per account, say. That is one scale by construction.
 */
export function LineTrend({
  labels,
  series,
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
}: LineTrendProps) {
  const { ref, width } = useChartWidth();
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const { cursor, setCursor, onKeyDown } = useChartCursor(labels.length);

  const fmtLabel = formatLabel ?? ((l: string) => l);
  const fmtValue = formatValue ?? ((n: number) => fullNumber(n));

  const resolved = useMemo(
    () => series.map((s, i) => ({ ...s, colorVar: s.colorVar ?? seriesVar(i) })),
    [series],
  );

  const max = useMemo(() => {
    let m = 0;
    for (const s of resolved) for (const p of s.points) if (Number.isFinite(p) && p > m) m = p;
    return m;
  }, [resolved]);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = Math.max(0, height - PAD.top - PAD.bottom);

  // A single point has no span to divide, and a flat all-zero series would put
  // every point on the baseline — nudging the scale so the line is visible would
  // be drawing a value that is not there, so the flat line at the bottom is
  // correct and the empty state below is what handles "nothing to show".
  const xAt = (i: number) =>
    PAD.left + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const yAt = (v: number) => PAD.top + plotH - (max > 0 ? (Math.max(v, 0) / max) * plotH : 0);

  const isEmpty = !labels.length || resolved.every((s) => s.points.every((p) => !p));

  const nearest = (clientX: number, rect: DOMRect) => {
    if (labels.length <= 1) return 0;
    const rel = clientX - rect.left - PAD.left;
    const i = Math.round((rel / plotW) * (labels.length - 1));
    return Math.min(Math.max(i, 0), labels.length - 1);
  };

  const active = cursor;

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
          mark="line"
          items={resolved.map((s) => ({ key: s.key, label: s.label, colorVar: s.colorVar }))}
        />
      }
      table={
        <ChartDataTable
          caption={tableCaption ?? ariaLabel}
          columns={['', ...resolved.map((s) => s.label)]}
          rows={labels.map((l, i) => [fmtLabel(l), ...resolved.map((s) => fmtValue(s.points[i] ?? 0))])}
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
          tabIndex={labels.length ? 0 : -1}
          onKeyDown={onKeyDown}
          onBlur={() => setCursor(null)}
          className="block touch-none rounded-lg outline-none ring-offset-2 ring-offset-surface focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const i = nearest(e.clientX, rect);
            setCursor(i);
            setHover({ x: xAt(i), y: e.clientY - rect.top });
          }}
          onPointerLeave={() => {
            setCursor(null);
            setHover(null);
          }}
        >
          {/*
            The baseline, and nothing else. A hairline one step off the surface,
            solid — dashing a grid adds noise and reads as "projected" or
            "threshold" when it is just an axis. There are no horizontal
            gridlines because these plots are small multiples read for SHAPE; the
            values live in the tooltip and the table.
          */}
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={PAD.top + plotH}
            y2={PAD.top + plotH}
            stroke="var(--border)"
            strokeWidth={1}
          />

          {resolved.map((s) => {
            const pts = labels.map((_, i) => `${xAt(i)},${yAt(s.points[i] ?? 0)}`).join(' ');
            return (
              <g key={s.key}>
                {/* The area wash is for a lone series only: overlapping fills at
                    10% stop being washes and start being mud. */}
                {resolved.length === 1 && labels.length > 1 && (
                  <polygon
                    points={`${PAD.left},${PAD.top + plotH} ${pts} ${width - PAD.right},${PAD.top + plotH}`}
                    fill={s.colorVar}
                    opacity={0.1}
                  />
                )}
                {labels.length > 1 ? (
                  <polyline
                    points={pts}
                    fill="none"
                    stroke={s.colorVar}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <circle cx={xAt(0)} cy={yAt(s.points[0] ?? 0)} r={4} fill={s.colorVar} />
                )}
                {/* The end marker, direct-labelled by the headline value above —
                    never a number on every point. The 2px surface ring keeps it
                    legible where two series cross. */}
                {labels.length > 1 && (
                  <circle
                    cx={xAt(labels.length - 1)}
                    cy={yAt(s.points[labels.length - 1] ?? 0)}
                    r={4}
                    fill={s.colorVar}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                )}
              </g>
            );
          })}

          {active !== null && (
            <g pointerEvents="none">
              <line
                x1={xAt(active)}
                x2={xAt(active)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--border-strong)"
                strokeWidth={1}
              />
              {resolved.map((s) => (
                <circle
                  key={s.key}
                  cx={xAt(active)}
                  cy={yAt(s.points[active] ?? 0)}
                  r={4}
                  fill={s.colorVar}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>

        {active !== null && (
          <ChartTooltip x={xAt(active)} y={hover?.y ?? PAD.top} width={width}>
            <div className="font-medium text-foreground">{fmtLabel(labels[active])}</div>
            <ul className="mt-0.5 space-y-0.5">
              {resolved.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: s.colorVar }}
                  />
                  {/* Value leads, label follows: the reader already knows which
                      series they are looking at and came for the number. */}
                  <span className="font-medium tabular-nums text-foreground">
                    {fmtValue(s.points[active] ?? 0)}
                  </span>
                  {resolved.length > 1 && (
                    <span className="truncate text-muted-foreground">{s.label}</span>
                  )}
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

export { compactNumber, fullNumber };
