import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles, X, Send } from 'lucide-react';
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

  // Guard isPending here (not just on the button): the Enter handler calls
  // submit() directly, so without it pressing Enter again before the first
  // answer returns fires a SECOND /ai/ask — a duplicate question that bills
  // another 2 credits.
  const submit = () => { if (q.trim() && !ask.isPending) { setAnswer(null); ask.mutate(q.trim()); } };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('askAi.title', 'Ask AI')}
        className="fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 flex items-center justify-center"
      >
        <Sparkles className="w-6 h-6" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-md bg-background h-full shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 className="font-semibold text-foreground flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary" />{t('askAi.title', 'Ask AI')}</h2>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-muted"><X className="w-5 h-5 text-muted-foreground" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-xs text-muted-foreground">{t('askAi.intro', 'Ask about your leads, tasks and campaigns in plain language.')}</p>
              <div className="flex flex-wrap gap-1.5">
                {examples.map((ex, i) => (
                  <button key={i} onClick={() => { setQ(ex); }} className="text-xs px-2 py-1 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80">{ex}</button>
                ))}
              </div>
              {ask.isPending && <div className="text-sm text-muted-foreground">{t('askAi.thinking', 'Thinking…')}</div>}
              {answer && <div className="bg-muted border border-border rounded-xl p-3 text-sm text-foreground whitespace-pre-wrap">{answer}</div>}
            </div>
            <div className="p-3 border-t border-border flex gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={t('askAi.placeholder', 'Ask a question…')} className="flex-1 px-3 py-2 border border-input rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none bg-background text-foreground" />
              <button onClick={submit} disabled={!q.trim() || ask.isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"><Send className="w-4 h-4" /></button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
