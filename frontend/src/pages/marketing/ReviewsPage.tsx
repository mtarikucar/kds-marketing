import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { StarIcon, TrashIcon, SparklesIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface Review { id: string; rating?: number | null; text?: string | null; status: string; replyDraft?: string | null; replyText?: string | null; createdAt: string }
interface Source { id: string; name: string; placeUrl: string }

export default function ReviewsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [srcName, setSrcName] = useState('');
  const [srcUrl, setSrcUrl] = useState('');
  const [replyText, setReplyText] = useState<Record<string, string>>({});

  const { data: reviews } = useQuery<Review[]>({ queryKey: ['marketing', 'reviews'], queryFn: () => marketingApi.get('/reviews').then((r) => r.data) });
  const { data: sources } = useQuery<Source[]>({ queryKey: ['marketing', 'reviews', 'sources'], queryFn: () => marketingApi.get('/reviews/sources').then((r) => r.data) });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'reviews'] });
  const invalidateSrc = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'reviews', 'sources'] });

  const addSource = useMutation({
    mutationFn: () => marketingApi.post('/reviews/sources', { name: srcName, placeUrl: srcUrl }),
    onSuccess: () => { setSrcName(''); setSrcUrl(''); invalidateSrc(); toast.success(t('reviews.sourceAdded', 'Source added')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('reviews.saveFailed', 'Save failed')),
  });
  const removeSource = useMutation({ mutationFn: (id: string) => marketingApi.delete(`/reviews/sources/${id}`), onSuccess: invalidateSrc });
  const draft = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/reviews/${id}/draft`),
    onSuccess: ({ data }, id) => { setReplyText((s) => ({ ...s, [id]: data.replyDraft })); invalidate(); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('reviews.draftFailed', 'Draft failed')),
  });
  const reply = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => marketingApi.post(`/reviews/${id}/reply`, { text }),
    onSuccess: () => { invalidate(); toast.success(t('reviews.replied', 'Reply saved')); },
  });

  const stars = (n?: number | null) => '★★★★★☆☆☆☆☆'.slice(5 - (n ?? 0), 10 - (n ?? 0));
  const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t('reviews.title', 'Reviews')}</h1>
        <p className="text-sm text-slate-500">{t('reviews.subtitle', 'Send review requests via automations; happy customers (≥4★) go to your public page, unhappy ones reach you privately first.')}</p>
      </div>

      {/* Sources */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-900 mb-3">{t('reviews.sources', 'Review sources')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
          <input value={srcName} onChange={(e) => setSrcName(e.target.value)} className={inputCls} placeholder={t('reviews.sourceName', 'Name (e.g. Google)')} />
          <input value={srcUrl} onChange={(e) => setSrcUrl(e.target.value)} className={`${inputCls} sm:col-span-2`} placeholder={t('reviews.sourceUrl', 'Google review URL (g.page/r/…)')} />
        </div>
        <button onClick={() => addSource.mutate()} disabled={!srcName.trim() || !srcUrl.trim()} className="px-3 py-1.5 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50">{t('reviews.addSource', 'Add source')}</button>
        <div className="divide-y divide-slate-100 mt-3">
          {(sources ?? []).map((s) => (
            <div key={s.id} className="py-2 flex items-center justify-between text-sm">
              <span className="truncate"><strong>{s.name}</strong> <span className="text-slate-400 text-xs">{s.placeUrl}</span></span>
              <button onClick={() => removeSource.mutate(s.id)} className="text-red-400 hover:text-red-600 text-xs shrink-0">{t('common.delete', 'Delete')}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Reviews */}
      <div className="space-y-3">
        {(reviews ?? []).map((r) => (
          <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-amber-500 text-lg">{stars(r.rating)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  r.status === 'PRIVATE_FEEDBACK' ? 'bg-red-50 text-red-600 border-red-200'
                  : r.status === 'PUBLIC_ROUTED' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : r.status === 'REPLIED' ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-slate-100 text-slate-500 border-slate-200'
                }`}>{r.status}</span>
              </div>
              <span className="text-xs text-slate-400">{new Date(r.createdAt).toLocaleDateString()}</span>
            </div>
            {r.text && <p className="text-sm text-slate-700 mt-2">{r.text}</p>}
            {r.replyText ? (
              <div className="mt-2 text-sm text-slate-500 border-l-2 border-slate-200 pl-3">{t('reviews.yourReply', 'Your reply')}: {r.replyText}</div>
            ) : (
              (r.status === 'PRIVATE_FEEDBACK' || r.status === 'PUBLIC_ROUTED') && (
                <div className="mt-3 space-y-2">
                  <textarea value={replyText[r.id] ?? r.replyDraft ?? ''} onChange={(e) => setReplyText((s) => ({ ...s, [r.id]: e.target.value }))} className={`${inputCls} min-h-20`} placeholder={t('reviews.replyPlaceholder', 'Write a reply…')} />
                  <div className="flex gap-2">
                    <button onClick={() => draft.mutate(r.id)} disabled={draft.isPending} className="px-3 py-1.5 text-xs rounded-lg border border-primary text-primary hover:bg-primary/5 flex items-center gap-1"><SparklesIcon className="w-3.5 h-3.5" />{t('reviews.aiDraft', 'AI draft')}</button>
                    <button onClick={() => reply.mutate({ id: r.id, text: replyText[r.id] ?? r.replyDraft ?? '' })} disabled={!(replyText[r.id] ?? r.replyDraft)} className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{t('reviews.saveReply', 'Save reply')}</button>
                  </div>
                </div>
              )
            )}
          </div>
        ))}
        {(reviews ?? []).length === 0 && <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">{t('reviews.empty', 'No reviews yet — add a source and send review requests from an automation.')}</div>}
      </div>
    </div>
  );
}
