import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';

/**
 * The chrome every chart in this app shares, so that none of them has to invent
 * its own answer to loading, emptiness, or "how does a screen-reader read this".
 *
 * The last of those is the reason this is a component rather than a wrapper div.
 * An `<svg>` full of `<path>` data is, to assistive tech, a picture of nothing.
 * A chart therefore ships with the same numbers twice — once as marks and once
 * as a real `<table>` that is visually hidden but fully readable — and putting
 * the table here means it cannot be the thing that gets skipped when a chart is
 * added in a hurry. Nothing in this app has a precedent for charts yet; this
 * sets it.
 */

export interface ChartFrameProps {
  title: ReactNode;
  /** The one number the chart is about, rendered large beside the title. */
  value?: ReactNode;
  /** Small print under the title — units, freshness, what is NOT counted. */
  caption?: ReactNode;
  isLoading?: boolean;
  /** Rendered in place of the plot when there is genuinely nothing to draw. */
  empty?: ReactNode;
  legend?: ReactNode;
  /** Right-aligned slot in the header (a range switch, a refresh button). */
  action?: ReactNode;
  /** The visually hidden data table. Always provide it. */
  table?: ReactNode;
  height?: number;
  className?: string;
  children?: ReactNode;
}

export function ChartFrame({
  title,
  value,
  caption,
  isLoading,
  empty,
  legend,
  action,
  table,
  height = 160,
  className,
  children,
}: ChartFrameProps) {
  return (
    <figure className={cn('flex min-w-0 flex-col gap-2', className)}>
      <figcaption className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-caption font-medium text-muted-foreground">{title}</div>
          {value !== undefined && (
            // Proportional figures on purpose: `tabular-nums` gives every digit
            // the width of a zero, which reads loose at display size. Tabular is
            // for the columns in the table below, where digits must line up.
            <div className="text-h3 font-semibold leading-tight text-foreground">{value}</div>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </figcaption>

      {isLoading ? (
        <Skeleton className="w-full rounded-lg" style={{ height }} />
      ) : empty ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed border-border px-3 text-center text-caption text-muted-foreground"
          style={{ height }}
        >
          {empty}
        </div>
      ) : (
        <>
          {children}
          {legend}
        </>
      )}

      {caption && <p className="text-micro text-muted-foreground">{caption}</p>}
      {/*
        The table is the plot's twin, so it appears exactly when the plot does —
        and NOT while the chart is loading or standing empty.

        It used to render in all three branches, which quietly made the two
        halves of every chart on this screen say different things. A caller
        zero-fills its window before its query resolves, so during load the
        marks were a skeleton while the table underneath asserted thirty days of
        `0`; on a failed read the marks were "Organik veri yok" while the table
        still published the same thirty zeros. `LineTrend` already writes an em
        dash rather than a zero for a point it will not draw, for exactly this
        reason — the frame was undoing that one level up, and only for the
        readers who cannot see the empty state saying otherwise.
      */}
      {!isLoading && !empty && table && <div className="sr-only">{table}</div>}
    </figure>
  );
}

/**
 * The legend.
 *
 * Present whenever there are two or more series and absent when there is one —
 * a box with a single swatch only restates the title. The swatch mirrors the
 * mark it stands for: a short stroke for a line, a filled rect for a bar or an
 * area, so the reader is matching shapes and not just colours.
 *
 * The text itself never wears the series colour. Several of these hues are
 * illegible as small text on the surface, and identity is carried perfectly well
 * by the coloured mark sitting beside the label.
 */
export function ChartLegend({
  items,
  mark = 'line',
}: {
  items: { key: string; label: string; colorVar: string }[];
  mark?: 'line' | 'rect';
}) {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5 text-micro text-muted-foreground">
          <span
            aria-hidden="true"
            className={mark === 'line' ? 'h-0.5 w-3 rounded-full' : 'h-2.5 w-2.5 rounded-[2px]'}
            style={{ backgroundColor: s.colorVar }}
          />
          <span className="truncate">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The chart's numbers as a table. Visually hidden by `ChartFrame`, but real:
 * headers, rows, and the same values the marks encode.
 *
 * It is not only an accessibility fallback. It is also the escape hatch the mark
 * specs assume exists — a value that will not fit inside a small bar is allowed
 * to live in the tooltip precisely because it is never gated behind hovering.
 */
export function ChartDataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) =>
              j === 0 ? (
                <th key={j} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={j}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The rendered width of the plot, in CSS pixels.
 *
 * Charts here are drawn in real pixel coordinates rather than in a 0–100 viewBox
 * stretched with `preserveAspectRatio="none"`. The stretched version is less
 * code and looks fine until it does not: non-uniform scaling turns a 2px stroke
 * into a different thickness horizontally and vertically, squashes every
 * end-marker into an ellipse, and warps the 4px radius on a bar's data-end into
 * a lozenge. All three are exactly the specs that make these charts look
 * considered, so they are worth measuring for.
 *
 * The initial width is a guess that is only ever visible for one frame; in a
 * jsdom test — where `ResizeObserver` is stubbed and never fires — it is the
 * width the chart keeps, which is why nothing about correctness may depend on it.
 */
export function useChartWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

/**
 * A tooltip anchored to a point inside the plot.
 *
 * Flips to the left of the anchor once it would overflow the right edge, and is
 * `pointer-events-none` so it can never eat the pointermove that keeps it alive.
 * `role="status"` rather than `role="tooltip"`: it is driven by pointer position
 * and by keyboard focus on the plot itself, not by a `aria-describedby`
 * relationship with a focusable trigger.
 */
export function ChartTooltip({
  x,
  y,
  width,
  children,
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
}) {
  const flip = x > width * 0.6;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-[8rem] max-w-[14rem] rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-micro shadow-md"
      style={{
        left: flip ? undefined : x + 10,
        right: flip ? width - x + 10 : undefined,
        top: Math.max(0, y - 8),
      }}
    >
      {children}
    </div>
  );
}

/**
 * Keyboard equivalence for the hover layer.
 *
 * The crosshair answers "what happened on this day", and a keyboard user has to
 * be able to ask the same question. Left/Right step the cursor, Home/End jump to
 * the ends, Escape dismisses — and the plot is only focusable when there is
 * something to step through.
 */
export function useChartCursor(count: number) {
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    // A range change can leave the cursor past the end of the new series.
    setCursor((c) => (c === null ? null : Math.min(c, count - 1)));
  }, [count]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!count) return;
    const at = cursor ?? 0;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setCursor(Math.min(at + 1, count - 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setCursor(Math.max(at - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCursor(count - 1);
    } else if (e.key === 'Escape') {
      setCursor(null);
    }
  };

  return { cursor, setCursor, onKeyDown };
}

/** Compact number for an axis tick or a stat value: 1.284 → 1,3B in TR. */
export function compactNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Full number with grouping — for tables and tooltips, where precision is read. */
export function fullNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale).format(n);
}
