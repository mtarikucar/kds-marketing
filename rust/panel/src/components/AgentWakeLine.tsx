import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { wakeNow } from '@/api/agents';
import { isApiError } from '@/api/client';
import type { NeedKey, NeedWake, RunNow } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { Button, cn } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { WAKE_META, everyPhrase, putWakes, useNeedWake, useNow, wakeTime, wakeTimeIn } from '@/lib/wake';

const agentsLink = <Link className="underline underline-offset-4" to="/agents" />;

/** "Şimdi çalıştır": wakes the agent now; disabled, with the time, while the rate limits hold it back. */
function RunNowButton({ run, now }: { run: RunNow; now: number }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const session = useSession();
  const [refusal, setRefusal] = useState<string | null>(null);
  const wake = useMutation({
    mutationFn: () => wakeNow(run.api_key_id),
    meta: WAKE_META,
    onMutate: () => setRefusal(null),
    onSuccess: (out) => putWakes(client, session.data?.current_workspace, out),
    onError: (err) => {
      const retry = isApiError(err) && err.details.reason === 'rate_limited' && typeof err.details.retry_at === 'string' ? err.details.retry_at : null;
      setRefusal(retry ? t('wake.line.rateLimited', { at: wakeTimeIn(retry, i18n.language, 'abl') }) : errorMessage(t, err));
    },
  });
  const after = run.after && Date.parse(run.after) > now ? run.after : null;
  return (
    <>
      <Button size="sm" variant="outline" className="h-7 align-middle" disabled={!!after} loading={wake.isPending} onClick={() => wake.mutate()}>
        {t('wake.line.runNow')}
      </Button>
      {after && <> {t('wake.line.runAfter', { at: wakeTimeIn(after, i18n.language, 'abl') })}</>}
      {refusal && <span role="alert" className="mt-1 block font-medium text-warning">{refusal}</span>}
    </>
  );
}

/** The sentence for `state` at `now`, and whether it asks a person to look. */
function sentence(state: NeedWake, now: number, t: TFunction, language: string): { body: ReactNode; warn: boolean } | null {
  const time = (iso: string) => wakeTime(iso, language);
  const at = (iso: string) => wakeTimeIn(iso, language, 'loc');
  switch (state.state) {
    case 'no_agent':
      return null;
    case 'working': {
      const seconds = Math.max(0, Math.round((now - Date.parse(state.last_seen_at)) / 1000));
      return { body: seconds >= 60 ? t('wake.line.workingMinutes', { n: Math.floor(seconds / 60) }) : t('wake.line.working', { n: seconds }), warn: false };
    }
    case 'calling': {
      if (state.waiting_for === 'rate') return { body: t('wake.line.rate', { at: at(state.due_at) }), warn: false };
      if (state.waiting_for === 'retry') return { body: t('wake.line.retry', { at: at(state.due_at) }), warn: true };
      const seconds = Math.ceil((Date.parse(state.due_at) - now) / 1000);
      return { body: seconds > 0 ? t('wake.line.settle', { n: seconds }) : t('wake.line.calling'), warn: false };
    }
    case 'called':
      return { body: t('wake.line.called', { time: time(state.at) }), warn: false };
    case 'refused':
      return { body: <Trans i18nKey="wake.line.refused" components={{ page: agentsLink }} />, warn: true };
    case 'schedule': {
      const phrase = everyPhrase(t, state.interval_minutes);
      const next = state.next_expected_at;
      const late = !!next && Date.parse(next) <= now;
      const visit = !next
        ? t('wake.line.neverCame')
        : late
          ? t('wake.line.visitsLate', { phrase, at: at(next) })
          : t('wake.line.visits', { phrase, time: time(next) });
      const failed = state.failed_at ? t('wake.line.failed', { time: time(state.failed_at) }) : null;
      const parts: ReactNode[] = [];
      if (failed) parts.push(failed);
      parts.push(visit);
      if (!state.has_address) parts.push(<Trans key="address" i18nKey="wake.line.noAddress" components={{ page: agentsLink }} />);
      else if (state.run_now) {
        if (!failed) parts.push(t('wake.line.runNowIntro'));
        parts.push(<RunNowButton key="run" run={state.run_now} now={now} />);
      }
      return {
        body: parts.map((part, i) => <span key={i}>{i > 0 && ' '}{part}</span>),
        warn: !!failed || late || !next,
      };
    }
  }
}

/**
 * What will happen to work that waits for an agent, as one sentence (the server's state for
 * `need`, `GET /api/agents/wakes`): the agent at work, a call on its way or just made, its
 * schedule with "Şimdi çalıştır" where a person may wake it, or a refused address. Nothing while
 * nothing waits (`waiting`), while the state is not known, or when no agent may take the work
 * (the page says that in its own words). Never one line per agent.
 */
export function AgentWakeLine({ need, waiting, className }: { need: NeedKey; waiting: number; className?: string }) {
  const { t, i18n } = useTranslation();
  const state = useNeedWake(need);
  // Seconds count while a call is about to go out or an agent works; else the minute is enough.
  const ticking = state?.state === 'working' || (state?.state === 'calling' && state.waiting_for === 'settle');
  const now = useNow(ticking ? 1000 : 30_000);
  if (!(waiting > 0) || !state) return null;
  const said = sentence(state, now, t, i18n.language);
  if (!said) return null;
  return (
    <div
      data-testid="agent-wake-line"
      className={cn(
        'flex items-start gap-2 border-s-2 px-4 py-2 text-sm',
        said.warn ? 'border-warning bg-warning-subtle' : 'border-border bg-surface-muted',
        className,
      )}
    >
      <Bot aria-hidden="true" className={cn('mt-1.5 h-4 w-4 shrink-0', said.warn ? 'text-warning' : 'text-muted-foreground')} />
      <p className="min-w-0 leading-7 [overflow-wrap:anywhere]">{said.body}</p>
    </div>
  );
}

/** Whether [`AgentWakeLine`] speaks for `need`: its state is known and some agent may take the work. */
export function useWakeSpeaks(need: NeedKey): boolean {
  const state = useNeedWake(need);
  return !!state && state.state !== 'no_agent';
}
