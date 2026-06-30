import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarDays, Trash2, Clipboard, Plus, Pencil } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
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
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from '@/components/ui/Table';
import { Label } from '@/components/ui/Label';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CalRow { id: string; name: string; slug: string; slotMinutes: number; active: boolean }
type Avail = Record<string, { start: string; end: string }[]>;

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * True when any availability window has end ≤ start. HH:mm strings compare
 * chronologically (zero-padded), so a plain `>=` is enough. The backend slices
 * windows with `for (s = start; s + slot <= end; …)`, so an inverted/equal
 * window yields ZERO bookable slots for that day — silently. Block the save and
 * surface it instead of letting the operator publish a calendar nobody can book.
 */
export function availabilityHasInvalidWindow(avail: Avail): boolean {
  return Object.values(avail ?? {}).some((windows) =>
    (windows ?? []).some((w) => !!w && !!w.start && !!w.end && w.start >= w.end),
  );
}

// ── Schema ────────────────────────────────────────────────────────────────────

const CALENDAR_TYPES = ['SINGLE', 'ROUND_ROBIN', 'COLLECTIVE', 'CLASS'] as const;
type CalendarType = (typeof CALENDAR_TYPES)[number];
const TEAM_TYPES: CalendarType[] = ['ROUND_ROBIN', 'COLLECTIVE'];

interface WorkspaceUser { id: string; firstName?: string; lastName?: string; email: string }

const calSchema = z.object({
  name: z.string().min(1, 'Required').max(120),
  slug: z.string().max(80).optional(),
  type: z.enum(CALENDAR_TYPES),
  capacity: z.coerce.number().int().min(1).max(1000),
  slotMinutes: z.coerce.number().int().min(5),
  bufferMinutes: z.coerce.number().int().min(0),
  timezone: z.string().min(1),
  availability: z.record(z.array(z.object({ start: z.string(), end: z.string() }))),
});
type CalFormValues = z.infer<typeof calSchema>;

/** A small curated IANA list; the backend accepts any valid IANA zone. */
const TIMEZONES = [
  'Europe/Istanbul', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai',
  'Asia/Tashkent', 'America/New_York', 'America/Los_Angeles', 'UTC',
];

const DEFAULT_VALUES: CalFormValues = {
  name: '',
  slug: '',
  type: 'SINGLE',
  capacity: 1,
  slotMinutes: 30,
  bufferMinutes: 0,
  timezone: 'Europe/Istanbul',
  availability: {},
};

// ── Component ────────────────────────────────────────────────────────────────

export default function BookingSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const wsId = (useMarketingAuthStore().user as any)?.workspaceId as string | undefined;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CalFormValues>({
    resolver: zodResolver(calSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const availability = watch('availability');

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: cals } = useQuery<CalRow[]>({
    queryKey: ['marketing', 'calendars'],
    queryFn: () => marketingApi.get('/calendars').then((r) => r.data),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'calendars'] });

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const calType = watch('type');
  const [members, setMembers] = useState<string[]>([]);

  // Workspace users — only fetched when picking team members for a RR/collective.
  const { data: users } = useQuery<WorkspaceUser[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: dialogOpen && TEAM_TYPES.includes(calType),
  });

  const save = useMutation({
    mutationFn: async (values: CalFormValues) => {
      const payload = {
        name: values.name,
        slug: values.slug || undefined,
        type: values.type,
        capacity: values.type === 'CLASS' ? Number(values.capacity) : 1,
        slotMinutes: Number(values.slotMinutes),
        bufferMinutes: Number(values.bufferMinutes),
        timezone: values.timezone,
        availability: values.availability,
      };
      const saved = editId
        ? await marketingApi.patch(`/calendars/${editId}`, payload).then((r) => r.data)
        : await marketingApi.post('/calendars', payload).then((r) => r.data);
      // Persist the team-member set for round-robin / collective calendars.
      if (TEAM_TYPES.includes(values.type) && saved?.id) {
        await marketingApi.post(`/calendars/${saved.id}/members`, {
          members: members.map((marketingUserId, i) => ({ marketingUserId, priority: i })),
        });
      }
      return saved;
    },
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditId(null);
      setMembers([]);
      reset(DEFAULT_VALUES);
      toast.success(t('booking.saved', 'Calendar saved'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('booking.saveFailed', 'Save failed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/calendars/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('booking.deleteFailed', 'Could not delete the calendar')),
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditId(null);
    setMembers([]);
    reset(DEFAULT_VALUES);
    setDialogOpen(true);
  };

  const openEdit = async (c: CalRow) => {
    const full = await marketingApi.get(`/calendars/${c.id}`).then((r) => r.data);
    setEditId(full.id);
    reset({
      name: full.name,
      slug: full.slug,
      type: (full.type as CalendarType) ?? 'SINGLE',
      capacity: full.capacity ?? 1,
      slotMinutes: full.slotMinutes,
      bufferMinutes: full.bufferMinutes,
      timezone: full.timezone ?? 'Europe/Istanbul',
      availability: full.availability ?? {},
    });
    // Load existing members for team calendars.
    if (TEAM_TYPES.includes((full.type as CalendarType) ?? 'SINGLE')) {
      const ms = await marketingApi.get(`/calendars/${full.id}/members`).then((r) => r.data);
      setMembers(Array.isArray(ms) ? ms.map((m: { marketingUserId: string }) => m.marketingUserId) : []);
    } else {
      setMembers([]);
    }
    setDialogOpen(true);
  };

  const toggleMember = (id: string, on: boolean) =>
    setMembers((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  const userLabel = (u: WorkspaceUser) =>
    [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email;

  const publicUrl = (slug: string) =>
    `${window.location.origin}/api/public/book/${wsId ?? ':workspace'}/${slug}`;

  const dayOn = (i: number) => (availability[String(i)]?.length ?? 0) > 0;

  const toggleDay = (i: number, on: boolean) => {
    const avail = { ...availability };
    if (on) avail[String(i)] = [{ start: '09:00', end: '17:00' }];
    else delete avail[String(i)];
    setValue('availability', avail, { shouldValidate: true });
  };

  const setWindow = (i: number, key: 'start' | 'end', v: string) => {
    const avail = { ...availability };
    const w = avail[String(i)]?.[0] ?? { start: '09:00', end: '17:00' };
    avail[String(i)] = [{ ...w, [key]: v }];
    setValue('availability', avail, { shouldValidate: true });
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('booking.title', 'Booking')}
        description={t('booking.subtitle', "Let leads book a slot. Availability windows use the calendar's timezone.")}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('booking.new', 'New calendar')}
          </Button>
        }
      />

      {/* Calendars list */}
      {(cals ?? []).length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-10 w-10" />}
          title={t('booking.empty', 'No calendars yet')}
          description={t('booking.emptyDesc', 'Create one to let leads book time.')}
          action={
            <Button onClick={openCreate} size="sm">
              <Plus className="h-4 w-4" />
              {t('booking.new', 'New calendar')}
            </Button>
          }
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>{t('booking.name', 'Name')}</TH>
                <TH>{t('booking.slot', 'Slot')}</TH>
                <TH>{t('booking.status', 'Status')}</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {(cals ?? []).map((c) => (
                <TR key={c.id}>
                  <TD>
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      <CalendarDays className="h-4 w-4 text-primary shrink-0" />
                      <span>
                        {c.name}
                        <span className="block text-xs text-muted-foreground">/{c.slug}</span>
                      </span>
                    </span>
                  </TD>
                  <TD className="text-muted-foreground text-sm">{c.slotMinutes}min</TD>
                  <TD>
                    <Badge tone={c.active ? 'success' : 'neutral'}>
                      {c.active ? t('common.active', 'Active') : t('common.inactive', 'Inactive')}
                    </Badge>
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        aria-label={t('booking.copyUrl', 'Copy booking link')}
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          navigator.clipboard.writeText(publicUrl(c.slug));
                          toast.success(t('common.copied', 'Copied'));
                        }}
                      >
                        <Clipboard className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        aria-label={t('common.edit', 'Edit')}
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(c)}
                      >
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        aria-label={t('common.delete', 'Delete')}
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:text-danger"
                        onClick={() => setDeleteTarget(c.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {/* Create / Edit dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) { setDialogOpen(false); setEditId(null); reset(DEFAULT_VALUES); }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editId ? t('booking.editCalendar', 'Edit calendar') : t('booking.new', 'New calendar')}
            </DialogTitle>
            <DialogDescription>
              {t('booking.dialogDesc', "Configure name, slot duration, and weekly availability windows (in the calendar's timezone).")}
            </DialogDescription>
          </DialogHeader>

          <form
            id="booking-form"
            onSubmit={handleSubmit((v) => save.mutate(v))}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Field
                label={t('booking.name', 'Name')}
                error={errors.name?.message}
                required
                className="sm:col-span-2"
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    maxLength={120}
                    {...register('name')}
                  />
                )}
              </Field>
              <Field label={t('booking.slot', 'Slot (min)')} error={errors.slotMinutes?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="number"
                    {...register('slotMinutes')}
                  />
                )}
              </Field>
              <Field label={t('booking.timezone', 'Timezone')} error={errors.timezone?.message}>
                {({ id }) => (
                  <select id={id} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" {...register('timezone')}>
                    {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                )}
              </Field>
              <Field label={t('booking.buffer', 'Buffer (min)')} error={errors.bufferMinutes?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="number"
                    {...register('bufferMinutes')}
                  />
                )}
              </Field>
            </div>

            {/* Calendar type + capacity */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label={t('booking.type', 'Calendar type')}
                hint={t('booking.typeHint', 'How bookings are distributed across your team.')}
              >
                {({ id, describedBy }) => (
                  <Select
                    value={calType}
                    onValueChange={(v) => setValue('type', v as CalendarType, { shouldValidate: true })}
                  >
                    <SelectTrigger id={id} aria-describedby={describedBy}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CALENDAR_TYPES.map((ty) => (
                        <SelectItem key={ty} value={ty}>
                          {t(`booking.calType.${ty}`, ty)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              {calType === 'CLASS' && (
                <Field
                  label={t('booking.capacity', 'Capacity per slot')}
                  hint={t('booking.capacityHint', 'Max attendees for a group/class slot.')}
                  error={errors.capacity?.message}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} type="number" min={1} {...register('capacity')} />
                  )}
                </Field>
              )}
            </div>

            {/* Team members (round-robin / collective) */}
            {TEAM_TYPES.includes(calType) && (
              <Card>
                <CardContent className="pt-4 space-y-2">
                  <Label>{t('booking.members', 'Team members')}</Label>
                  <p className="text-micro text-muted-foreground">
                    {calType === 'ROUND_ROBIN'
                      ? t('booking.membersRoundRobin', 'Bookings are distributed one-by-one across these members.')
                      : t('booking.membersCollective', 'All these members are booked together for each slot.')}
                  </p>
                  <div className="max-h-48 space-y-1.5 overflow-y-auto">
                    {(users ?? []).map((u) => (
                      <label key={u.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={members.includes(u.id)}
                          onCheckedChange={(c) => toggleMember(u.id, !!c)}
                        />
                        {userLabel(u)}
                      </label>
                    ))}
                    {(users ?? []).length === 0 && (
                      <p className="text-micro text-muted-foreground">
                        {t('booking.noUsers', 'No team members to assign.')}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Availability */}
            <Card>
              <CardContent className="pt-4 space-y-2">
                <Label>{t('booking.availability', 'Weekly availability (calendar timezone)')}</Label>
                {DAYS.map((d, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex w-28 items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={dayOn(i)}
                        onCheckedChange={(checked) => toggleDay(i, !!checked)}
                      />
                      <span className="text-foreground">{t(`booking.day.${i}`, d)}</span>
                    </label>
                    {dayOn(i) && (
                      <>
                        <Input
                          type="time"
                          value={availability[String(i)]?.[0]?.start ?? '09:00'}
                          onChange={(e) => setWindow(i, 'start', e.target.value)}
                          className="w-36"
                        />
                        <span className="text-muted-foreground">–</span>
                        <Input
                          type="time"
                          value={availability[String(i)]?.[0]?.end ?? '17:00'}
                          onChange={(e) => setWindow(i, 'end', e.target.value)}
                          className="w-36"
                        />
                      </>
                    )}
                  </div>
                ))}
                {availabilityHasInvalidWindow(availability) && (
                  <p className="text-xs text-danger">
                    {t('booking.invalidWindow', "Each day's end time must be after its start time.")}
                  </p>
                )}
              </CardContent>
            </Card>
          </form>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => { setDialogOpen(false); setEditId(null); reset(DEFAULT_VALUES); }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              form="booking-form"
              loading={save.isPending || isSubmitting}
              disabled={availabilityHasInvalidWindow(availability)}
            >
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('booking.deleteTitle', 'Delete calendar?')}
        description={t('booking.deleteDesc', 'This action cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        loading={remove.isPending}
      />
    </div>
  );
}
