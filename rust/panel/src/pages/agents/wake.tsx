import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ExternalLink } from 'lucide-react';
import { removeWake, setWake } from '@/api/agents';
import { isApiError } from '@/api/client';
import type { AgentWakeOut, SetWakeIn, WakeKind, WakesOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, ConfirmDialog, Field, Input, SegmentedControl, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { can } from '@/lib/roles';
import { WAKE_META, capitalise, everyPhrase, putWakes, routineIdOf, wakeTime, wakeTimeIn } from '@/lib/wake';

/** The fields `agents.wake_set` names in a `VALIDATION` refusal. */
const FIELDS = ['routine_id', 'token', 'url', 'secret'] as const;
type WakeField = (typeof FIELDS)[number];

function fieldOf(err: unknown): WakeField | null {
  if (!isApiError(err) || err.code !== 'VALIDATION') return null;
  const field = err.details.field;
  return (FIELDS as readonly unknown[]).includes(field) ? (field as WakeField) : null;
}

/** How often the agent comes and when next, from its own check-ins or the workspace's number. */
export function visitsText(t: TFunction, language: string, agent: AgentWakeOut, now = Date.now()): string | null {
  if (!agent.last_seen_at) return null;
  const visits = capitalise(t('wake.key.visits', { phrase: everyPhrase(t, agent.interval_minutes) }), language);
  const next = agent.next_expected_at;
  if (!next) return visits;
  return `${visits} · ${Date.parse(next) > now
    ? t('wake.key.next', { time: wakeTime(next, language) })
    : t('wake.key.late', { at: wakeTimeIn(next, language, 'loc') })}`;
}

/**
 * The inline form that sets an agent's wake address: a Claude routine (its id, or the trigger's
 * URL it is taken from, and the token) or a webhook (an HTTPS URL and an optional secret). The
 * token and the secret live only in this form's state, and are dropped once saved.
 */
function WakeForm({ apiKeyId, initial, onDone }: { apiKeyId: string; initial: WakeKind; onDone: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const session = useSession();
  const [kind, setKind] = useState<WakeKind>(initial);
  const [routine, setRoutine] = useState('');
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: (body: SetWakeIn) => setWake(apiKeyId, body),
    meta: WAKE_META,
    onSuccess: (out: WakesOut) => {
      putWakes(client, session.data?.current_workspace, out);
      setToken('');
      setSecret('');
      toast.success(t('wake.address.saved'));
      onDone();
    },
  });
  const failed = fieldOf(save.error);
  const fieldError = (field: WakeField) => (failed === field ? t(`wake.address.errors.${field}`) : undefined);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    save.mutate(kind === 'claude_routine'
      ? { kind, routine_id: routineIdOf(routine), token: token.trim() }
      : { kind, url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) });
  };
  return (
    <form className="flex max-w-xl flex-col gap-3 rounded-md border border-border bg-surface-muted/40 p-3" onSubmit={onSubmit} noValidate>
      <SegmentedControl
        aria-label={t('wake.address.kind')}
        value={kind}
        onChange={(next) => { setKind(next); save.reset(); }}
        options={[{ value: 'claude_routine', label: t('wake.address.kindRoutine') }, { value: 'webhook', label: t('wake.address.kindWebhook') }]}
        className="self-start"
      />
      <p className="text-caption text-muted-foreground">{t(kind === 'claude_routine' ? 'wake.address.routineHelp' : 'wake.address.webhookHelp')}</p>
      {kind === 'claude_routine' ? (
        <>
          <Field label={t('wake.address.routineId')} error={fieldError('routine_id')}>
            {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} autoComplete="off" spellCheck={false} placeholder={t('wake.address.routineIdPlaceholder')} value={routine} onChange={(e) => setRoutine(e.target.value)} />}
          </Field>
          <Field label={t('wake.address.token')} error={fieldError('token')}>
            {(ids) => <Input id={ids.id} type="password" aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />}
          </Field>
        </>
      ) : (
        <>
          <Field label={t('wake.address.url')} error={fieldError('url')}>
            {(ids) => <Input id={ids.id} type="url" inputMode="url" aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} autoComplete="off" spellCheck={false} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <Field label={t('wake.address.secret')} error={fieldError('secret')}>
            {(ids) => <Input id={ids.id} type="password" aria-describedby={ids.describedBy} aria-invalid={ids.invalid || undefined} autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />}
          </Field>
        </>
      )}
      {!failed && <ErrorCallout error={save.error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={save.isPending}>{t('wake.address.save')}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>{t('wake.address.cancel')}</Button>
      </div>
    </form>
  );
}

/** The outcome of the last call, after its time; nothing when the agent was never called. */
function lastText(t: TFunction, language: string, agent: AgentWakeOut): string | null {
  if (!agent.last) return null;
  return t('wake.address.last', { time: wakeTime(agent.last.at, language), outcome: t(`wake.address.outcome.${agent.last.outcome}`) });
}

/**
 * One agent's wake address on its key's row, in one compact line: none (with "Ekle"), the kind
 * and its target with the last call's outcome and its session, or refused; then how often the
 * agent comes and when next. Only a person holding `team.manage` sees the form and its buttons.
 */
export function KeyWake({ agent }: { agent: AgentWakeOut }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const session = useSession();
  const manage = can(session.data, 'team.manage');
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = useMutation({
    mutationFn: () => removeWake(agent.api_key_id),
    meta: WAKE_META,
    onSuccess: (out) => {
      putWakes(client, session.data?.current_workspace, out);
      setRemoving(false);
      toast.success(t('wake.address.removed'));
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const lang = i18n.language;
  const address = agent.address;
  const parts: string[] = [];
  if (!address) parts.push(t('wake.address.none'));
  else if (address.refused_at) parts.push(t('wake.address.refused', { time: wakeTime(address.refused_at, lang) }));
  else {
    parts.push(t(address.kind === 'claude_routine' ? 'wake.address.routine' : 'wake.address.webhook', { target: address.target }));
    const last = lastText(t, lang, agent);
    if (last) parts.push(last);
  }
  const visits = visitsText(t, lang, agent);
  const session_url = address && !address.refused_at ? agent.last?.session_url : null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-muted-foreground">
          {parts.join(' · ')}
          {session_url && (
            <>
              {' · '}
              <a className="inline-flex items-center gap-0.5 text-primary underline underline-offset-4" href={session_url} target="_blank" rel="noreferrer">
                {t('wake.address.session')}
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
              </a>
            </>
          )}
        </span>
        {manage && !editing && (
          <span className="flex flex-wrap gap-1">
            {address
              ? <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(true)}>{t('wake.address.change')}</Button>
              : <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(true)}>{t('wake.address.add')}</Button>}
            {address && !address.refused_at && <Button size="sm" variant="ghost" className="h-7" onClick={() => setRemoving(true)}>{t('wake.address.remove')}</Button>}
          </span>
        )}
        {visits && <span className="text-caption text-muted-foreground">{visits}</span>}
      </div>
      {manage && editing && <WakeForm apiKeyId={agent.api_key_id} initial={address?.kind ?? 'claude_routine'} onDone={() => setEditing(false)} />}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => !open && !remove.isPending && setRemoving(false)}
        title={t('wake.address.removeTitle')}
        description={t('wake.address.removeBody')}
        confirmLabel={t('wake.address.remove')}
        cancelLabel={t('wake.address.cancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => { if (!remove.isPending) remove.mutate(); }}
      />
    </div>
  );
}
