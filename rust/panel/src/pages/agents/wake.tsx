import { useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Zap } from 'lucide-react';
import { removeWake, setWake, wakeNow } from '@/api/agents';
import { isApiError } from '@/api/client';
import type { AgentWakeOut, SetWakeIn, WakeKind, WakeOutcome, WakesOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, ConfirmDialog, Field, Input, SegmentedControl, cn, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { WAKE_META, putWakes, routineIdOf, wakeTime, wakeTimeIn } from '@/lib/wake';
import { useAgentCopy, type AgentCopyKey } from './copy';

/** The fields `agents.wake_set` names in a `VALIDATION` refusal, and the panel checks first. */
const FIELDS = ['routine_id', 'token', 'url', 'secret'] as const;
export type WakeField = (typeof FIELDS)[number];

/** The prefix of a Claude routine's API token (docs: "Trigger a routine via API"). */
export const ROUTINE_TOKEN_PREFIX = 'sk-ant-oat01-';
/** The longest routine id, webhook URL and secret the server takes (`jt_app::usecases::wake`). */
const ROUTINE_ID_MAX = 128;
const URL_MAX = 2048;
const SECRET_MAX = 4096;

function fieldOf(err: unknown): WakeField | null {
  if (!isApiError(err) || err.code !== 'VALIDATION') return null;
  const field = err.details.field;
  return (FIELDS as readonly unknown[]).includes(field) ? (field as WakeField) : null;
}

export interface WakeInput { kind: WakeKind; routine: string; token: string; url: string; secret: string }

/**
 * What is wrong with a wake address before it is sent, by field, as the copy key that says so:
 * a routine id is `trig_…` (or the trigger's URL, reduced to it), a token starts with
 * `sk-ant-oat01-`; a webhook is a public https URL without a user, its secret printable without
 * spaces. The server checks again.
 */
export function checkWake(input: WakeInput): Partial<Record<WakeField, AgentCopyKey>> {
  const out: Partial<Record<WakeField, AgentCopyKey>> = {};
  if (input.kind === 'claude_routine') {
    const typed = input.routine.trim();
    const id = routineIdOf(typed);
    if (!typed) out.routine_id = 'eRoutineEmpty';
    else if (/^[^\s@/]+@[^\s@]+\.[^\s@]+$/.test(typed)) out.routine_id = 'eRoutineEmail';
    else if (!/^trig_[A-Za-z0-9_-]+$/.test(id) || id.length > ROUTINE_ID_MAX) out.routine_id = 'eRoutine';
    const token = input.token.trim();
    if (!token) out.token = 'eTokenEmpty';
    else if (!token.startsWith(ROUTINE_TOKEN_PREFIX) || token.length <= ROUTINE_TOKEN_PREFIX.length || /\s/.test(token) || token.length > SECRET_MAX) out.token = 'eToken';
  } else {
    const typed = input.url.trim();
    let ok = false;
    try {
      const url = new URL(typed);
      ok = url.protocol === 'https:' && !url.username && !url.password && !!url.hostname && typed.length <= URL_MAX;
    } catch { ok = false; }
    if (!ok) out.url = 'eUrl';
    const secret = input.secret.trim();
    if (secret && (!/^[\x21-\x7e]+$/.test(secret) || secret.length > SECRET_MAX)) out.secret = 'eSecret';
  }
  return out;
}

/** Attributes the common password managers read as "leave this field alone". */
const NOT_A_LOGIN = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-protonpass-ignore': 'true',
  'data-form-type': 'other',
} as const;

/** Whether this browser can mask a text field's characters (`-webkit-text-security`). */
function canMask(): boolean {
  try { return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc'); }
  catch { return false; }
}

/**
 * A secret typed into the panel: a text field (never `type=password`, which password managers
 * take for a login and fill with the person's own password), masked by CSS where the browser can,
 * with a button that shows it. Where the browser cannot mask, the secret shows as typed.
 */
function SecretInput({ id, revealLabel, hideLabel, ...rest }: InputHTMLAttributes<HTMLInputElement> & { id: string; revealLabel: string; hideLabel: string }) {
  const [shown, setShown] = useState(false);
  const masked = !shown && canMask();
  return (
    <div className="relative">
      <Input
        {...rest}
        {...NOT_A_LOGIN}
        id={id}
        type="text"
        inputMode="text"
        data-masked={masked ? 'true' : undefined}
        className="pe-20 font-mono text-caption"
        style={masked ? ({ WebkitTextSecurity: 'disc' } as React.CSSProperties) : undefined}
      />
      <button
        type="button"
        aria-controls={id}
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
        className="absolute inset-y-0 end-0 rounded-e-md px-3 text-caption font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {shown ? hideLabel : revealLabel}
      </button>
    </div>
  );
}

/**
 * The inline form that sets an agent's wake address: a Claude routine (its id, or the trigger URL
 * it is taken from, and the token) or a webhook (an HTTPS URL and an optional signing secret).
 * Checked here before it is sent; the token and the secret live only in this form's state.
 */
export function WakeForm({ apiKeyId, name, initial, onDone }: { apiKeyId: string; name: string; initial: WakeKind; onDone: () => void }) {
  const copy = useAgentCopy();
  const client = useQueryClient();
  const session = useSession();
  const [input, setInput] = useState<WakeInput>({ kind: initial, routine: '', token: '', url: '', secret: '' });
  const [checked, setChecked] = useState<Partial<Record<WakeField, AgentCopyKey>>>({});
  const save = useMutation({
    mutationFn: (body: SetWakeIn) => setWake(apiKeyId, body),
    meta: WAKE_META,
    onSuccess: (out: WakesOut) => {
      putWakes(client, session.data?.current_workspace, out);
      setInput((v) => ({ ...v, token: '', secret: '' }));
      toast.success(copy('wakeSaved'));
      onDone();
    },
  });
  const refused = fieldOf(save.error);
  const errorAt = (field: WakeField) => {
    const key = checked[field] ?? (refused === field ? ({ routine_id: 'eRoutine', token: 'eToken', url: 'eUrl', secret: 'eSecret' } as const)[field] : undefined);
    return key ? copy(key) : undefined;
  };
  const edit = (field: keyof WakeInput, value: string) => {
    setInput((v) => ({ ...v, [field]: value }));
    const at = field === 'routine' ? 'routine_id' : field;
    if (at !== 'kind' && checked[at]) setChecked((c) => ({ ...c, [at]: undefined }));
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const problems = checkWake(input);
    setChecked(problems);
    if (Object.values(problems).some(Boolean)) return;
    save.mutate(input.kind === 'claude_routine'
      ? { kind: 'claude_routine', routine_id: routineIdOf(input.routine), token: input.token.trim() }
      : { kind: 'webhook', url: input.url.trim(), ...(input.secret.trim() ? { secret: input.secret.trim() } : {}) });
  };
  const described = (ids: { id: string; describedBy?: string; invalid: boolean }) => ({
    id: ids.id,
    'aria-describedby': ids.describedBy,
    'aria-invalid': ids.invalid || undefined,
  });
  return (
    <form
      aria-label={copy('formLabel', { name })}
      autoComplete="off"
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      className="flex max-w-xl flex-col gap-3 rounded-md border border-border bg-surface-muted/40 p-3"
      onSubmit={onSubmit}
      noValidate
    >
      <SegmentedControl
        aria-label={copy('kind')}
        value={input.kind}
        onChange={(kind) => { setInput((v) => ({ ...v, kind })); setChecked({}); save.reset(); }}
        options={[{ value: 'claude_routine', label: copy('kindRoutine') }, { value: 'webhook', label: copy('kindWebhook') }]}
        className="self-start"
      />
      <p className="text-caption text-muted-foreground">{copy(input.kind === 'claude_routine' ? 'routineHelp' : 'webhookHelp')}</p>
      {input.kind === 'claude_routine' ? (
        <>
          <Field label={copy('routineId')} error={errorAt('routine_id')}>
            {(ids) => <Input {...described(ids)} {...NOT_A_LOGIN} name="jeeta-wake-routine" className="font-mono text-caption" placeholder={copy('routineIdPlaceholder')} value={input.routine} onChange={(e) => edit('routine', e.target.value)} />}
          </Field>
          <Field label={copy('token')} error={errorAt('token')}>
            {(ids) => <SecretInput {...described(ids)} name="jeeta-wake-routine-token" placeholder={`${ROUTINE_TOKEN_PREFIX}…`} revealLabel={copy('show')} hideLabel={copy('hide')} value={input.token} onChange={(e) => edit('token', e.target.value)} />}
          </Field>
        </>
      ) : (
        <>
          <Field label={copy('url')} error={errorAt('url')}>
            {(ids) => <Input {...described(ids)} {...NOT_A_LOGIN} name="jeeta-wake-webhook" type="url" inputMode="url" className="font-mono text-caption" placeholder="https://…" value={input.url} onChange={(e) => edit('url', e.target.value)} />}
          </Field>
          <Field label={copy('secret')} error={errorAt('secret')}>
            {(ids) => <SecretInput {...described(ids)} name="jeeta-wake-webhook-signing" revealLabel={copy('show')} hideLabel={copy('hide')} value={input.secret} onChange={(e) => edit('secret', e.target.value)} />}
          </Field>
        </>
      )}
      {!refused && <ErrorCallout error={save.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={save.isPending}>{copy('save')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>{copy('cancel')}</Button>
      </div>
    </form>
  );
}

const OUTCOME: Record<WakeOutcome, AgentCopyKey> = {
  fired: 'outcomeFired', rate_limited: 'outcomeRateLimited', unavailable: 'outcomeUnavailable',
  gave_up: 'outcomeGaveUp', refused: 'outcomeRefused', rejected: 'outcomeRejected',
};

/**
 * "Şimdi çalıştır": wakes the agent now. While the rate limits hold it back the button waits,
 * with the time it may go; a refusal says why under it.
 */
export function RunNowButton({ wake, now }: { wake: AgentWakeOut; now: number }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const session = useSession();
  const [refusal, setRefusal] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => wakeNow(wake.api_key_id),
    meta: WAKE_META,
    onMutate: () => setRefusal(null),
    onSuccess: (out) => putWakes(client, session.data?.current_workspace, out),
    onError: (err) => {
      const retry = isApiError(err) && err.details.reason === 'rate_limited' && typeof err.details.retry_at === 'string' ? err.details.retry_at : null;
      setRefusal(retry ? t('wake.line.rateLimited', { at: wakeTimeIn(retry, i18n.language, 'abl') }) : errorMessage(t, err));
    },
  });
  if (!wake.run_now) return null;
  const after = wake.run_now.after && Date.parse(wake.run_now.after) > now ? wake.run_now.after : null;
  return (
    <span className="flex min-w-0 max-w-[18rem] flex-col items-end gap-1 text-end">
      <Button size="sm" variant="outline" disabled={!!after} loading={run.isPending} onClick={() => !run.isPending && run.mutate()}>
        <Zap aria-hidden="true" className="h-3.5 w-3.5" />
        {t('wake.line.runNow')}
      </Button>
      {after && <span className="text-caption text-muted-foreground">{t('wake.line.runAfter', { at: wakeTimeIn(after, i18n.language, 'abl') })}</span>}
      {refusal && <span role="alert" className="text-caption font-medium text-warning">{refusal}</span>}
    </span>
  );
}

/**
 * The agent's wake address as one compact line: the kind and its target with the last call's
 * outcome and session, or refused (the one red line); "Değiştir" and "Kaldır" for a person with
 * `team.manage`. Without an address there is no line: the row offers "Hemen çağrılabilsin".
 */
export function WakeLine({ wake, manage, onEdit }: { wake: AgentWakeOut; manage: boolean; onEdit: () => void }) {
  const copy = useAgentCopy();
  const { t } = useTranslation();
  const client = useQueryClient();
  const session = useSession();
  const [removing, setRemoving] = useState(false);
  const remove = useMutation({
    mutationFn: () => removeWake(wake.api_key_id),
    meta: WAKE_META,
    onSuccess: (out) => {
      putWakes(client, session.data?.current_workspace, out);
      setRemoving(false);
      toast.success(copy('wakeRemoved'));
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const address = wake.address;
  if (!address) return null;
  const lang = copy.language;
  const refused = !!address.refused_at;
  const parts: string[] = [];
  if (refused) parts.push(copy('wakeRefused', { time: wakeTime(address.refused_at!, lang) }));
  else {
    parts.push(copy(address.kind === 'claude_routine' ? 'wakeRoutine' : 'wakeWebhook', { target: address.target }));
    if (wake.last) parts.push(copy('wakeLast', { time: wakeTime(wake.last.at, lang), outcome: copy(OUTCOME[wake.last.outcome]) }));
  }
  const sessionUrl = !refused ? wake.last?.session_url : null;
  return (
    <div
      data-testid="wake-line"
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-caption', refused ? 'font-medium text-danger' : 'text-muted-foreground')}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {parts.join(' · ')}
        {sessionUrl && (
          <>
            {' · '}
            <a className="inline-flex items-center gap-0.5 text-primary underline underline-offset-4" href={sessionUrl} target="_blank" rel="noreferrer">
              {copy('wakeSession')}
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </a>
          </>
        )}
      </span>
      {manage && (
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onEdit}>{copy('wakeChange')}</Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setRemoving(true)}>{copy('wakeRemove')}</Button>
        </span>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => !open && !remove.isPending && setRemoving(false)}
        title={copy('wakeRemoveTitle')}
        description={copy('wakeRemoveBody')}
        confirmLabel={copy('wakeRemove')}
        cancelLabel={copy('cancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => { if (!remove.isPending) remove.mutate(); }}
      />
    </div>
  );
}
