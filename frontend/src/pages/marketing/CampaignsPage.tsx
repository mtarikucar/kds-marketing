import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MegaphoneIcon,
  TrashIcon,
  PaperAirplaneIcon,
  SparklesIcon,
  PlusIcon,
  PauseCircleIcon,
  PlayCircleIcon,
} from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface CampaignRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  stats?: Record<string, number> | null;
}
interface FilterRow { field: string; op: string; value: string }

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'];
const FILTER_FIELDS = ['status', 'city', 'businessType', 'priority', 'source'];
const OPS = ['eq', 'neq', 'in', 'contains', 'gte', 'lte'];

const EMPTY = { id: '', name: '', channel: 'EMAIL', subject: '', body: '', filters: [] as FilterRow[] };

export default function CampaignsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ ...EMPTY });
  const [showForm, setShowForm] = useState(false);
  const [aiGoal, setAiGoal] = useState('');

  const { data: campaigns } = useQuery<CampaignRow[]>({
    queryKey: ['marketing', 'campaigns'],
    queryFn: () => marketingApi.get('/campaigns').then((r) => r.data),
    refetchInterval: 15_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'campaigns'] });
  const reset = () => { setForm({ ...EMPTY }); setShowForm(false); setAiGoal(''); };

  const payload = () => ({
    name: form.name,
    channel: form.channel,
    subject: form.subject || undefined,
    body: form.body,
    audienceFilter: form.filters
      .filter((f) => f.field && f.value)
      .map((f) => ({ field: `lead.${f.field}`, op: f.op, value: f.op === 'in' ? f.value.split(',').map((s) => s.trim()) : f.value })),
  });

  const save = useMutation({
    mutationFn: () => (form.id ? marketingApi.patch(`/campaigns/${form.id}`, payload()) : marketingApi.post('/campaigns', payload())),
    onSuccess: () => { invalidate(); reset(); toast.success(t('campaigns.saved', 'Campaign saved')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('campaigns.saveFailed', 'Save failed')),
  });
  const compose = useMutation({
    mutationFn: () => marketingApi.post('/ai/compose', {
      kind: form.channel === 'EMAIL' ? 'email' : form.channel === 'SMS' ? 'sms' : 'social',
      goal: aiGoal,
    }),
    onSuccess: ({ data }) => {
      setForm((f) => ({ ...f, subject: data.subject ?? f.subject, body: data.body ?? f.body }));
      toast.success(t('campaigns.composed', 'Draft ready'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('campaigns.composeFailed', 'Compose failed')),
  });
  const launch = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/campaigns/${id}/launch`),
    onSuccess: ({ data }) => { invalidate(); toast.success(t('campaigns.launched', `Launched to ${data.recipients} recipients`)); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('campaigns.launchFailed', 'Launch failed')),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => marketingApi.post(`/campaigns/${id}/${action}`),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => marketingApi.delete(`/campaigns/${id}`), onSuccess: invalidate });

  const edit = async (c: CampaignRow) => {
    const full = await marketingApi.get(`/campaigns/${c.id}`).then((r) => r.data);
    setForm({
      id: full.id, name: full.name, channel: full.channel, subject: full.subject ?? '', body: full.body,
      filters: (full.audienceFilter ?? []).map((f: any) => ({ field: String(f.field).replace('lead.', ''), op: f.op, value: Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '') })),
    });
    setShowForm(true);
  };

  const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('campaigns.title', 'Campaigns')}</h1>
          <p className="text-sm text-slate-500">{t('campaigns.subtitle', 'Blast email, SMS or WhatsApp to a filtered slice of your leads. Opt-outs and an unsubscribe link are handled for you.')}</p>
        </div>
        <button onClick={() => { setForm({ ...EMPTY }); setShowForm(true); }} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90">
          {t('campaigns.new', 'New campaign')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className={labelCls}>{t('campaigns.name', 'Name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} maxLength={120} />
            </div>
            <div>
              <label className={labelCls}>{t('campaigns.channel', 'Channel')}</label>
              <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} className={inputCls}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Audience builder */}
          <div>
            <label className={labelCls}>{t('campaigns.audience', 'Audience (leads matching all rules; empty = everyone opted-in)')}</label>
            <div className="space-y-2">
              {form.filters.map((f, i) => (
                <div key={i} className="flex gap-2">
                  <select value={f.field} onChange={(e) => { const fs = [...form.filters]; fs[i] = { ...f, field: e.target.value }; setForm({ ...form, filters: fs }); }} className={inputCls}>
                    <option value="">{t('campaigns.field', 'field')}</option>
                    {FILTER_FIELDS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <select value={f.op} onChange={(e) => { const fs = [...form.filters]; fs[i] = { ...f, op: e.target.value }; setForm({ ...form, filters: fs }); }} className={inputCls}>
                    {OPS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <input value={f.value} onChange={(e) => { const fs = [...form.filters]; fs[i] = { ...f, value: e.target.value }; setForm({ ...form, filters: fs }); }} className={inputCls} placeholder={t('campaigns.value', 'value')} />
                  <button onClick={() => setForm({ ...form, filters: form.filters.filter((_, j) => j !== i) })} className="p-2 text-red-400 hover:bg-red-50 rounded-lg shrink-0"><TrashIcon className="w-4 h-4" /></button>
                </div>
              ))}
              <button onClick={() => setForm({ ...form, filters: [...form.filters, { field: '', op: 'eq', value: '' }] })} className="text-xs text-primary hover:underline flex items-center gap-1"><PlusIcon className="w-3 h-3" />{t('campaigns.addRule', 'Add rule')}</button>
            </div>
          </div>

          {/* AI compose */}
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex gap-2">
            <input value={aiGoal} onChange={(e) => setAiGoal(e.target.value)} className={inputCls} placeholder={t('campaigns.aiGoal', 'Goal — e.g. announce a 20% spring discount')} />
            <button onClick={() => compose.mutate()} disabled={!aiGoal.trim() || compose.isPending} className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 shrink-0 flex items-center gap-1">
              <SparklesIcon className="w-4 h-4" />{compose.isPending ? '…' : t('campaigns.write', 'Write')}
            </button>
          </div>

          {form.channel === 'EMAIL' && (
            <div>
              <label className={labelCls}>{t('campaigns.subject', 'Subject')}</label>
              <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} className={inputCls} maxLength={200} />
            </div>
          )}
          <div>
            <label className={labelCls}>{t('campaigns.body', 'Message')}</label>
            <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} className={`${inputCls} min-h-40`} maxLength={20000} placeholder="Hi {{lead.contactPerson}}, …" />
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={reset} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">{t('common.cancel', 'Cancel')}</button>
            <button onClick={() => save.mutate()} disabled={save.isPending || !form.name || !form.body} className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50">
              {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(campaigns ?? []).map((c) => (
          <div key={c.id} className="bg-white rounded-xl border border-slate-200 p-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <MegaphoneIcon className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-slate-900 flex items-center gap-2">
                  <span className="truncate">{c.name}</span>
                  <span className="text-xs uppercase text-slate-400">{c.channel}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${
                    c.status === 'SENT' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : c.status === 'SENDING' ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : c.status === 'PAUSED' ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-slate-100 text-slate-500 border-slate-200'
                  }`}>{c.status}</span>
                </div>
                {c.stats && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    {c.stats.sent ?? 0}/{c.stats.recipients ?? 0} {t('campaigns.sent', 'sent')} · {c.stats.opened ?? 0} {t('campaigns.opened', 'opened')} · {c.stats.clicked ?? 0} {t('campaigns.clicked', 'clicked')} · {c.stats.unsubscribed ?? 0} {t('campaigns.unsub', 'unsub')}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(c.status === 'DRAFT') && (
                <button onClick={() => launch.mutate(c.id)} className="px-2.5 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 flex items-center gap-1"><PaperAirplaneIcon className="w-3.5 h-3.5" />{t('campaigns.launch', 'Launch')}</button>
              )}
              {c.status === 'SENDING' && <button onClick={() => act.mutate({ id: c.id, action: 'pause' })} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"><PauseCircleIcon className="w-5 h-5" /></button>}
              {c.status === 'PAUSED' && <button onClick={() => act.mutate({ id: c.id, action: 'resume' })} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"><PlayCircleIcon className="w-5 h-5" /></button>}
              {(c.status === 'DRAFT') && <button onClick={() => edit(c)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">{t('common.edit', 'Edit')}</button>}
              <button onClick={() => remove.mutate(c.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50"><TrashIcon className="w-4 h-4" /></button>
            </div>
          </div>
        ))}
        {(campaigns ?? []).length === 0 && !showForm && (
          <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">{t('campaigns.empty', 'No campaigns yet — create one and let AI write the copy.')}</div>
        )}
      </div>
    </div>
  );
}
