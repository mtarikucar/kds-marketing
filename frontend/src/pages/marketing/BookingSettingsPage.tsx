import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarDaysIcon, TrashIcon, ClipboardIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';

interface CalRow { id: string; name: string; slug: string; slotMinutes: number; active: boolean }
type Avail = Record<string, { start: string; end: string }[]>;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMPTY = { id: '', name: '', slug: '', slotMinutes: 30, bufferMinutes: 0, availability: {} as Avail };

export default function BookingSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const wsId = (useMarketingAuthStore().user as any)?.workspaceId as string | undefined;
  const [form, setForm] = useState({ ...EMPTY });
  const [showForm, setShowForm] = useState(false);

  const { data: cals } = useQuery<CalRow[]>({ queryKey: ['marketing', 'calendars'], queryFn: () => marketingApi.get('/calendars').then((r) => r.data) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'calendars'] });
  const reset = () => { setForm({ ...EMPTY }); setShowForm(false); };

  const save = useMutation({
    mutationFn: () => {
      const payload = { name: form.name, slug: form.slug || undefined, slotMinutes: Number(form.slotMinutes), bufferMinutes: Number(form.bufferMinutes), availability: form.availability };
      return form.id ? marketingApi.patch(`/calendars/${form.id}`, payload) : marketingApi.post('/calendars', payload);
    },
    onSuccess: () => { invalidate(); reset(); toast.success(t('booking.saved', 'Calendar saved')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('booking.saveFailed', 'Save failed')),
  });
  const remove = useMutation({ mutationFn: (id: string) => marketingApi.delete(`/calendars/${id}`), onSuccess: invalidate });

  const edit = async (c: CalRow) => {
    const full = await marketingApi.get(`/calendars/${c.id}`).then((r) => r.data);
    setForm({ id: full.id, name: full.name, slug: full.slug, slotMinutes: full.slotMinutes, bufferMinutes: full.bufferMinutes, availability: full.availability ?? {} });
    setShowForm(true);
  };

  const dayOn = (d: number) => (form.availability[String(d)]?.length ?? 0) > 0;
  const setDay = (d: number, on: boolean, start = '09:00', end = '17:00') => {
    const a = { ...form.availability };
    if (on) a[String(d)] = [{ start, end }]; else delete a[String(d)];
    setForm({ ...form, availability: a });
  };
  const setWindow = (d: number, key: 'start' | 'end', v: string) => {
    const a = { ...form.availability };
    const w = a[String(d)]?.[0] ?? { start: '09:00', end: '17:00' };
    a[String(d)] = [{ ...w, [key]: v }];
    setForm({ ...form, availability: a });
  };
  const publicUrl = (slug: string) => `${window.location.origin}/api/public/book/${wsId ?? ':workspace'}/${slug}`;

  const inputCls = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('booking.title', 'Booking')}</h1>
          <p className="text-sm text-slate-500">{t('booking.subtitle', 'Let leads book a slot. Availability windows are in UTC for now.')}</p>
        </div>
        <button onClick={() => { setForm({ ...EMPTY }); setShowForm(true); }} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90">{t('booking.new', 'New calendar')}</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="sm:col-span-2"><label className={labelCls}>{t('booking.name', 'Name')}</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${inputCls} w-full`} maxLength={120} /></div>
            <div><label className={labelCls}>{t('booking.slot', 'Slot (min)')}</label><input type="number" value={form.slotMinutes} onChange={(e) => setForm({ ...form, slotMinutes: Number(e.target.value) })} className={`${inputCls} w-full`} /></div>
            <div><label className={labelCls}>{t('booking.buffer', 'Buffer (min)')}</label><input type="number" value={form.bufferMinutes} onChange={(e) => setForm({ ...form, bufferMinutes: Number(e.target.value) })} className={`${inputCls} w-full`} /></div>
          </div>
          <div>
            <label className={labelCls}>{t('booking.availability', 'Weekly availability (UTC)')}</label>
            <div className="space-y-1.5">
              {DAYS.map((d, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="w-28 flex items-center gap-2"><input type="checkbox" checked={dayOn(i)} onChange={(e) => setDay(i, e.target.checked)} />{t(`booking.day.${i}`, d)}</label>
                  {dayOn(i) && (
                    <>
                      <input type="time" value={form.availability[String(i)][0].start} onChange={(e) => setWindow(i, 'start', e.target.value)} className={inputCls} />
                      <span className="text-slate-400">–</span>
                      <input type="time" value={form.availability[String(i)][0].end} onChange={(e) => setWindow(i, 'end', e.target.value)} className={inputCls} />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={reset} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">{t('common.cancel', 'Cancel')}</button>
            <button onClick={() => save.mutate()} disabled={save.isPending || !form.name} className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50">{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(cals ?? []).map((c) => (
          <div key={c.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <CalendarDaysIcon className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-slate-900 truncate">{c.name}</div>
                <div className="text-xs text-slate-400 flex items-center gap-2">{c.slotMinutes}min · /{c.slug}
                  <button onClick={() => { navigator.clipboard.writeText(publicUrl(c.slug)); toast.success(t('common.copied', 'Copied')); }} className="text-primary hover:underline flex items-center gap-0.5"><ClipboardIcon className="w-3 h-3" />{t('booking.copyUrl', 'booking link')}</button>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => edit(c)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">{t('common.edit', 'Edit')}</button>
              <button onClick={() => remove.mutate(c.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50"><TrashIcon className="w-4 h-4" /></button>
            </div>
          </div>
        ))}
        {(cals ?? []).length === 0 && !showForm && <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">{t('booking.empty', 'No calendars yet — create one to let leads book time.')}</div>}
      </div>
    </div>
  );
}
