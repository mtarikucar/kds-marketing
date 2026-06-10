import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { BookOpenIcon, TrashIcon, ArchiveBoxIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface KnowledgeRow {
  id: string;
  title: string;
  source: string;
  language: string;
  status: 'ACTIVE' | 'ARCHIVED';
  updatedAt: string;
}

const EMPTY_FORM = { title: '', content: '', language: 'tr' };

/**
 * Knowledge Base: the facts the AI grounds its answers on (menus, policies,
 * FAQs, hours). Full-text searched at answer time. Manager+ surface, gated on
 * the `agentStudio` feature.
 */
export default function KnowledgeBasePage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: docs } = useQuery<KnowledgeRow[]>({
    queryKey: ['marketing', 'ai', 'knowledge'],
    queryFn: () => marketingApi.get('/ai/knowledge').then((r) => r.data),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'ai', 'knowledge'] });

  const saveDoc = useMutation({
    mutationFn: () => {
      const payload = { title: form.title, content: form.content, language: form.language };
      return editingId
        ? marketingApi.patch(`/ai/knowledge/${editingId}`, payload)
        : marketingApi.post('/ai/knowledge', payload);
    },
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      toast.success(t('knowledge.saved', 'Document saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('knowledge.saveFailed', 'Save failed')),
  });

  const archiveDoc = useMutation({
    mutationFn: (d: KnowledgeRow) =>
      marketingApi.patch(`/ai/knowledge/${d.id}`, {
        status: d.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
      }),
    onSuccess: invalidate,
  });

  const deleteDoc = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/ai/knowledge/${id}`),
    onSuccess: invalidate,
  });

  const startEdit = async (d: KnowledgeRow) => {
    try {
      const full = await marketingApi.get(`/ai/knowledge/${d.id}`).then((r) => r.data);
      setEditingId(d.id);
      setForm({ title: full.title, content: full.content, language: full.language });
      setShowForm(true);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? t('knowledge.loadFailed', 'Could not load document'));
    }
  };

  const inputCls =
    'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {t('knowledge.title', 'Knowledge Base')}
          </h1>
          <p className="text-sm text-slate-500">
            {t(
              'knowledge.subtitle',
              'The facts your AI answers from — menus, hours, policies, FAQs. Attach docs to an agent in Agent Studio.',
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
          {t('knowledge.new', 'New document')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="font-semibold text-slate-900">
            {editingId ? t('knowledge.edit', 'Edit document') : t('knowledge.new', 'New document')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className={labelCls}>{t('knowledge.docTitle', 'Title')}</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} maxLength={200} placeholder={t('knowledge.titlePlaceholder', 'e.g. Menu & prices')} />
            </div>
            <div>
              <label className={labelCls}>{t('knowledge.language', 'Language')}</label>
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
            <label className={labelCls}>{t('knowledge.content', 'Content')}</label>
            <textarea
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className={`${inputCls} min-h-48 font-mono`}
              maxLength={50000}
              placeholder={t('knowledge.contentPlaceholder', 'Paste the facts the AI should know. Plain text works best.')}
            />
            <p className="text-xs text-slate-400 mt-1">{form.content.length}/50000</p>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={() => saveDoc.mutate()}
              disabled={saveDoc.isPending || form.title.length === 0 || form.content.length === 0}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saveDoc.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(docs ?? []).map((d) => (
          <div key={d.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <BookOpenIcon className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-slate-900 flex items-center gap-2">
                  <span className="truncate">{d.title}</span>
                  <span className="text-xs uppercase text-slate-400">{d.language}</span>
                  {d.status === 'ARCHIVED' && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">
                      {t('knowledge.archived', 'archived')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  {t('knowledge.updated', 'updated')} {new Date(d.updatedAt).toLocaleDateString()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => startEdit(d)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                {t('common.edit', 'Edit')}
              </button>
              <button onClick={() => archiveDoc.mutate(d)} title={t('knowledge.toggleArchive', 'Archive / restore')} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100">
                <ArchiveBoxIcon className="w-4 h-4" />
              </button>
              <button onClick={() => deleteDoc.mutate(d.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50">
                <TrashIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {(docs ?? []).length === 0 && !showForm && (
          <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">
            {t('knowledge.empty', 'No documents yet — add the facts your AI should answer from.')}
          </div>
        )}
      </div>
    </div>
  );
}
