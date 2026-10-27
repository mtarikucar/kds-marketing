import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { CALL_OUTCOMES, endCall, getCall, type CallOutcome, type CallTurn } from '@/api/calls';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, PageHeader, Textarea, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';
import { CALLS_KEY, duration } from './CallsPage';

/** Who a turn is: the counterpart, the agent, the script, or the line itself. */
function speaker(turn: CallTurn): 'counterpart' | 'agent' | 'script' | 'line' {
  switch (turn.kind.kind) {
    case 'utterance':
    case 'dtmf':
      return 'counterpart';
    case 'say':
      return turn.kind.by;
    case 'holding':
    case 'fallback':
      return 'script';
    default:
      return 'line';
  }
}

function Timeline({ turns }: { turns: CallTurn[] }) {
  const { t, i18n } = useTranslation();
  if (turns.length === 0) return <p className="text-sm text-muted-foreground">{t('calls.detail.noTurns')}</p>;
  return (
    <ol className="flex flex-col gap-2" aria-label={t('calls.detail.turns')}>
      {turns.map((turn) => {
        const who = speaker(turn);
        const text = turn.kind.kind === 'event' ? t('calls.detail.event', { name: turn.kind.name }) : turn.text;
        return (
          <li
            key={turn.seq}
            data-speaker={who}
            className={who === 'counterpart' ? 'self-start' : who === 'line' ? 'self-center' : 'self-end'}
          >
            <div className="rounded-lg border border-border px-3 py-2 text-sm">
              <span className="block text-micro text-muted-foreground">
                {t(`calls.detail.speakers.${who}`)} · {formatDateTime(turn.at, i18n.language)}
                {turn.meta.latency_ms !== undefined &&
                  ` · ${t('calls.detail.latency', { s: (turn.meta.latency_ms / 1000).toFixed(1) })}`}
              </span>
              <span className={who === 'line' || turn.kind.kind === 'holding' ? 'text-muted-foreground' : ''}>
                {text}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Records how the call went: outcome and summary (`POST /api/calls/{id}/end`). */
function EndForm({ id }: { id: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<CallOutcome>('connected');
  const [summary, setSummary] = useState('');
  const end = useMutation({
    mutationFn: () => endCall(id, { outcome, summary }),
    onSuccess: async (out) => {
      toast.success(t('calls.detail.ended'));
      queryClient.setQueryData([...CALLS_KEY, id], out);
      await queryClient.invalidateQueries({ queryKey: CALLS_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!end.isPending) end.mutate();
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit} aria-label={t('calls.detail.endTitle')}>
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-1 text-sm font-medium">{t('calls.detail.outcome')}</legend>
        {CALL_OUTCOMES.map((o) => (
          <label key={o} className="flex items-center gap-1 text-sm">
            <input type="radio" name="outcome" value={o} checked={outcome === o} onChange={() => setOutcome(o)} />
            {t(`calls.outcomes.${o}`)}
          </label>
        ))}
      </fieldset>
      <Field label={t('calls.detail.summary')}>
        {(ids) => <Textarea id={ids.id} value={summary} maxLength={2000} onChange={(e) => setSummary(e.target.value)} />}
      </Field>
      <div>
        <Button type="submit" disabled={end.isPending}>
          {t('calls.detail.end')}
        </Button>
      </div>
    </form>
  );
}

/** `/calls/:callId`: one call, its turns, and recording its outcome (calls.manage). */
export function CallDetail() {
  const { t, i18n } = useTranslation();
  const { callId = '' } = useParams();
  const session = useSession();
  const canManage = can(session.data, 'calls.manage');
  const call = useQuery({ queryKey: [...CALLS_KEY, callId], queryFn: () => getCall(callId) });
  const c = call.data?.call;
  return (
    <>
      <PageHeader title={t('calls.detail.title')} />
      <QueryState query={call}>
        {c && call.data && (
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader className="flex-row flex-wrap items-center gap-2">
                <CardTitle className="font-mono">{c.counterpart_e164 ?? c.counterpart}</CardTitle>
                <Badge tone={c.state === 'ended' ? 'neutral' : 'primary'}>{t(`calls.states.${c.state}`)}</Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <dt className="text-muted-foreground">{t('calls.columns.purpose')}</dt>
                  <dd>{t(`calls.purposes.${c.purpose}`)}</dd>
                  <dt className="text-muted-foreground">{t('calls.columns.started')}</dt>
                  <dd>{formatDateTime(c.started_at, i18n.language)}</dd>
                  <dt className="text-muted-foreground">{t('calls.columns.duration')}</dt>
                  <dd>{duration(c.duration_s)}</dd>
                  <dt className="text-muted-foreground">{t('calls.columns.outcome')}</dt>
                  <dd>{c.outcome ? t(`calls.outcomes.${c.outcome}`) : '—'}</dd>
                  {c.end_cause && (
                    <>
                      <dt className="text-muted-foreground">{t('calls.detail.endCause')}</dt>
                      <dd className="break-words">
                        {t(`calls.causes.${c.end_cause.cause}`, { defaultValue: c.end_cause.cause })}
                        {c.end_cause.detail && ` · ${c.end_cause.detail}`}
                      </dd>
                    </>
                  )}
                  {c.summary && (
                    <>
                      <dt className="text-muted-foreground">{t('calls.detail.summary')}</dt>
                      <dd className="whitespace-pre-wrap">{c.summary}</dd>
                    </>
                  )}
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('calls.detail.turns')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Timeline turns={call.data.turns} />
              </CardContent>
            </Card>
            {canManage && !c.outcome && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('calls.detail.endTitle')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <EndForm id={c.id} />
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </QueryState>
    </>
  );
}
