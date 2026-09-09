import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { LearningView } from '../../../../features/marketing/api/contentProgramme.service';

/**
 * A stroke per type, from the design tokens so the chart follows the theme.
 * Assigned by the type's position in the history's key order, which is
 * stable for as long as the same types exist — the legend below is what
 * actually names each line.
 */
const STROKES = [
  'var(--primary)',
  'var(--info)',
  'var(--success)',
  'var(--warning)',
  'var(--brand-accent)',
  'var(--danger)',
  'var(--muted-foreground)',
  'var(--foreground)',
] as const;

const W = 320;
const H = 120;
const PAD = { l: 28, r: 8, t: 8, b: 18 };

export interface WeightHistoryProps {
  history: LearningView['history'];
  /** Which types to draw, in this order. Defaults to every key seen in the history. */
  typeKeys?: string[];
  /** `key → display name`, for the legend and the table. */
  names?: Record<string, string>;
  className?: string;
}

/** Every type key that appears in any reweight, first appearance first. */
export function historyKeys(history: LearningView['history']): string[] {
  const seen: string[] = [];
  for (const h of history) for (const k of Object.keys(h.weights)) if (!seen.includes(k)) seen.push(k);
  return seen;
}

/** The chart coordinates for one type, `x` by reweight index and `y` by weight 0..1. */
export function pointCoords(history: LearningView['history'], key: string): Array<{ x: number; y: number }> {
  const n = history.length;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  return history.map((h, i) => {
    const x = PAD.l + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const w = Math.min(1, Math.max(0, h.weights[key] ?? 0));
    const y = PAD.t + innerH - w * innerH;
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
  });
}

/** The same, as an SVG `points` string. */
export function polylinePoints(history: LearningView['history'], key: string): string {
  return pointCoords(history, key)
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
}

/**
 * The weights over the last twelve reweights, as one inline SVG and one
 * table of the same numbers.
 *
 * No chart library: the panel is on the Studio's only screen and a charting
 * dependency is a route-sized chunk for a picture of at most eight lines. The
 * table is not decoration — it is the chart for a screen reader, and for the
 * owner who wants the exact number behind a line that looks close to another.
 */
export function WeightHistory({ history, typeKeys, names = {}, className }: WeightHistoryProps) {
  const { t, i18n } = useTranslation('marketing');
  const id = useId();
  const keys = typeKeys ?? historyKeys(history);
  const label = (k: string) => names[k] ?? k;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: 'short' }).format(new Date(iso));

  if (history.length === 0) {
    return (
      <p className={className ?? 'text-xs text-muted-foreground'} data-testid="programme-weight-history-empty">
        {t('studio.programme.learning.noHistory', 'Henüz yeniden ağırlıklandırma yok — ilk hafta dolunca burada çizilir.')}
      </p>
    );
  }

  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  return (
    <figure className={className} data-testid="programme-weight-history">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-md"
        role="img"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-table`}
      >
        <title id={`${id}-title`}>{t('studio.programme.learning.historyTitle', 'Tür ağırlıkları, son 12 yeniden ağırlıklandırma')}</title>
        {[0, 0.5, 1].map((g) => {
          const y = PAD.t + innerH - g * innerH;
          return (
            <g key={g}>
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD.l - 4} y={y + 3} fontSize={8} textAnchor="end" fill="var(--muted-foreground)">
                {g.toFixed(1)}
              </text>
            </g>
          );
        })}
        {history.map((h, i) => {
          const x = PAD.l + (history.length === 1 ? innerW / 2 : (i / (history.length - 1)) * innerW);
          return (
            <text key={h.computedAt} x={x} y={H - 4} fontSize={7} textAnchor="middle" fill="var(--muted-foreground)">
              {when(h.computedAt)}
            </text>
          );
        })}
        {keys.map((k, i) => (
          <polyline
            key={k}
            data-testid="programme-weight-line"
            data-type={k}
            points={polylinePoints(history, k)}
            fill="none"
            stroke={STROKES[i % STROKES.length]}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/*
          A polyline with ONE point paints nothing — a line needs two ends —
          so the first reweight would show a legend over an empty chart. A
          marker per point makes that first week visible, and stays on later
          so the exact reweight instants are readable off the line.
        */}
        {keys.map((k, i) =>
          pointCoords(history, k).map((p, j) => (
            <circle
              key={`${k}-${j}`}
              data-testid="programme-weight-point"
              data-type={k}
              cx={p.x}
              cy={p.y}
              r={2}
              fill={STROKES[i % STROKES.length]}
            />
          )),
        )}
      </svg>

      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted-foreground">
        {keys.map((k, i) => (
          <span key={k} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3 rounded"
              style={{ backgroundColor: STROKES[i % STROKES.length] }}
            />
            {label(k)}
          </span>
        ))}
      </figcaption>

      <table id={`${id}-table`} className="sr-only" data-testid="programme-weight-table">
        <caption>{t('studio.programme.learning.historyTitle', 'Tür ağırlıkları, son 12 yeniden ağırlıklandırma')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('studio.programme.learning.computedAt', 'Tarih')}</th>
            {keys.map((k) => (
              <th key={k} scope="col">
                {label(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.computedAt}>
              <th scope="row">{when(h.computedAt)}</th>
              {keys.map((k) => (
                <td key={k}>{(h.weights[k] ?? 0).toFixed(2)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export default WeightHistory;
