import { Fragment, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Phone } from 'lucide-react';
import {
  CALL_OUTCOMES,
  endCall,
  getCall,
  type CallOutcome,
  type CallTurn,
  type LatencySummary,
  type Percentiles,
} from '@/api/calls';
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
    <ol className="flex max-h-[65dvh] min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain py-1 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} aria-label={t('calls.detail.turns')}>
      {turns.map((turn) => {
        const who = speaker(turn);
        const text = turn.kind.kind === 'event' ? t('calls.detail.event', { name: turn.kind.name }) : turn.text;
        return (
          <li
            key={turn.seq}
            data-speaker={who}
            className={`max-w-[94%] ${who === 'counterpart' ? 'self-start' : who === 'line' ? 'self-center' : 'self-end'}`}
          >
            <div className={`rounded-xl border px-4 py-3 text-sm ${who === 'counterpart' ? 'rounded-bl-sm border-border bg-surface-muted' : who === 'line' ? 'border-transparent text-center' : 'rounded-br-sm border-primary-200 bg-primary-50 text-slate-900 dark:border-primary-800 dark:bg-primary-950 dark:text-slate-100'}`}>
              <span className="mb-2 block text-xs text-muted-foreground">
                {t(`calls.detail.speakers.${who}`)} · {formatDateTime(turn.at, i18n.language)}
                {turn.meta.latency_ms !== undefined &&
                  ` · ${t('calls.detail.latency', { s: (turn.meta.latency_ms / 1000).toFixed(1) })}`}
              </span>
              <span className={`whitespace-pre-wrap leading-6 [overflow-wrap:anywhere] ${who === 'line' || turn.kind.kind === 'holding' ? 'text-muted-foreground' : ''}`}>
                {text}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A call's turn timings as the voice bridge measured them (p50 / p95, ms), and their alerts. */
function Latency({ latency }: { latency: LatencySummary }) {
  const { t } = useTranslation();
  const rows: ['perceived' | 'content' | 'agent' | 'barge_in_stop', Percentiles][] = [
    ['perceived', latency.perceived],
    ['content', latency.content],
    ['agent', latency.agent],
    ['barge_in_stop', latency.barge_in_stop],
  ];
  const ms = (v: number | null) => (v === null ? '—' : String(v));
  return (
    <section className="mt-6 border-t border-border pt-4" aria-label={t('calls.detail.latencyTitle')}>
      <h3 className="mb-3 text-sm font-medium">{t('calls.detail.latencyTitle')}</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 text-sm">
        {rows.map(([key, p]) => (
          <Fragment key={key}>
            <dt className="text-muted-foreground">{t(`calls.detail.latency_${key}`)}</dt>
            <dd className="text-right tabular-nums">{t('calls.detail.latencyValue', { p50: ms(p.p50), p95: ms(p.p95) })}</dd>
          </Fragment>
        ))}
      </dl>
      {latency.alerts.map((a) => (
        <p key={a} className="text-sm text-destructive">
          {t(`calls.detail.alerts.${a}`, { defaultValue: a })}
        </p>
      ))}
    </section>
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
          <label key={o} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${outcome === o ? 'border-primary bg-surface-muted' : 'border-border'}`}>
            <input className="accent-primary" type="radio" name="outcome" value={o} checked={outcome === o} onChange={() => setOutcome(o)} />
            {t(`calls.outcomes.${o}`)}
          </label>
        ))}
      </fieldset>
      <Field label={t('calls.detail.summary')}>
        {(ids) => <Textarea id={ids.id} value={summary} maxLength={2000} onChange={(e) => setSummary(e.target.value)} />}
      </Field>
      <div className="flex justify-end">
        <Button type="submit" loading={end.isPending}>
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
      <PageHeader title={t('calls.detail.title')} actions={<Button asChild variant="outline"><Link to="/calls"><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('calls.title')}</Link></Button>} />
      <QueryState query={call}>
        {c && call.data && (
          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
            <Card>
              <CardHeader className="flex-row flex-wrap items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-primary" aria-hidden="true"><Phone className="h-4 w-4" /></span>
                <CardTitle className="min-w-0 flex-1 break-words tabular-nums">{c.counterpart_e164 ?? c.counterpart}</CardTitle>
                <Badge tone={c.state === 'ended' ? 'neutral' : 'primary'}>{t(`calls.states.${c.state}`)}</Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)] gap-x-4 gap-y-4 border-t border-border pt-5 text-sm">
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
                {c.latency && c.latency.turns > 0 && <Latency latency={c.latency} />}
              </CardContent>
            </Card>
            <Card className="lg:row-span-2">
              <CardHeader className="mb-5 border-b border-border">
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
