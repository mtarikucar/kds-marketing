import { useTranslation } from 'react-i18next';
import { cn } from '@/components/ui/cn';
import type { SlotView } from '../../../../features/marketing/api/contentProgramme.service';

/**
 * The next fourteen days of the programme as one row of chips.
 *
 * A chip is the smallest thing that can still say three things at once — WHEN
 * (weekday + time), WHAT (the type, by name and by colour) and HOW FAR ALONG
 * (the status glyph). Colour is keyed on the type's `key` through a stable
 * hash rather than assigned in order, so a type keeps its colour when another
 * one is added above it, and the same type is the same colour in every tab.
 */

/**
 * Eight tones, all from the design tokens so they survive the dark theme.
 * Colour is never the only signal: the chip carries the type's name as text
 * and the status as a glyph, so two types landing on the same tone is a
 * cosmetic collision, not an information loss.
 */
const PALETTE = [
  'border-primary/50 bg-primary/10',
  'border-info bg-info-subtle',
  'border-success bg-success-subtle',
  'border-warning bg-warning-subtle',
  'border-brand-accent bg-brand-accent-subtle',
  'border-danger/50 bg-danger-subtle',
  'border-border-strong bg-surface-muted',
  'border-primary bg-accent',
] as const;

/** djb2 over the key — stable across sessions and machines, no randomness. */
export function typeColour(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** One glyph per status. Pure text so it renders wherever a badge does not fit. */
export const STATUS_GLYPH: Record<string, string> = {
  PLANNED: '○',
  IDEATED: '◐',
  PRODUCING: '◑',
  READY: '●',
  PUBLISHED: '✓',
  MEASURED: '★',
  SKIPPED: '⊘',
  FAILED: '✕',
};

export function statusGlyph(status: string): string {
  return STATUS_GLYPH[status] ?? '·';
}

/** Weekday + clock, in the viewer's locale: "Sal 18:00". */
export function shortWhen(iso: string, language: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}

export interface SlotStripProps {
  slots: SlotView[];
  /** The chip currently open in the editor, if any. */
  selectedId: string | null;
  onSelect: (slotId: string) => void;
  /** Reference clock — passed in so the window is decided once per render tree. */
  now: Date;
  /** How far ahead the strip reaches, in days. */
  days?: number;
  className?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every slot from the start of `now`'s day to `days` ahead, soonest first. */
export function stripWindow(slots: SlotView[], now: Date, days: number): SlotView[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = start.getTime() + days * DAY_MS;
  return slots
    .filter((s) => {
      const at = new Date(s.scheduledFor).getTime();
      return at >= start.getTime() && at < end;
    })
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

export function SlotStrip({ slots, selectedId, onSelect, now, days = 14, className }: SlotStripProps) {
  const { t, i18n } = useTranslation('marketing');
  const visible = stripWindow(slots, now, days);

  if (visible.length === 0) {
    return (
      <span className={cn('text-xs text-muted-foreground', className)} data-testid="programme-strip-empty">
        {t('studio.programme.strip.empty', 'Önümüzdeki 14 gün için slot yok — planlayıcı 6 saatte bir doldurur.')}
      </span>
    );
  }

  return (
    <ul
      className={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)}
      aria-label={t('studio.programme.strip.label', 'Önümüzdeki 14 günün slotları')}
      data-testid="programme-strip"
    >
      {visible.map((s) => {
        const selected = s.id === selectedId;
        const statusLabel = t(`studio.programme.slotStatus.${s.status}`, s.status);
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-pressed={selected}
              aria-label={`${shortWhen(s.scheduledFor, i18n.language)} · ${s.contentTypeName} · ${statusLabel}`}
              title={s.idea}
              data-testid="programme-chip"
              data-status={s.status}
              data-type={s.contentTypeKey}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs leading-5 text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                typeColour(s.contentTypeKey),
                selected && 'ring-2 ring-ring',
                (s.status === 'SKIPPED' || s.status === 'FAILED') && 'opacity-60',
              )}
            >
              <span className="tabular-nums">{shortWhen(s.scheduledFor, i18n.language)}</span>
              <span className="max-w-[9rem] truncate font-medium">{s.contentTypeName}</span>
              <span aria-hidden="true" className={cn(s.status === 'FAILED' && 'text-danger')}>
                {statusGlyph(s.status)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default SlotStrip;
