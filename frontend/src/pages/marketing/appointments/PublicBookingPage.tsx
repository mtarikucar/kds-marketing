import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Video, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardContent } from '@/components/ui/Card';
import {
  getPublicSlots,
  reservePublicSlot,
} from '../../../features/marketing/api/booking.service';

const ATTENDEE_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
})();

/**
 * Public, unauthenticated self-service booking page (route /book/:ws/:cal).
 * Fetches bookable slots for the next 14 days, lets a visitor pick one and
 * reserve it, then confirms with the meeting link.
 */
export default function PublicBookingPage() {
  const { ws = '', cal = '' } = useParams();
  const { t, i18n } = useTranslation('marketing');
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' });
  const [confirmation, setConfirmation] = useState<{ startAt: string; token: string; meetingUrl?: string | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = new Date().toISOString();
  const to = new Date(Date.now() + 14 * 86400_000).toISOString();

  const { data, isLoading } = useQuery({
    queryKey: ['public-book', ws, cal, from.slice(0, 10)],
    queryFn: () => getPublicSlots(ws, cal, from, to),
    enabled: !!ws && !!cal,
  });

  const slots = data?.slots ?? [];

  const byDay = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const iso of slots) {
      const d = new Date(iso);
      const key = new Intl.DateTimeFormat(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(iso);
    }
    return Array.from(groups.entries());
  }, [slots, i18n.language]);

  const timeFmt = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const fullFmt = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));

  const reserve = async () => {
    if (!selected || !form.name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await reservePublicSlot(ws, cal, {
        start: selected,
        name: form.name.trim(),
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        notes: form.notes.trim() || undefined,
        attendeeTimezone: ATTENDEE_TZ,
      });
      setConfirmation({ startAt: res.startAt, token: res.token, meetingUrl: (res as any).meetingUrl });
    } catch (e: any) {
      setError(e?.message || t('publicBooking.failed', 'Could not reserve that slot. Please pick another.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (confirmation) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <CardContent className="space-y-3 pt-6 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
            <h1 className="text-xl font-semibold text-foreground">
              {t('publicBooking.confirmed', 'Your booking is confirmed')}
            </h1>
            <p className="text-muted-foreground">{fullFmt(confirmation.startAt)}</p>
            {confirmation.meetingUrl && (
              <a
                href={confirmation.meetingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-primary hover:underline"
              >
                <Video className="h-4 w-4" />
                {t('publicBooking.joinLink', 'Join the video meeting')}
              </a>
            )}
            <p className="text-xs text-muted-foreground">
              {t('publicBooking.emailed', 'A confirmation with a calendar invite has been sent.')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <CalendarClock className="h-7 w-7 text-primary" />
        <h1 className="text-2xl font-semibold text-foreground">
          {t('publicBooking.title', 'Book a time')}
        </h1>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">{t('common.loading', 'Loading…')}</p>
      ) : slots.length === 0 ? (
        <p className="text-muted-foreground">{t('publicBooking.noSlots', 'No available times in the next two weeks.')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Slot grid */}
          <div className="space-y-4">
            {byDay.map(([day, isos]) => (
              <div key={day}>
                <p className="mb-2 text-sm font-medium text-foreground">{day}</p>
                <div className="flex flex-wrap gap-2">
                  {isos.map((iso) => (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => setSelected(iso)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition ${
                        selected === iso
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border hover:border-primary'
                      }`}
                    >
                      {timeFmt(iso)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Details form */}
          <Card>
            <CardContent className="space-y-3 pt-6">
              {selected ? (
                <p className="text-sm text-foreground">{fullFmt(selected)}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('publicBooking.pickSlot', 'Pick a time to continue.')}</p>
              )}
              <Input
                placeholder={t('publicBooking.name', 'Your name')}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <Input
                type="email"
                placeholder={t('publicBooking.email', 'Email')}
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
              <Input
                placeholder={t('publicBooking.phone', 'Phone (optional)')}
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
              <Input
                placeholder={t('publicBooking.notes', 'Notes (optional)')}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button
                className="w-full"
                loading={submitting}
                disabled={!selected || !form.name.trim()}
                onClick={reserve}
              >
                {t('publicBooking.reserve', 'Confirm booking')}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
