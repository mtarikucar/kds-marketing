import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarClock, Video, Check, X, UserX, CalendarCheck } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import {
  listCalendars,
  listBookings,
  cancelBooking,
  createBooking,
  rescheduleBooking,
  setBookingStatus,
  type Booking,
  type CreateBookingPayload,
} from '../../../features/marketing/api/booking.service';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  CONFIRMED: 'success',
  PENDING: 'warning',
  CANCELLED: 'danger',
  NO_SHOW: 'danger',
  COMPLETED: 'neutral',
  RESCHEDULED: 'neutral',
};

/** 'YYYY-MM-DDTHH:mm' (local) for a datetime-local input, from an ISO instant. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AppointmentsPage() {
  const { t, i18n } = useTranslation('marketing');
  const qc = useQueryClient();
  const [calendarId, setCalendarId] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [reschedule, setReschedule] = useState<{ booking: Booking; value: string } | null>(null);
  const [createForm, setCreateForm] = useState<{
    calendarId: string; start: string; name: string; email: string; phone: string; notes: string;
  } | null>(null);

  const { data: calendars } = useQuery({
    queryKey: ['marketing', 'calendars'],
    queryFn: listCalendars,
  });

  const filter = useMemo(
    () => ({
      ...(calendarId !== 'ALL' ? { calendarId } : {}),
      ...(statusFilter !== 'ALL' ? { status: statusFilter } : {}),
    }),
    [calendarId, statusFilter],
  );

  const { data: bookings, isLoading } = useQuery({
    queryKey: ['marketing', 'appointments', filter],
    queryFn: () => listBookings(filter),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['marketing', 'appointments'] });

  const cancelM = useMutation({
    mutationFn: (id: string) => cancelBooking(id),
    onSuccess: () => { invalidate(); setCancelTarget(null); toast.success(t('appointments.cancelled', 'Appointment cancelled')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? e.message ?? t('appointments.actionFailed', 'Action failed')),
  });

  const statusM = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'NO_SHOW' | 'COMPLETED' | 'CONFIRMED' }) =>
      setBookingStatus(id, status),
    onSuccess: () => { invalidate(); toast.success(t('appointments.updated', 'Appointment updated')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? e.message ?? t('appointments.actionFailed', 'Action failed')),
  });

  const rescheduleM = useMutation({
    mutationFn: ({ id, start }: { id: string; start: string }) => rescheduleBooking(id, start),
    onSuccess: () => { invalidate(); setReschedule(null); toast.success(t('appointments.rescheduled', 'Appointment rescheduled')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? e.message ?? t('appointments.actionFailed', 'Action failed')),
  });

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  const calName = (id: string) => calendars?.find((c) => c.id === id)?.name ?? '—';

  const createM = useMutation({
    mutationFn: (payload: CreateBookingPayload) => createBooking(payload),
    onSuccess: () => {
      invalidate();
      setCreateForm(null);
      toast.success(t('appointments.created', 'Appointment booked'));
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ||
          t('appointments.createFailed', 'Could not book — check the time is within the calendar’s availability'),
      ),
  });

  const openCreate = () =>
    setCreateForm({
      calendarId: calendars?.[0]?.id ?? '',
      start: toLocalInput(new Date(Date.now() + 3600_000).toISOString()),
      name: '', email: '', phone: '', notes: '',
    });

  const submitCreate = () => {
    if (!createForm) return;
    createM.mutate({
      calendarId: createForm.calendarId,
      start: new Date(createForm.start).toISOString(),
      name: createForm.name.trim(),
      email: createForm.email.trim() || undefined,
      phone: createForm.phone.trim() || undefined,
      notes: createForm.notes.trim() || undefined,
      attendeeTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  };
  const rows = bookings ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('appointments.title', 'Appointments')}
        description={t('appointments.subtitle', 'Booked appointments across your calendars. Reschedule, confirm, or mark outcomes.')}
        actions={
          <Button onClick={openCreate} disabled={!calendars?.length}>
            <CalendarCheck className="h-4 w-4" />
            {t('appointments.new', 'New appointment')}
          </Button>
        }
      />

      {createForm && (
        <Dialog open onOpenChange={(o) => { if (!o) setCreateForm(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('appointments.new', 'New appointment')}</DialogTitle>
              <DialogDescription>
                {t('appointments.newDesc', 'Book a slot on one of your calendars. The time must be within its availability.')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Select
                value={createForm.calendarId}
                onValueChange={(v) => setCreateForm((f) => (f ? { ...f, calendarId: v } : f))}
              >
                <SelectTrigger><SelectValue placeholder={t('appointments.calendar', 'Calendar')} /></SelectTrigger>
                <SelectContent>
                  {calendars?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input
                type="datetime-local"
                value={createForm.start}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, start: e.target.value } : f))}
              />
              <Input
                placeholder={t('appointments.attendeeName', 'Attendee name')}
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, name: e.target.value } : f))}
              />
              <Input
                type="email"
                placeholder={t('appointments.attendeeEmail', 'Email (optional)')}
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, email: e.target.value } : f))}
              />
              <Input
                placeholder={t('appointments.attendeePhone', 'Phone (optional)')}
                value={createForm.phone}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, phone: e.target.value } : f))}
              />
              <Input
                placeholder={t('appointments.notes', 'Notes (optional)')}
                value={createForm.notes}
                onChange={(e) => setCreateForm((f) => (f ? { ...f, notes: e.target.value } : f))}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateForm(null)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                onClick={submitCreate}
                loading={createM.isPending}
                disabled={!createForm.calendarId || !createForm.name.trim() || !createForm.start}
              >
                {t('appointments.book', 'Book')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <div className="flex flex-wrap gap-3">
        <Select value={calendarId} onValueChange={setCalendarId}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('appointments.allCalendars', 'All calendars')}</SelectItem>
            {(calendars ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {['ALL', 'CONFIRMED', 'PENDING', 'COMPLETED', 'NO_SHOW', 'CANCELLED'].map((s) => (
              <SelectItem key={s} value={s}>
                {s === 'ALL' ? t('appointments.allStatuses', 'All statuses') : t(`appointments.status.${s}`, s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!isLoading && rows.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="h-10 w-10" />}
          title={t('appointments.empty', 'No appointments')}
          description={t('appointments.emptyDesc', 'Booked appointments will show up here.')}
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>{t('appointments.who', 'Who')}</TH>
                <TH>{t('appointments.calendar', 'Calendar')}</TH>
                <TH>{t('appointments.when', 'When')}</TH>
                <TH>{t('appointments.statusCol', 'Status')}</TH>
                <TH>{t('appointments.meeting', 'Meeting')}</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {rows.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <span className="font-medium text-foreground">{b.name}</span>
                    {b.email && <span className="block text-xs text-muted-foreground">{b.email}</span>}
                  </TD>
                  <TD className="text-sm text-muted-foreground">{calName(b.calendarId)}</TD>
                  <TD className="text-sm">{fmt(b.startAt)}</TD>
                  <TD>
                    <Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>
                      {t(`appointments.status.${b.status}`, b.status)}
                    </Badge>
                  </TD>
                  <TD>
                    {b.meetingUrl ? (
                      <a
                        href={b.meetingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        <Video className="h-4 w-4" />
                        {b.conferenceProvider === 'TEAMS' ? 'Teams' : 'Meet'}
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      {b.status === 'PENDING' && (
                        <IconButton
                          aria-label={t('appointments.approve', 'Approve')}
                          size="sm" variant="ghost" className="text-success"
                          onClick={() => statusM.mutate({ id: b.id, status: 'CONFIRMED' })}
                        >
                          <Check className="h-4 w-4" />
                        </IconButton>
                      )}
                      {(b.status === 'CONFIRMED' || b.status === 'PENDING') && (
                        <>
                          <IconButton
                            aria-label={t('appointments.reschedule', 'Reschedule')}
                            size="sm" variant="ghost"
                            onClick={() => setReschedule({ booking: b, value: toLocalInput(b.startAt) })}
                          >
                            <CalendarCheck className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            aria-label={t('appointments.noShow', 'No-show')}
                            size="sm" variant="ghost"
                            onClick={() => statusM.mutate({ id: b.id, status: 'NO_SHOW' })}
                          >
                            <UserX className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            aria-label={t('appointments.complete', 'Complete')}
                            size="sm" variant="ghost"
                            onClick={() => statusM.mutate({ id: b.id, status: 'COMPLETED' })}
                          >
                            <Check className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            aria-label={t('common.cancel', 'Cancel')}
                            size="sm" variant="ghost" className="text-danger hover:text-danger"
                            onClick={() => setCancelTarget(b.id)}
                          >
                            <X className="h-4 w-4" />
                          </IconButton>
                        </>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {/* Reschedule dialog */}
      <Dialog open={!!reschedule} onOpenChange={(o) => { if (!o) setReschedule(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('appointments.reschedule', 'Reschedule')}</DialogTitle>
            <DialogDescription>
              {t('appointments.rescheduleDesc', 'Pick a new time. The backend re-validates availability, notice and buffers.')}
            </DialogDescription>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={reschedule?.value ?? ''}
            onChange={(e) => setReschedule((r) => (r ? { ...r, value: e.target.value } : r))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReschedule(null)}>{t('common.cancel', 'Cancel')}</Button>
            <Button
              loading={rescheduleM.isPending}
              disabled={!reschedule?.value}
              onClick={() => {
                if (!reschedule?.value) return;
                const iso = new Date(reschedule.value).toISOString();
                rescheduleM.mutate({ id: reschedule.booking.id, start: iso });
              }}
            >
              {t('appointments.confirmReschedule', 'Reschedule')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(o) => { if (!o) setCancelTarget(null); }}
        title={t('appointments.cancelTitle', 'Cancel appointment?')}
        description={t('appointments.cancelDesc', 'The attendee will lose this slot and any meeting link.')}
        confirmLabel={t('common.confirm', 'Confirm')}
        tone="danger"
        onConfirm={() => cancelTarget && cancelM.mutate(cancelTarget)}
        loading={cancelM.isPending}
      />
    </div>
  );
}
