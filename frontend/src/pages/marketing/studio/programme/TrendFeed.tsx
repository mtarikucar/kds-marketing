import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { TrendView } from '../../../../features/marketing/api/contentProgramme.service';

export interface TrendFeedProps {
  trends: TrendView[];
}

/**
 * Only an http(s) URL becomes a link. `ref` is whatever the provider's actor
 * returned — a relative path, a bare id, or a `javascript:` string all
 * arrive unchecked — and none of those belongs in an anchor inside the
 * authenticated app; they render as plain text next to the title instead.
 */
export function safeHref(ref: string | null): string | null {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The signals the planner may hook a slot onto, ranked by SUGGESTION — the
 * decayed score folded with how much the title has to do with this brand.
 * Both halves are printed next to the bar, because a trend that is enormous
 * and irrelevant and one that is small and on-brand can land on the same
 * suggestion score, and the owner's next move differs between them.
 */
export function TrendFeed({ trends }: TrendFeedProps) {
  const { t, i18n } = useTranslation('marketing');
  const rows = [...trends].sort((a, b) => b.suggestion - a.suggestion);
  const when = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso),
    );

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="programme-trends-empty">
        {t('studio.programme.trends.empty', 'Trend sinyali yok — sağlayıcılar 12 saatte bir tazeler; kapalıysa bu liste boş kalır.')}
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border" data-testid="programme-trends">
      {rows.map((tr) => {
        const pct = Math.round(Math.min(1, Math.max(0, tr.suggestion)) * 100);
        const href = safeHref(tr.ref);
        return (
          <li key={tr.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" data-testid="programme-trend-row">
            <Badge tone="info" size="sm">
              {tr.network}
            </Badge>
            <span className="text-micro uppercase tracking-wide text-muted-foreground">{tr.kind}</span>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
              >
                {tr.title}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : (
              <span className="font-medium">{tr.title}</span>
            )}
            <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className="h-1.5 w-20 rounded-full bg-border"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-label={t('studio.programme.trends.suggestion', 'Öneri')}
              >
                <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </span>
              <span className="tabular-nums" title={t('studio.programme.trends.decayed', 'Sönümlenmiş skor')}>
                {t('studio.programme.trends.decayedShort', 'skor')} {tr.decayed.toFixed(2)}
              </span>
              <span className="tabular-nums" title={t('studio.programme.trends.relevance', 'Marka uygunluğu')}>
                {t('studio.programme.trends.relevanceShort', 'uygunluk')} {tr.relevance.toFixed(2)}
              </span>
              <span>{when(tr.observedAt)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default TrendFeed;
