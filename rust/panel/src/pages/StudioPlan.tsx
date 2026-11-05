import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { instant, type Arm, type Slot } from '@/api/studio';
import type { Hypothesis } from '@/api/types';
import { kindLabel } from '@/lib/capabilities';
import { Region, buttonClass, contentTypeLabel } from './StudioShared';
export function StudioPlan({
  available = true,
  slots,
  hypotheses,
  arms,
  onSelect,
}: {
  available?: boolean;
  slots: Slot[];
  hypotheses: Hypothesis[];
  arms: Arm[];
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [calendar, setCalendar] = useState(false);
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
  const start = new Date(`${day}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 7 * 86400000);
  const visible = slots
    .filter((s) => instant(s.scheduled_at) >= start && instant(s.scheduled_at) < end)
    .sort((a, b) => instant(a.scheduled_at).getTime() - instant(b.scheduled_at).getTime());
  const groups = new Map<string, Slot[]>();
  for (let i = 0; i < 7; i++)
    groups.set(
      new Date(start.getTime() + i * 86400000).toLocaleDateString(i18n.language, {
        timeZone: 'Europe/Istanbul',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }),
      [],
    );
  for (const slot of visible) {
    const day = instant(slot.scheduled_at).toLocaleDateString(i18n.language, {
      timeZone: 'Europe/Istanbul',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    groups.set(day, [...(groups.get(day) ?? []), slot]);
  }
  const row = (slot: Slot) => (
    <li key={slot.id} data-testid={`slot-${slot.id}`} className="relative border-s border-border ps-4 before:absolute before:-start-1 before:top-5 before:h-2 before:w-2 before:rounded-full before:border before:border-foreground/40 before:bg-background">
      <button className="w-full px-2 py-4 text-start hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(slot.id)}>
        <span className="block font-medium">
          {hypotheses.find((h) => h.id === slot.chain.hypothesis_id)?.title ?? t('studio.detail')}
        </span>
        <span className="block text-xs text-muted-foreground">
          {contentTypeLabel(t, arms.find((a) => a.id === slot.chain.arm_id)?.key.content_type ?? '')} /{' '}
          {kindLabel(t, arms.find((a) => a.id === slot.chain.arm_id)?.key.channel ?? '')}
        </span>
        <time className="text-xs tabular-nums" dateTime={instant(slot.scheduled_at).toISOString()}>
          {instant(slot.scheduled_at).toLocaleString(i18n.language, {
            timeZone: 'Europe/Istanbul',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
        <span className="ms-2 text-xs text-muted-foreground">{t(`studio.${slot.state}`)}</span>
      </button>
    </li>
  );
  return (
    <Region name="plan">
      <p className="text-xs text-muted-foreground">{t('studio.sevenDays')}</p>
      <div className="flex gap-2">
        <button className={buttonClass} aria-pressed={!calendar} onClick={() => setCalendar(false)}>
          {t('studio.list')}
        </button>
        <button className={buttonClass} aria-pressed={calendar} onClick={() => setCalendar(true)}>
          {t('studio.calendar')}
        </button>
      </div>
      {calendar ? (
        <div className="space-y-3">
          {[...groups].map(([day, rows]) => (
            <div key={day} className="border-t border-border pt-3">
              <h3 className="mb-2 text-sm font-medium">{day}</h3>
              <ul className="ms-1">{rows.map(row)}</ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className="ms-1">{visible.map(row)}</ul>
      )}
      {available && !visible.length && (
        <div className="space-y-3 py-4">
          <p className="text-sm font-medium">{t('studio.emptyPlan')}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">{t('studio.emptyPlanHelp')}</p>
          <Link className="inline-flex min-h-10 items-center text-sm font-medium text-primary underline underline-offset-4" to="/studio?tab=materials&view=upload">
            {t('studio.addMaterials')}
          </Link>
        </div>
      )}
    </Region>
  );
}
