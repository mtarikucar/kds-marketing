import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import type { EventView } from '../../../../features/marketing/api/contentProgramme.service';

/**
 * A tone per event family. Kinds are free strings written by the jobs
 * ("slot.failed", "programme.paused", "reweight"…), so the mapping is by
 * suffix rather than by an enum nobody will keep in sync.
 */
export function eventTone(kind: string): BadgeProps['tone'] {
  const k = kind.toLowerCase();
  if (/fail|error|kill/.test(k)) return 'danger';
  if (/pause|anomal|defer|cap/.test(k)) return 'warning';
  if (/publish|measur|reweight|phase/.test(k)) return 'success';
  if (/plan|ideat|produc|resume/.test(k)) return 'info';
  return 'neutral';
}

/** "3 saat önce", in the viewer's language, with the largest unit that fits. */
export function relativeTime(iso: string, now: Date, language: string): string {
  const diffSec = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (abs < 60) return rtf.format(diffSec, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  return rtf.format(Math.round(diffSec / 86400), 'day');
}

export interface EventLogProps {
  events: EventView[];
  now: Date;
}

/**
 * The "why" log, newest first: every decision a job took and the sentence it
 * wrote about it. The panel does not interpret `data` — it is whatever the
 * job attached, and the message is the human-readable half by contract.
 */
export function EventLog({ events, now }: EventLogProps) {
  const { t, i18n } = useTranslation('marketing');
  const rows = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="programme-events-empty">
        {t('studio.programme.events.empty', 'Henüz olay yok.')}
      </p>
    );
  }

  return (
    <ol className="flex flex-col divide-y divide-border" data-testid="programme-events">
      {rows.map((ev) => (
        <li key={ev.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5 text-sm" data-testid="programme-event-row">
          <Badge tone={eventTone(ev.kind)} size="sm" className="shrink-0">
            {ev.kind}
          </Badge>
          <span className="min-w-0 flex-1">{ev.message}</span>
          <time
            dateTime={ev.createdAt}
            title={new Date(ev.createdAt).toLocaleString(i18n.language)}
            className="shrink-0 text-xs text-muted-foreground"
          >
            {relativeTime(ev.createdAt, now, i18n.language)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export default EventLog;
