import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone } from 'lucide-react';
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
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
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{t('calls.place.purpose')}</legend>
            {CALL_PURPOSES.map((p) => (
              <label key={p} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={place.isPending || !target.trim() || !extension.trim()}>
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
    <TR>
      <TD className="whitespace-nowrap">
        <Link to={`/calls/${encodeURIComponent(call.id)}`} className="text-primary underline-offset-2 hover:underline">
          {formatDateTime(call.started_at, i18n.language)}
        </Link>
      </TD>
      <TD>{t(`calls.directions.${call.direction}`)}</TD>
      <TD className="font-mono text-caption" data-masked-number="">
        {call.counterpart}
      </TD>
      <TD>{t(`calls.purposes.${call.purpose}`)}</TD>
      <TD>
        <Badge size="sm" tone={call.state === 'ended' ? 'neutral' : 'primary'}>
          {t(`calls.states.${call.state}`)}
        </Badge>
      </TD>
      <TD className="whitespace-nowrap">{duration(call.duration_s)}</TD>
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
  const calls = useQuery({ queryKey: CALLS_KEY, queryFn: () => listCalls(), enabled: canCall });
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
            <EmptyState title={t('calls.empty')} description={t('calls.emptyBody')} />
          ) : (
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
                {(calls.data ?? []).map((c) => (
                  <CallRow key={c.id} call={c} />
                ))}
              </TBody>
            </Table>
          )}
        </QueryState>
      )}
      {canCall && <PlaceCallDialog open={placing} onOpenChange={setPlacing} />}
      {canManage && <CallsPolicy />}
    </>
  );
}
