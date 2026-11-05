import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isApiError } from '@/api/client';
import {
  CALL_PURPOSES,
  REFUSAL_REASONS,
  listCalls,
  placeCall,
  type CallPurpose,
  type CallView,
  type RefusalReason,
} from '@/api/calls';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';
import { CallsPolicy } from './CallsPolicy';

export const CALLS_KEY = ['calls'] as const;

/** `m:ss` of a duration in seconds, or a dash. */
export function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The refusal a placed call met, when the server refused it with a known reason. */
function refusalOf(err: unknown): RefusalReason | null {
  if (!isApiError(err) || err.code !== 'CONFLICT') return null;
  const reason = err.details.reason;
  return typeof reason === 'string' && (REFUSAL_REASONS as readonly string[]).includes(reason)
    ? (reason as RefusalReason)
    : null;
}

/** "Place a call": a rep's call through the PBX (the rep's extension rings first). */
function PlaceCallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const [extension, setExtension] = useState('');
  const [purpose, setPurpose] = useState<CallPurpose>('service');
  const place = useMutation({
    mutationFn: () => {
      const value = target.trim();
      const byId = /^[0-9a-f-]{36}$/i.test(value);
      return placeCall({
        ...(byId ? { person_id: value } : { phone: value }),
        purpose,
        mode: 'human',
        rep_extension: extension.trim(),
      });
    },
    onSuccess: async () => {
      toast.success(t('calls.place.placed'));
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: CALLS_KEY });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: CALLS_KEY });
    },
  });
  const refusal = refusalOf(place.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!place.isPending) place.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!place.isPending) onOpenChange(value); }}>
      <DialogContent dismissible={!place.isPending}>
        <DialogHeader>
          <DialogTitle>{t('calls.place.title')}</DialogTitle>
          <DialogDescription>{t('calls.place.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <Field label={t('calls.place.target')} hint={t('calls.place.targetHint')}>
            {(ids) => (
              <Input
                id={ids.id}
                aria-describedby={ids.describedBy}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label={t('calls.place.extension')} hint={t('calls.place.extensionHint')}>
            {(ids) => (
              <Input
                id={ids.id}
                aria-describedby={ids.describedBy}
                inputMode="numeric"
                value={extension}
                onChange={(e) => setExtension(e.target.value)}
                required
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('calls.place.purpose')}</legend>
            {CALL_PURPOSES.map((p) => (
              <label key={p} className={`flex cursor-pointer items-start gap-3 border-l-2 px-3 py-3 text-sm ${purpose === p ? 'border-brand-accent bg-surface-muted' : 'border-transparent'}`}>
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  name="purpose"
                  value={p}
                  checked={purpose === p}
                  onChange={() => setPurpose(p)}
                />
                <span>
                  <span className="font-medium">{t(`calls.purposes.${p}`)}</span>
                  <span className="block text-caption text-muted-foreground">{t(`calls.purposeHints.${p}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {place.error && (
            <Callout tone="warning">
              {refusal
                ? t('calls.place.refused', { reason: t(`calls.refusals.${refusal}`) })
                : errorMessage(t, place.error)}
            </Callout>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={place.isPending} onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={place.isPending} disabled={!target.trim() || !extension.trim()}>
              {t('calls.place.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CallRow({ call }: { call: CallView }) {
  const { t, i18n } = useTranslation();
  return (
    <TR className="hover:bg-surface-muted">
      <TD className="whitespace-nowrap">
        <Link to={`/calls/${encodeURIComponent(call.id)}`} className="rounded-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {formatDateTime(call.started_at, i18n.language)}
        </Link>
      </TD>
      <TD><span className="inline-flex items-center gap-2 text-muted-foreground">{call.direction === 'inbound' ? <ArrowDownLeft className="h-4 w-4" aria-hidden="true" /> : <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}{t(`calls.directions.${call.direction}`)}</span></TD>
      <TD className="whitespace-nowrap font-medium tabular-nums" data-masked-number="">
        {call.counterpart}
      </TD>
      <TD>{t(`calls.purposes.${call.purpose}`)}</TD>
      <TD>
        <Badge size="sm" tone={call.state === 'ended' ? 'neutral' : 'primary'}>
          {t(`calls.states.${call.state}`)}
        </Badge>
      </TD>
      <TD className="whitespace-nowrap tabular-nums">{duration(call.duration_s)}</TD>
      <TD>{call.outcome ? t(`calls.outcomes.${call.outcome}`) : '—'}</TD>
      <TD>{call.mode.kind === 'human' ? t('calls.modes.human', { ext: call.mode.rep_extension }) : t('calls.modes.agent')}</TD>
    </TR>
  );
}

/** `/calls`: the call log, "Place a call" for whoever may call, and the call policy. */
export function CallsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const canCall = can(session.data, 'calls.work');
  const canManage = can(session.data, 'calls.manage');
  const [placing, setPlacing] = useState(false);
  const [direction, setDirection] = useState<'all' | 'inbound' | 'outbound'>('all');
  const calls = useQuery({ queryKey: CALLS_KEY, queryFn: () => listCalls(), enabled: canCall });
  const visibleCalls = (calls.data ?? []).filter((call) => direction === 'all' || call.direction === direction);
  if (session.isPending) return <QueryState query={session} />;
  return (
    <>
      <PageHeader
        title={t('calls.title')}
        description={t('calls.description')}
        actions={
          canCall ? (
            <Button onClick={() => setPlacing(true)}>
              <Phone className="h-4 w-4" aria-hidden="true" />
              {t('calls.place.open')}
            </Button>
          ) : null
        }
      />
      {!canCall ? (
        <Callout tone="info">{t('calls.noPermission')}</Callout>
      ) : (
        <QueryState query={calls}>
          {(calls.data ?? []).length === 0 ? (
            <EmptyState className="rounded-none border-x-0" title={t('calls.empty')} description={t('calls.emptyBody')} />
          ) : (
            <section className="min-w-0 border-y border-border bg-surface">
              <div className="flex flex-wrap items-center gap-5 border-b border-border px-5 py-3">
                <span className="text-caption text-muted-foreground">{t('calls.columns.direction')}</span>
                <div className="flex flex-wrap gap-1" role="group" aria-label={t('calls.columns.direction')}>
                  {(['all', 'inbound', 'outbound'] as const).map((value) => (
                    <Button key={value} size="sm" variant="ghost" className={`rounded-none border-b-2 ${direction === value ? 'border-brand-accent text-foreground' : 'border-transparent'}`} aria-pressed={direction === value} onClick={() => setDirection(value)}>
                      {value === 'all' ? t('inbox.queue.all') : t(`calls.directions.${value}`)}
                    </Button>
                  ))}
                </div>
              </div>
            {visibleCalls.length === 0 ? (
              <EmptyState className="rounded-none border-0" title={t('calls.filterEmpty')} description={t('calls.filterEmptyBody')} action={<Button variant="outline" onClick={() => setDirection('all')}>{t('calls.showAll')}</Button>} />
            ) : (
            <div className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" tabIndex={0} role="region" aria-label={t('calls.title')}>
            <Table aria-label={t('calls.title')}>
              <THead>
                <TR>
                  <TH>{t('calls.columns.started')}</TH>
                  <TH>{t('calls.columns.direction')}</TH>
                  <TH>{t('calls.columns.number')}</TH>
                  <TH>{t('calls.columns.purpose')}</TH>
                  <TH>{t('calls.columns.state')}</TH>
                  <TH>{t('calls.columns.duration')}</TH>
                  <TH>{t('calls.columns.outcome')}</TH>
                  <TH>{t('calls.columns.who')}</TH>
                </TR>
              </THead>
              <TBody>
                {visibleCalls.map((c) => (
                  <CallRow key={c.id} call={c} />
                ))}
              </TBody>
            </Table>
            </div>
            )}
            </section>
          )}
        </QueryState>
      )}
      {canCall && <PlaceCallDialog open={placing} onOpenChange={setPlacing} />}
      {canManage && <CallsPolicy />}
    </>
  );
}
