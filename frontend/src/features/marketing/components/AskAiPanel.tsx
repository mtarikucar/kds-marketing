import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SparklesIcon, XMarkIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import marketingApi from '../api/marketingApi';

/**
 * Ask-AI slide-over, mounted globally in the layout. A read-only natural-
 * language analyst over the workspace's own data (leads/tasks/campaigns).
 * Gated on the `askAi` feature server-side — a 403 surfaces as an upgrade hint.
 */
export default function AskAiPanel() {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: (question: string) => marketingApi.post('/ai/ask', { question }).then((r) => r.data),
    onSuccess: (d) => setAnswer(d.answer),
    onError: (e: any) =>
      setAnswer(
        e.response?.status === 403
          ? t('askAi.locked', 'Ask AI is not in your plan — upgrade to enable it.')
          : (e.response?.data?.message ?? t('askAi.failed', 'Something went wrong.')),
      ),
  });

  const examples = [
    t('askAi.ex1', 'How many leads are in each status?'),
    t('askAi.ex2', 'Which leads in Istanbul are still NEW?'),
    t('askAi.ex3', "What's the status of my campaigns?"),
  ];

  const submit = () => { if (q.trim()) { setAnswer(null); ask.mutate(q.trim()); } };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('askAi.title', 'Ask AI')}
        className="fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 flex items-center justify-center"
      >
        <SparklesIcon className="w-6 h-6" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-md bg-white h-full shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <h2 className="font-semibold text-slate-900 flex items-center gap-2"><SparklesIcon className="w-5 h-5 text-primary" />{t('askAi.title', 'Ask AI')}</h2>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100"><XMarkIcon className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-xs text-slate-500">{t('askAi.intro', 'Ask about your leads, tasks and campaigns in plain language.')}</p>
              <div className="flex flex-wrap gap-1.5">
                {examples.map((ex, i) => (
                  <button key={i} onClick={() => { setQ(ex); }} className="text-xs px-2 py-1 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200">{ex}</button>
                ))}
              </div>
              {ask.isPending && <div className="text-sm text-slate-400">{t('askAi.thinking', 'Thinking…')}</div>}
              {answer && <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm text-slate-800 whitespace-pre-wrap">{answer}</div>}
            </div>
            <div className="p-3 border-t border-slate-200 flex gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={t('askAi.placeholder', 'Ask a question…')} className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
              <button onClick={submit} disabled={!q.trim() || ask.isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"><PaperAirplaneIcon className="w-4 h-4" /></button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
