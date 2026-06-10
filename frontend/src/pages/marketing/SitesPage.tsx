import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { GlobeAltIcon, TrashIcon, SparklesIcon, ClipboardIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';

interface PageRow { id: string; slug: string; title: string; published: boolean }
interface FormRow { id: string; name: string; fields?: unknown[] }

const EMPTY = { id: '', title: '', slug: '', blocks: '[]' };

export default function SitesPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const wsId = (useMarketingAuthStore().user as any)?.workspaceId as string | undefined;
  const [form, setForm] = useState({ ...EMPTY });
  const [showForm, setShowForm] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [formName, setFormName] = useState('');

  const { data: pages } = useQuery<PageRow[]>({ queryKey: ['marketing', 'sites'], queryFn: () => marketingApi.get('/sites').then((r) => r.data) });
  const { data: forms } = useQuery<FormRow[]>({ queryKey: ['marketing', 'sites', 'forms'], queryFn: () => marketingApi.get('/sites/forms').then((r) => r.data) });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'sites'] });
  const reset = () => { setForm({ ...EMPTY }); setShowForm(false); setAiPrompt(''); };

  const save = useMutation({
    mutationFn: () => {
      let blocks: unknown;
      try { blocks = JSON.parse(form.blocks || '[]'); } catch { throw new Error(t('sites.badBlocks', 'Blocks are not valid JSON')); }
      const payload = { title: form.title, slug: form.slug || undefined, blocks };
      return form.id ? marketingApi.patch(`/sites/${form.id}`, payload) : marketingApi.post('/sites', payload);
    },
    onSuccess: () => { invalidate(); reset(); toast.success(t('sites.saved', 'Page saved')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? e.message ?? t('sites.saveFailed', 'Save failed')),
  });
  const draft = useMutation({
    mutationFn: () => marketingApi.post('/sites/draft', { prompt: aiPrompt }),
    onSuccess: ({ data }) => { setForm((f) => ({ ...f, title: f.title || data.title, blocks: JSON.stringify(data.blocks ?? [], null, 2) })); toast.success(t('sites.drafted', 'Draft ready')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('sites.draftFailed', 'Could not draft')),
  });
  const publish = useMutation({ mutationFn: ({ id, p }: { id: string; p: boolean }) => marketingApi.post(`/sites/${id}/publish`, { published: p }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => marketingApi.delete(`/sites/${id}`), onSuccess: invalidate });
  const createForm = useMutation({
    mutationFn: () => marketingApi.post('/sites/forms', { name: formName, fields: [{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'phone', label: 'Phone', type: 'tel' }] }),
    onSuccess: () => { setFormName(''); queryClient.invalidateQueries({ queryKey: ['marketing', 'sites', 'forms'] }); toast.success(t('sites.formCreated', 'Form created')); },
  });
  const removeForm = useMutation({ mutationFn: (id: string) => marketingApi.delete(`/sites/forms/${id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['marketing', 'sites', 'forms'] }) });

  const edit = async (p: PageRow) => {
    const full = await marketingApi.get(`/sites/${p.id}`).then((r) => r.data);
    setForm({ id: full.id, title: full.title, slug: full.slug, blocks: JSON.stringify(full.blocks ?? [], null, 2) });
    setShowForm(true);
  };
  const publicUrl = (slug: string) => `${window.location.origin}/api/public/p/${wsId ?? ':workspace'}/${slug}`;

  const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('sites.title', 'Funnels & Pages')}</h1>
          <p className="text-sm text-slate-500">{t('sites.subtitle', 'Build landing pages with lead-capture forms. Describe one and AI drafts the blocks.')}</p>
        </div>
        <button onClick={() => { setForm({ ...EMPTY }); setShowForm(true); }} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90">{t('sites.new', 'New page')}</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 flex gap-2">
            <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} className={inputCls} placeholder={t('sites.aiPlaceholder', 'Describe the page — e.g. a demo-booking page for a coffee POS')} />
            <button onClick={() => draft.mutate()} disabled={!aiPrompt.trim() || draft.isPending} className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 shrink-0 flex items-center gap-1"><SparklesIcon className="w-4 h-4" />{draft.isPending ? '…' : t('sites.draftBtn', 'Draft')}</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className={labelCls}>{t('sites.pageTitle', 'Title')}</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} maxLength={120} /></div>
            <div><label className={labelCls}>{t('sites.slug', 'Slug')}</label><input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className={inputCls} placeholder="demo" maxLength={80} /></div>
          </div>
          <div><label className={labelCls}>{t('sites.blocks', 'Blocks (JSON)')}</label><textarea value={form.blocks} onChange={(e) => setForm({ ...form, blocks: e.target.value })} className={`${inputCls} font-mono min-h-48`} /></div>
          <div className="flex gap-2 justify-end">
            <button onClick={reset} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">{t('common.cancel', 'Cancel')}</button>
            <button onClick={() => save.mutate()} disabled={save.isPending || !form.title} className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50">{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(pages ?? []).map((p) => (
          <div key={p.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <GlobeAltIcon className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-slate-900 truncate">{p.title}</div>
                <div className="text-xs text-slate-400 flex items-center gap-2">
                  /{p.slug}
                  {p.published && (
                    <button onClick={() => { navigator.clipboard.writeText(publicUrl(p.slug)); toast.success(t('common.copied', 'Copied')); }} className="text-primary hover:underline flex items-center gap-0.5"><ClipboardIcon className="w-3 h-3" />{t('sites.copyUrl', 'public URL')}</button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => publish.mutate({ id: p.id, p: !p.published })} title={p.published ? t('sites.unpublish', 'Unpublish') : t('sites.publish', 'Publish')} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100">{p.published ? <EyeIcon className="w-5 h-5 text-emerald-500" /> : <EyeSlashIcon className="w-5 h-5" />}</button>
              <button onClick={() => edit(p)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">{t('common.edit', 'Edit')}</button>
              <button onClick={() => remove.mutate(p.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50"><TrashIcon className="w-4 h-4" /></button>
            </div>
          </div>
        ))}
        {(pages ?? []).length === 0 && !showForm && <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">{t('sites.empty', 'No pages yet — describe one and let AI draft it.')}</div>}
      </div>

      {/* Forms */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-900 mb-3">{t('sites.forms', 'Lead-capture forms')}</h2>
        <div className="flex gap-2 mb-3">
          <input value={formName} onChange={(e) => setFormName(e.target.value)} className={inputCls} placeholder={t('sites.formName', 'Form name (name/email/phone fields)')} />
          <button onClick={() => createForm.mutate()} disabled={!formName.trim()} className="px-3 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 shrink-0">{t('sites.addForm', 'Add')}</button>
        </div>
        <div className="divide-y divide-slate-100">
          {(forms ?? []).map((f) => (
            <div key={f.id} className="py-2 flex items-center justify-between text-sm">
              <span><code className="text-xs text-slate-500">{f.id.slice(0, 8)}</code> {f.name}</span>
              <button onClick={() => removeForm.mutate(f.id)} className="text-red-400 hover:text-red-600 text-xs">{t('common.delete', 'Delete')}</button>
            </div>
          ))}
          {(forms ?? []).length === 0 && <p className="text-xs text-slate-400 py-2">{t('sites.noForms', 'No forms yet. Add one, then reference it in a page form block: {"type":"form","formId":"…"}.')}</p>}
        </div>
      </div>
    </div>
  );
}
