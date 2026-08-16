import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CornerDownLeft, Loader2, AlertTriangle, Clock, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { runCommand, type CommandResult } from '../../../features/marketing/api/command.service';

interface Turn {
  command: string;
  result?: CommandResult;
  error?: string;
}

/**
 * The command bar — type what you want, it happens.
 *
 * The turn history is deliberately local to this component and not persisted:
 * this is a control surface, not a chat archive. What actually happened is
 * already durable elsewhere (the agent-run feed below it, the approval queue,
 * each object's own timeline), and keeping a second, prettier copy of that
 * story is how the two start disagreeing.
 *
 * Every action the loop took is listed under the answer, including the ones
 * that were refused or queued — the model's prose is the summary, but the
 * chips are the record.
 */
export function CommandBar() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = useMutation({
    mutationFn: runCommand,
    onMutate: (command: string) => {
      setTurns((prev) => [...prev, { command }]);
      setDraft('');
    },
    onSuccess: (result) => {
      setTurns((prev) => prev.map((turn, i) => (i === prev.length - 1 ? { ...turn, result } : turn)));
      // A command can queue an approval, move a lead, draft a post — refresh
      // everything the home screen shows rather than guessing which one.
      qc.invalidateQueries({ queryKey: ['pending-approvals'] });
      qc.invalidateQueries({ queryKey: ['agent-runs'] });
      qc.invalidateQueries({ queryKey: ['marketing'] });
      inputRef.current?.focus();
    },
    onError: (e: any) => {
      const error =
        e?.response?.data?.message ??
        t('command.failed', 'Komut çalıştırılamadı.');
      setTurns((prev) =>
        prev.map((turn, i) => (i === prev.length - 1 ? { ...turn, error: String(error) } : turn)),
      );
    },
  });

  const submit = () => {
    const command = draft.trim();
    if (command && !send.isPending) send.mutate(command);
  };

  return (
    <div className="space-y-4">
      {turns.length > 0 && (
        <div className="space-y-4">
          {turns.map((turn, i) => (
            <div key={i} className="space-y-2">
              <p className="text-sm font-medium text-foreground">{turn.command}</p>

              {!turn.result && !turn.error && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('command.working', 'Çalışıyorum…')}
                </p>
              )}

              {turn.error && (
                <p className="flex items-start gap-2 text-sm text-danger">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {turn.error}
                </p>
              )}

              {turn.result && (
                <>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {turn.result.answer}
                  </p>
                  {turn.result.actions.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {turn.result.actions.map((a, j) => (
                        <li
                          key={j}
                          className={
                            'flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ' +
                            (a.status === 'ERROR'
                              ? 'border-danger/40 text-danger'
                              : a.status === 'PENDING_APPROVAL'
                                ? 'border-warning/40 text-warning'
                                : 'border-border text-muted-foreground')
                          }
                          title={a.error ?? undefined}
                        >
                          {a.status === 'OK' && <Check className="h-3 w-3" aria-hidden="true" />}
                          {a.status === 'PENDING_APPROVAL' && <Clock className="h-3 w-3" aria-hidden="true" />}
                          {a.status === 'ERROR' && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
                          <span className="font-mono">{a.tool.replace(/^jeeta\./, '')}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="relative" data-testid="command-bar">
        <Textarea
          ref={inputRef}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Enter sends; Shift+Enter is a newline. A command is usually one
          // line, so making the common case need a mouse trip would be worse
          // than the rare accidental send.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={send.isPending}
          className="pr-28"
          aria-label={t('command.label', 'Ne yapmamı istersin?')}
          placeholder={t('command.placeholder', 'Ne yapmamı istersin?')}
        />
        <Button
          size="sm"
          className="absolute bottom-2 right-2"
          onClick={submit}
          disabled={!draft.trim()}
          loading={send.isPending}
        >
          {t('command.send', 'Çalıştır')}
          <CornerDownLeft className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
