import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  SparklesIcon,
  TrashIcon,
  PauseCircleIcon,
  PlayCircleIcon,
} from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface AgentProfile {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  persona: string;
  tone?: string | null;
  goals?: string | null;
  guardrails?: string | null;
  language: string;
  kbDocIds?: string[] | null;
  captureFields?: string[] | null;
  maxRepliesPerConvoDaily?: number;
  updatedAt?: string;
}

interface KnowledgeRow {
  id: string;
  title: string;
  language: string;
  status: string;
}

const EMPTY_FORM = {
  name: '',
  persona: '',
  tone: '',
  goals: '',
  guardrails: '',
  language: 'tr',
  captureFields: '',
  maxRepliesPerConvoDaily: 30,
  kbDocIds: [] as string[],
};

/**
 * Agent Studio: the persona + grounding config Conversation/Voice AI run on.
 * P1 ships the config surface; the engine that answers on channels lands in
 * P2. Manager+ surface, gated on the `agentStudio` feature.
 */
export default function AgentStudioPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: agents } = useQuery<AgentProfile[]>({
    queryKey: ['marketing', 'ai', 'agents'],
    queryFn: () => marketingApi.get('/ai/agents').then((r) => r.data),
  });

  const { data: docs } = useQuery<KnowledgeRow[]>({
    queryKey: ['marketing', 'ai', 'knowledge'],
    queryFn: () => marketingApi.get('/ai/knowledge').then((r) => r.data),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'ai', 'agents'] });

  const buildPayload = () => ({
    name: form.name,
    persona: form.persona,
    tone: form.tone || undefined,
    goals: form.goals || undefined,
    guardrails: form.guardrails || undefined,
    language: form.language,
    maxRepliesPerConvoDaily: form.maxRepliesPerConvoDaily,
    kbDocIds: form.kbDocIds,
    captureFields: form.captureFields
      ? form.captureFields.split(',').map((c) => c.trim()).filter(Boolean)
      : [],
  });

  const saveAgent = useMutation({
    mutationFn: () =>
      editingId
        ? marketingApi.patch(`/ai/agents/${editingId}`, buildPayload())
        : marketingApi.post('/ai/agents', buildPayload()),
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      toast.success(t('agents.saved', 'Agent saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('agents.saveFailed', 'Save failed')),
  });

  const toggleAgent = useMutation({
    mutationFn: (a: AgentProfile) =>
      marketingApi.patch(`/ai/agents/${a.id}`, {
        status: a.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      }),
    onSuccess: invalidate,
  });

  const deleteAgent = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/ai/agents/${id}`),
    onSuccess: invalidate,
  });

  const startEdit = (a: AgentProfile) => {
    setEditingId(a.id);
    setForm({
      name: a.name,
      persona: a.persona,
      tone: a.tone ?? '',
      goals: a.goals ?? '',
      guardrails: a.guardrails ?? '',
      language: a.language,
      captureFields: (a.captureFields ?? []).join(', '),
      maxRepliesPerConvoDaily: a.maxRepliesPerConvoDaily ?? 30,
      kbDocIds: a.kbDocIds ?? [],
    });
    setShowForm(true);
  };

  const toggleDoc = (id: string) =>
    setForm((f) => ({
      ...f,
      kbDocIds: f.kbDocIds.includes(id)
        ? f.kbDocIds.filter((x) => x !== id)
        : [...f.kbDocIds, id],
    }));

  const inputCls =
    'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {t('agents.title', 'Agent Studio')}
          </h1>
          <p className="text-sm text-slate-500">
            {t(
              'agents.subtitle',
              'Define the persona, tone and grounding your AI uses to answer customers. Connect channels in the next step.',
            )}
          </p>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setForm(EMPTY_FORM);
            setShowForm(true);
          }}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          {t('agents.new', 'New agent')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="font-semibold text-slate-900">
            {editingId ? t('agents.edit', 'Edit agent') : t('agents.new', 'New agent')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('agents.name', 'Agent name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="Reception bot" maxLength={120} />
            </div>
            <div>
              <label className={labelCls}>{t('agents.language', 'Language')}</label>
              <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} className={inputCls}>
                <option value="tr">Türkçe</option>
                <option value="en">English</option>
                <option value="ru">Русский</option>
                <option value="uz">Oʻzbekcha</option>
                <option value="ar">العربية</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>{t('agents.persona', 'Persona (who is this agent?)')}</label>
            <textarea
              value={form.persona}
              onChange={(e) => setForm({ ...form, persona: e.target.value })}
              className={`${inputCls} min-h-24`}
              maxLength={4000}
              placeholder={t('agents.personaPlaceholder', 'e.g. You are the friendly front-desk assistant for a family pizzeria. Greet warmly, answer in short sentences…')}
            />
            <p className="text-xs text-slate-400 mt-1">
              {form.persona.length}/4000 · {t('agents.personaMin', 'min 10 characters')}
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('agents.tone', 'Tone (optional)')}</label>
              <input value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} className={inputCls} maxLength={200} placeholder={t('agents.tonePlaceholder', 'warm, concise, professional')} />
            </div>
            <div>
              <label className={labelCls}>{t('agents.maxReplies', 'Max AI replies / conversation / day')}</label>
              <input type="number" min={1} max={500} value={form.maxRepliesPerConvoDaily}
                onChange={(e) => setForm({ ...form, maxRepliesPerConvoDaily: Number(e.target.value) })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>{t('agents.goals', 'Goals (optional)')}</label>
            <textarea value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })} className={`${inputCls} min-h-16`} maxLength={2000}
              placeholder={t('agents.goalsPlaceholder', 'What should the agent try to achieve? e.g. book a table, capture phone + party size')} />
          </div>
          <div>
            <label className={labelCls}>{t('agents.guardrails', 'Guardrails (optional)')}</label>
            <textarea value={form.guardrails} onChange={(e) => setForm({ ...form, guardrails: e.target.value })} className={`${inputCls} min-h-16`} maxLength={2000}
              placeholder={t('agents.guardrailsPlaceholder', 'What must it never do? e.g. never quote prices, never promise refunds')} />
          </div>
          <div>
            <label className={labelCls}>{t('agents.capture', 'Fields to capture (comma separated)')}</label>
            <input value={form.captureFields} onChange={(e) => setForm({ ...form, captureFields: e.target.value })} className={inputCls}
              placeholder="name, phone, partySize" />
          </div>
          <div>
            <label className={labelCls}>{t('agents.knowledge', 'Knowledge base grounding')}</label>
            {(docs ?? []).length === 0 ? (
              <p className="text-xs text-slate-400">
                {t('agents.noDocs', 'No knowledge docs yet — add some in the Knowledge Base to ground replies in facts.')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(docs ?? []).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDoc(d.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                      form.kbDocIds.includes(d.id)
                        ? 'bg-primary/10 text-primary border-primary'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {d.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={() => saveAgent.mutate()}
              disabled={saveAgent.isPending || form.name.length === 0 || form.persona.length < 10}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saveAgent.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(agents ?? []).map((a) => (
          <div key={a.id} className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <SparklesIcon className="w-5 h-5 text-primary" />
                <div>
                  <div className="font-medium text-slate-900 flex items-center gap-2">
                    {a.name}
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      a.status === 'ACTIVE'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-slate-100 text-slate-500 border-slate-200'
                    }`}>
                      {a.status === 'ACTIVE' ? t('agents.active', 'Active') : t('agents.paused', 'Paused')}
                    </span>
                  </div>
                  <p className="text-sm text-slate-500 mt-1 line-clamp-2">{a.persona}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => toggleAgent.mutate(a)} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100">
                  {a.status === 'ACTIVE' ? <PauseCircleIcon className="w-5 h-5" /> : <PlayCircleIcon className="w-5 h-5" />}
                </button>
                <button onClick={() => startEdit(a)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                  {t('common.edit', 'Edit')}
                </button>
                <button onClick={() => deleteAgent.mutate(a.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50">
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
        {(agents ?? []).length === 0 && !showForm && (
          <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">
            {t('agents.empty', 'No agents yet — create one to define how your AI talks to customers.')}
          </div>
        )}
      </div>
    </div>
  );
}
