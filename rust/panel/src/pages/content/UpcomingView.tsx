import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CalendarClock, Folder } from 'lucide-react';
import { GENEL, type DayPhase, type UpcomingDay } from '@/api/content';
import { istanbulDay } from '@/api/materials';
import { Badge, Button, Callout, EmptyState } from '@/components/ui';
import { emptyOlay, formatDay, formatRange } from '../materials/MaterialsShared';
import { OlayDialog } from './OlayForms';
import { placeHref, useContentPlace } from './location';

/** Where the day stands: the server's word, or its dates for an answer from before it said. */
export function dayPhase(day: UpcomingDay, today = istanbulDay(new Date())): DayPhase {
  if (day.phase) return day.phase;
  if (day.window_start <= today) return 'open';
  return day.prepares_from <= today ? 'preparing' : 'ahead';
}

/**
 * A special day of the calendar with no olay yet: when it is, where it stands, and what the
 * system does about it. The system opens no olay for it (spec 2026-11-03 D3, D25): a person opens
 * it (or confirms one an agent proposed); from the preparation day the system makes content for
 * that olay once it holds a usable file, and asks for a capture on the çekim listesi meanwhile.
 */
export function UpcomingView({ day, canCreate }: { day: UpcomingDay | undefined; canCreate: boolean }) {
  const { t, i18n } = useTranslation();
  const [, go] = useContentPlace();
  const [creating, setCreating] = useState(false);
  if (!day) return <EmptyState title={t('content.day.gone')} description={t('content.day.goneHelp')} />;
  const phase = dayPhase(day);
  const lang = i18n.language;
  return (
    <section aria-label={day.name} className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-start gap-3">
        <Folder aria-hidden="true" className="h-9 w-9 shrink-0 text-muted-foreground [stroke-dasharray:2_2]" strokeWidth={1.2} />
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-medium">
            {day.name}
            <Badge tone={phase === 'open' ? 'warning' : 'neutral'}>{t(`content.day.phase.${phase}`)}</Badge>
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(`materials.kind.${day.kind}`)} · {formatRange(day.window_start, day.window_end, lang)}
          </p>
        </div>
      </header>
      <Callout tone={phase === 'ahead' ? 'info' : 'warning'} icon={<CalendarClock className="h-4 w-4" />} title={t(`content.day.title.${phase}`)}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-[1_1_16rem] space-y-1 text-sm">
            <p>{t(`content.day.help.${phase}`, { day: formatDay(day.prepares_from, lang), start: formatDay(day.window_start, lang) })}</p>
            <p className="text-muted-foreground">{t('content.day.how')}</p>
            {day.shoot_request_id && (
              <p>
                <Link className="text-primary underline" to={`${placeHref({ olay: GENEL })}#eksikler`}>{t('content.day.shootAsked')}</Link>
              </p>
            )}
          </div>
          {canCreate && <Button variant={phase === 'ahead' ? 'outline' : 'primary'} size="sm" onClick={() => setCreating(true)}>{t('content.day.create')}</Button>}
        </div>
      </Callout>
      {creating && (
        <OlayDialog
          initial={{ ...emptyOlay(day.window_start), kind: day.kind, title: day.name, ends_on: day.window_end === day.window_start ? '' : day.window_end, occasion: day.key }}
          onClose={() => setCreating(false)}
          onSaved={(olay) => go({ olay: olay.id })}
        />
      )}
    </section>
  );
}
