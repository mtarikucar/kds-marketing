import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  BoltIcon,
  TrashIcon,
  PlayCircleIcon,
  PauseCircleIcon,
  SparklesIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  trigger?: { type?: string };
  version: number;
  stats?: { started?: number; completed?: number } | null;
}

const TRIGGER_TYPES = [
  'lead.created',
  'lead.status_changed',
  'conversation.message.received',
  'form.submitted',
  'booking.created',
  'review.received',
  'task.completed',
];

// Palette: clicking appends a template step to the JSON the user is editing.
const STEP_TEMPLATES: Record<string, unknown> = {
  send_email: { type: 'send_email', subject: 'Hello', body: 'Hi {{lead.contactPerson}}, …' },
  send_whatsapp: { type: 'send_whatsapp', body: 'Hi {{lead.contactPerson}} 👋' },
  send_sms: { type: 'send_sms', body: 'Hi {{lead.contactPerson}}' },
  ai_generate: { type: 'ai_generate', prompt: 'Write a friendly opener for {{lead.businessName}}', saveAs: 'opener' },
  wait: { type: 'wait', mode: 'duration', seconds: 86400 },
  branch: { type: 'branch', filters: [{ field: 'lead.status', op: 'eq', value: 'NEW' }] },
  create_task: { type: 'create_task', title: 'Follow up with {{lead.contactPerson}}', dueInHours: 24 },
  assign_lead: { type: 'assign_lead', strategy: 'auto' },
  update_lead: { type: 'update_lead', set: { status: 'CONTACTED' } },
  notify_user: { type: 'notify_user', message: 'New lead {{lead.businessName}} entered the workflow' },
  stop_workflow: { type: 'stop_workflow' },
};

const EMPTY = { id: '', name: '', triggerType: 'lead.created', filters: '[]', steps: '[]' };

export default function AutomationsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ ...EMPTY });
  const [showForm, setShowForm] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');

  const { data: workflows } = useQuery<WorkflowRow[]>({
    queryKey: ['marketing', 'workflows'],
    queryFn: () => marketingApi.get('/workflows').then((r) => r.data),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'workflows'] });
  const reset = () => { setForm({ ...EMPTY }); setShowForm(false); setAiPrompt(''); };

  const parseOrThrow = () => {
    let filters: unknown;
    let steps: unknown;
    try { filters = JSON.parse(form.filters || '[]'); } catch { throw new Error(t('automations.badFilters', 'Trigger filters are not valid JSON')); }
    try { steps = JSON.parse(form.steps || '[]'); } catch { throw new Error(t('automations.badSteps', 'Steps are not valid JSON')); }
    return { name: form.name, trigger: { type: form.triggerType, filters }, steps };
  };

  const save = useMutation({
    mutationFn: () => {
      const payload = parseOrThrow();
      return form.id
        ? marketingApi.patch(`/workflows/${form.id}`, payload)
        : marketingApi.post('/workflows', payload);
    },
    onSuccess: () => { invalidate(); reset(); toast.success(t('automations.saved', 'Automation saved')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? e.message ?? t('automations.saveFailed', 'Save failed')),
  });

  const draft = useMutation({
    mutationFn: () => marketingApi.post('/workflows/draft', { prompt: aiPrompt }),
    onSuccess: ({ data }) => {
      setForm((f) => ({
        ...f,
        triggerType: data.trigger?.type ?? f.triggerType,
        filters: JSON.stringify(data.trigger?.filters ?? [], null, 2),
        steps: JSON.stringify(data.steps ?? [], null, 2),
      }));
      toast.success(t('automations.drafted', 'Draft ready — review and save'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('automations.draftFailed', 'Could not draft')),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      marketingApi.post(`/workflows/${id}/status`, { status }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/workflows/${id}`),
    onSuccess: invalidate,
  });

  const edit = async (w: WorkflowRow) => {
    const full = await marketingApi.get(`/workflows/${w.id}`).then((r) => r.data);
    setForm({
      id: full.id,
      name: full.name,
      triggerType: full.trigger?.type ?? 'lead.created',
      filters: JSON.stringify(full.trigger?.filters ?? [], null, 2),
      steps: JSON.stringify(full.steps ?? [], null, 2),
    });
    setShowForm(true);
  };

  const appendStep = (key: string) => {
    let steps: unknown[];
    try { steps = JSON.parse(form.steps || '[]'); } catch { steps = []; }
    if (!Array.isArray(steps)) steps = [];
    steps.push(STEP_TEMPLATES[key]);
    setForm({ ...form, steps: JSON.stringify(steps, null, 2) });
  };

  const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('automations.title', 'Automations')}</h1>
          <p className="text-sm text-slate-500">
            {t('automations.subtitle', 'When something happens, do this. Triggers fire steps — send, wait, branch, create tasks, update leads.')}
          </p>
        </div>
        <button onClick={() => { setForm({ ...EMPTY }); setShowForm(true); }} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90">
          {t('automations.new', 'New automation')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          {/* AI assist */}
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
            <label className="text-xs font-medium text-primary flex items-center gap-1 mb-1">
              <SparklesIcon className="w-4 h-4" /> {t('automations.aiAssist', 'Describe it — AI drafts the steps')}
            </label>
            <div className="flex gap-2">
              <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} className={inputCls}
                placeholder={t('automations.aiPlaceholder', 'e.g. when a new lead comes in, wait 1 hour then send a WhatsApp intro and create a follow-up task')} />
              <button onClick={() => draft.mutate()} disabled={!aiPrompt.trim() || draft.isPending}
                className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 shrink-0">
                {draft.isPending ? t('automations.drafting', 'Drafting…') : t('automations.draftBtn', 'Draft')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('automations.name', 'Name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} maxLength={120} />
            </div>
            <div>
              <label className={labelCls}>{t('automations.trigger', 'Trigger')}</label>
              <select value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value })} className={inputCls}>
                {TRIGGER_TYPES.map((tt) => <option key={tt} value={tt}>{tt}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>{t('automations.filters', 'Trigger filters (JSON, optional)')}</label>
            <textarea value={form.filters} onChange={(e) => setForm({ ...form, filters: e.target.value })} className={`${inputCls} font-mono min-h-16`} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls}>{t('automations.steps', 'Steps (JSON)')}</label>
              <div className="flex flex-wrap gap-1">
                {Object.keys(STEP_TEMPLATES).map((k) => (
                  <button key={k} onClick={() => appendStep(k)} title={`+ ${k}`}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 flex items-center gap-0.5">
                    <PlusIcon className="w-3 h-3" />{k}
                  </button>
                ))}
              </div>
            </div>
            <textarea value={form.steps} onChange={(e) => setForm({ ...form, steps: e.target.value })} className={`${inputCls} font-mono min-h-48`} />
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={reset} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">{t('common.cancel', 'Cancel')}</button>
            <button onClick={() => save.mutate()} disabled={save.isPending || !form.name}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50">
              {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(workflows ?? []).map((w) => (
          <div key={w.id} className="bg-white rounded-xl border border-slate-200 p-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <BoltIcon className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-slate-900 flex items-center gap-2">
                  <span className="truncate">{w.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${
                    w.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : w.status === 'PAUSED' ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-slate-100 text-slate-500 border-slate-200'
                  }`}>{w.status}</span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{w.trigger?.type}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => setStatus.mutate({ id: w.id, status: w.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100">
                {w.status === 'ACTIVE' ? <PauseCircleIcon className="w-5 h-5" /> : <PlayCircleIcon className="w-5 h-5" />}
              </button>
              <button onClick={() => edit(w)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">{t('common.edit', 'Edit')}</button>
              <button onClick={() => remove.mutate(w.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50"><TrashIcon className="w-4 h-4" /></button>
            </div>
          </div>
        ))}
        {(workflows ?? []).length === 0 && !showForm && (
          <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">
            {t('automations.empty', 'No automations yet — describe one and let AI draft it.')}
          </div>
        )}
      </div>
    </div>
  );
}
