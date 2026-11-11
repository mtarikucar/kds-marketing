import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import * as p from '@/api/posts';
import type { Hypothesis } from '@/api/types';
import { Badge } from '@/components/ui';
import { MaterialsError, cardClass, formatDay, tapClass } from '../materials/MaterialsShared';
import { percent, useChannelName, usePostsKey } from './PostsShared';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={cardClass} aria-labelledby={id}>
      <h3 id={id} className="font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Haftalık özet (spec D32, D55): a week, Monday to Monday in the posting policy's zone, of what
 * was published, what is planned, what was not published and why, and what each format earned
 * per olay type and hypothesis so far.
 */
export function PostsWeek({
  week,
  hypotheses,
  onWeek,
}: {
  week?: string;
  hypotheses: Hypothesis[];
  onWeek: (week: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const key = usePostsKey();
  const channel = useChannelName();
  const summary = useQuery({
    queryKey: [...key, 'summary', week ?? 'current'],
    queryFn: () => p.weeklySummary(week),
  });
  const s = summary.data;
  const lang = i18n.language;
  const at = (when: string) => p.formatAt(when, lang, s?.tz ?? 'Europe/Istanbul');
  const format = (f: p.PostFormat | null) => (f ? t(`posts.format.${f}`) : t('posts.week.oldPlan'));
  const title = (id: string) => hypotheses.find((h) => h.id === id)?.title ?? id.slice(0, 8);
  const none = <p className="text-sm text-muted-foreground">{t('posts.week.none')}</p>;
  return (
    <div className="space-y-4" data-testid="posts-week">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={tapClass}
          disabled={!s}
          onClick={() => s && onWeek(p.shiftWeek(s.week_start, -1))}
        >
          {t('posts.week.prev')}
        </button>
        <button type="button" className={tapClass} disabled={!week} onClick={() => onWeek(null)}>
          {t('posts.week.current')}
        </button>
        <button
          type="button"
          className={tapClass}
          disabled={!s}
          onClick={() => s && onWeek(p.shiftWeek(s.week_start, 1))}
        >
          {t('posts.week.next')}
        </button>
        {s && (
          <h3 className="text-lg font-semibold" data-testid="week-title">
            {t('posts.week.title', {
              from: formatDay(s.week_start, lang),
              until: formatDay(p.addDays(s.week_start, 6), lang),
            })}
          </h3>
        )}
      </div>
      <MaterialsError error={summary.error} />
      {s && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section id="week-published" title={t('posts.week.published')}>
            {s.published.length === 0 && none}
            <ul className="space-y-2">
              {s.published.map((x) => (
                <li key={x.publication_id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{format(x.format)}</span>
                  <span className="break-all text-muted-foreground">{channel(x.capability_id)}</span>
                  <span className="text-muted-foreground">{at(x.published_at)}</span>
                  {x.url && (
                    <a className="underline" href={x.url} target="_blank" rel="noreferrer">
                      {t('posts.week.view')}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </Section>
          <Section id="week-planned" title={t('posts.week.planned')}>
            {s.planned.length === 0 && none}
            <ul className="space-y-2">
              {s.planned.map((x) => (
                <li key={x.slot_id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{format(x.format)}</span>
                  <span className="break-all text-muted-foreground">{channel(x.capability_id)}</span>
                  <span className="text-muted-foreground">{at(x.publish_at)}</span>
                  <Badge tone={x.state === 'ready' ? 'success' : 'neutral'}>
                    {t(x.state === 'ready' ? 'posts.plan.state.ready' : 'posts.plan.state.waiting')}
                  </Badge>
                </li>
              ))}
            </ul>
          </Section>
          <Section id="week-cancelled" title={t('posts.week.cancelled')}>
            {s.cancelled.length === 0 && none}
            <ul className="space-y-2">
              {s.cancelled.map((x) => (
                <li key={`${x.slot_id}-${x.at}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{format(x.format)}</span>
                  <span className="break-all text-muted-foreground">{channel(x.capability_id)}</span>
                  <Badge tone="warning">{t(`posts.week.reason.${x.reason}`)}</Badge>
                  <span className="text-muted-foreground">{at(x.at)}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section id="week-scores" title={t('posts.week.scores')}>
            {s.scores.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('posts.week.noScores')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">{t('posts.week.scoreFormat')}</th>
                      <th className="py-1 pr-2 font-medium">{t('posts.week.scoreKind')}</th>
                      <th className="py-1 pr-2 font-medium">{t('posts.week.scoreHypothesis')}</th>
                      <th className="py-1 pr-2 font-medium">{t('posts.week.scoreMean')}</th>
                      <th className="py-1 font-medium">{t('posts.week.scorePosts')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.scores.map((x) => (
                      <tr key={`${x.format}-${x.olay_kind}-${x.hypothesis_id}`} className="border-t border-border">
                        <td className="py-1 pr-2">{t(`posts.format.${x.format}`)}</td>
                        <td className="py-1 pr-2">
                          {x.olay_kind ? t(`materials.kind.${x.olay_kind}`) : t('posts.week.generic')}
                        </td>
                        <td className="py-1 pr-2">{title(x.hypothesis_id)}</td>
                        <td className="py-1 pr-2">{percent(x.mean, lang)}</td>
                        <td className="py-1">{x.posts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
