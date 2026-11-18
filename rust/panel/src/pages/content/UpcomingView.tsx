import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Folder } from 'lucide-react';
import type { UpcomingDay } from '@/api/content';
import { Badge, Button, Callout, EmptyState } from '@/components/ui';
import { emptyOlay, formatDay, formatRange } from '../materials/MaterialsShared';
import { OlayDialog } from './OlayForms';
import { useContentPlace } from './location';

/**
 * A special day of the calendar coming up with no olay yet: when it is, when the system starts
 * preparing for it, and (for whoever may) opening its olay now.
 */
export function UpcomingView({ day, canCreate }: { day: UpcomingDay | undefined; canCreate: boolean }) {
  const { t, i18n } = useTranslation();
  const [, go] = useContentPlace();
  const [creating, setCreating] = useState(false);
  if (!day) return <EmptyState title={t('content.day.gone')} description={t('content.day.goneHelp')} />;
  return (
    <section aria-label={day.name} className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-start gap-3">
        <Folder aria-hidden="true" className="h-9 w-9 shrink-0 text-muted-foreground [stroke-dasharray:2_2]" strokeWidth={1.2} />
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-medium">
            {day.name}
            <Badge>{t('content.tree.soon')}</Badge>
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(`materials.kind.${day.kind}`)} · {formatRange(day.window_start, day.window_end, i18n.language)}
          </p>
        </div>
      </header>
      <Callout tone="info" icon={<CalendarClock className="h-4 w-4" />} title={t('content.day.notStarted')}>
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-[1_1_16rem] text-sm">{t('content.day.help', { day: formatDay(day.prepares_from, i18n.language) })}</p>
          {canCreate && <Button variant="outline" size="sm" onClick={() => setCreating(true)}>{t('content.day.create')}</Button>}
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
