import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { getCapability } from '@/api/capabilities';
import { reconnectConnector, setCredentials, startOAuth } from '@/api/connectors';
import { PROVIDERS, type Capability, type CapabilityOut, type CredentialInput, type Provider } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Disclosure,
  Field,
  Input,
  PageHeader,
  cn,
} from '@/components/ui';
import { browser, providerUrl } from '@/lib/browser';
import { kindLabel } from '@/lib/capabilities';
import {
  PROVIDER_KINDS,
  PROVIDER_NAMES,
  connectsByOAuth,
  isErrorKind,
  netgsmCredentialKind,
  providerOf,
  tokenNeedsExternalId,
} from '@/lib/connectors';
import { can } from '@/lib/roles';
import { CAPABILITIES_KEY, invalidateCapabilities } from './capabilities/queries';

/** The kinds of every provider, in sections, one pressed. */
function KindPicker({ value, onChange }: { value: string | null; onChange: (kind: string) => void }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('connect.kindsLabel')} className="grid gap-4 md:grid-cols-3">
      {PROVIDERS.map((provider) => (
        <div
          key={provider}
          role="group"
          aria-label={t(`connect.providers.${provider}`)}
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
        >
          <h2 className="text-sm font-semibold text-foreground">{t(`connect.providers.${provider}`)}</h2>
          <div className="flex flex-wrap gap-2">
            {PROVIDER_KINDS[provider].map((kind) => {
              const active = kind === value;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange(kind)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-caption font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-surface text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                  )}
                >
                  {kindLabel(t, kind)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

/** One text field of a form, labelled; a secret is a password field, never autofilled. */
function TextField({
  label,
  hint,
  value,
  onChange,
  secret = false,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  secret?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(ids) => (
        <Input
          id={ids.id}
          aria-describedby={ids.describedBy}
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'}
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * Sends the browser to a provider's sign-in page: a new flow for `kind`, or a reconnection of
 * `capability` when it names its account. Nothing is asked for here; the provider asks.
 */
function OAuthPanel({ kind, capability }: { kind: string; capability: Capability | null }) {
  const { t } = useTranslation();
  const provider = providerOf(kind) as Provider;
  // A capability that names its account signs in again for it (a flow bound to it); a first
  // connection of a declared one reads as one, a renewal as a reconnection.
  const bound = capability !== null && capability.external_id !== null;
  const reconnecting = bound && capability.status !== 'declared';
  const [redirecting, setRedirecting] = useState(false);
  const start = useMutation({
    mutationFn: async () => {
      const out = bound ? await reconnectConnector(capability.id) : await startOAuth(kind);
      const url = providerUrl(out.authorize_url);
      if (!url) throw new Error('the provider address is not an https address');
      return url;
    },
    onSuccess: (url) => {
      setRedirecting(true);
      browser.assign(url);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('connect.oauth.title')}</CardTitle>
        <CardDescription>{reconnecting ? t('connect.oauth.reconnectBody') : t('connect.oauth.body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {capability !== null && !bound && <Callout tone="info">{t('connect.oauth.newCapabilityNote')}</Callout>}
        <ErrorCallout error={start.error} />
        {redirecting ? (
          <p className="text-sm text-muted-foreground">{t('capabilities.connector.redirecting')}</p>
        ) : (
          <div>
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              {reconnecting
                ? t('connect.oauth.reconnectSubmit')
                : t('connect.oauth.submit', { provider: PROVIDER_NAMES[provider] })}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The probe's outcome as the capability carries it after its credentials were entered. */
function Result({ out, onAnother }: { out: CapabilityOut; onAnother: () => void }) {
  const { t } = useTranslation();
  const health = out.capability.connector_public.health as { ok?: unknown; error_kind?: unknown } | undefined;
  let callout: ReactNode;
  if (out.effective_status === 'verified') {
    callout = <Callout tone="success">{t('connect.result.verified')}</Callout>;
  } else if (health && health.ok === false) {
    const reason = isErrorKind(health.error_kind)
      ? t(`capabilities.connector.errorKinds.${health.error_kind}`)
      : t('capabilities.connector.errorKinds.unknown');
    callout = <Callout tone="warning">{t('connect.result.failed', { reason })}</Callout>;
  } else {
    callout = <Callout tone="info">{t('connect.result.pending')}</Callout>;
  }
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />
        <CardTitle>{out.capability.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {callout}
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/capabilities">{t('connect.result.toCapabilities')}</Link>
          </Button>
          <Button variant="outline" onClick={onAnother}>
            {t('connect.result.another')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Credentials entered by hand and probed at once. Secrets live in this form's state only: the
 * mutation is dropped as soon as it answers, and the form is emptied, so no cache holds them.
 */
function useCredentialsMutation(onDone: (out: CapabilityOut) => void) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: setCredentials,
    gcTime: 0,
    onSuccess: async (out) => {
      onDone(out);
      mutation.reset();
      await invalidateCapabilities(queryClient);
    },
  });
  return mutation;
}

/** The target of the credentials: the existing capability, or a new one of `kind` named `name`. */
function target(kind: string, capability: Capability | null, name: string) {
  return capability ? { capability_id: capability.id } : { kind_key: kind, name: name.trim() };
}

/** The NetGSM credentials form of `kind` (`sms_line` or `netgsm_pbx`). */
function NetgsmForm({
  kind,
  capability,
  onDone,
}: {
  kind: string;
  capability: Capability | null;
  onDone: (out: CapabilityOut) => void;
}) {
  const { t } = useTranslation();
  const shape = netgsmCredentialKind(kind);
  const empty = { name: '', usercode: '', password: '', msgheader: '', username: '', trunk: '', pbxnum: '' };
  const [form, setForm] = useState(empty);
  const save = useCredentialsMutation((out) => {
    setForm(empty);
    onDone(out);
  });
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const credential: CredentialInput =
    shape === 'netgsm_sms'
      ? { kind: 'netgsm_sms', usercode: form.usercode.trim(), password: form.password, msgheader: form.msgheader.trim() }
      : {
          kind: 'netgsm_pbx',
          username: form.username.trim(),
          password: form.password,
          trunk: form.trunk.trim() || undefined,
          pbxnum: form.pbxnum.trim() || undefined,
        };
  const complete =
    (capability !== null || form.name.trim() !== '') &&
    form.password !== '' &&
    (shape === 'netgsm_sms'
      ? form.usercode.trim() !== '' && form.msgheader.trim() !== ''
      : form.username.trim() !== '');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (complete) save.mutate({ ...target(kind, capability, form.name), credential });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('connect.credentials.title')}</CardTitle>
        <CardDescription>{t('connect.credentials.body')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate autoComplete="off">
          <ErrorCallout error={save.error} />
          {capability === null && (
            <TextField
              label={t('connect.credentials.name')}
              hint={t('connect.credentials.nameHint')}
              value={form.name}
              onChange={set('name')}
            />
          )}
          {shape === 'netgsm_sms' ? (
            <>
              <TextField label={t('connect.credentials.usercode')} value={form.usercode} onChange={set('usercode')} />
              <TextField label={t('connect.credentials.password')} value={form.password} onChange={set('password')} secret />
              <TextField
                label={t('connect.credentials.msgheader')}
                hint={t('connect.credentials.msgheaderHint')}
                value={form.msgheader}
                onChange={set('msgheader')}
              />
            </>
          ) : (
            <>
              <TextField label={t('connect.credentials.username')} value={form.username} onChange={set('username')} />
              <TextField label={t('connect.credentials.password')} value={form.password} onChange={set('password')} secret />
              <TextField label={t('connect.credentials.trunk')} value={form.trunk} onChange={set('trunk')} />
              <TextField label={t('connect.credentials.pbxnum')} value={form.pbxnum} onChange={set('pbxnum')} />
            </>
          )}
          <div>
            <Button type="submit" loading={save.isPending} disabled={!complete}>
              {t('connect.credentials.submit')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** A Meta access token pasted by hand: an advanced way in, kept out of sight until asked for. */
function TokenForm({
  kind,
  capability,
  onDone,
}: {
  kind: string;
  capability: Capability | null;
  onDone: (out: CapabilityOut) => void;
}) {
  const { t } = useTranslation();
  const needsAccount = tokenNeedsExternalId(kind) && !capability?.external_id;
  const empty = { name: '', token: '', externalId: '' };
  const [form, setForm] = useState(empty);
  const save = useCredentialsMutation((out) => {
    setForm(empty);
    onDone(out);
  });
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const complete =
    (capability !== null || form.name.trim() !== '') &&
    form.token.trim() !== '' &&
    (!needsAccount || form.externalId.trim() !== '');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!complete) return;
    const externalId = form.externalId.trim();
    save.mutate({
      ...target(kind, capability, form.name),
      ...(externalId ? { external_id: externalId } : {}),
      credential: { kind: 'meta_token', access_token: form.token.trim() },
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate autoComplete="off">
      <p className="text-sm text-muted-foreground">{t('connect.token.body')}</p>
      <ErrorCallout error={save.error} />
      {capability === null && (
        <TextField
          label={t('connect.credentials.name')}
          hint={t('connect.credentials.nameHint')}
          value={form.name}
          onChange={set('name')}
        />
      )}
      <TextField label={t('connect.token.accessToken')} value={form.token} onChange={set('token')} secret />
      {!capability?.external_id && (
        <TextField
          label={needsAccount ? t('connect.token.externalId') : t('connect.token.externalIdOptional')}
          hint={t('connect.token.externalIdHint')}
          value={form.externalId}
          onChange={set('externalId')}
        />
      )}
      <div>
        <Button type="submit" variant="outline" loading={save.isPending} disabled={!complete}>
          {t('connect.token.submit')}
        </Button>
      </div>
    </form>
  );
}

/** How `kind` connects: by signing in (Meta, X; Meta also by a pasted token), or by credentials (NetGSM). */
function ConnectKind({
  kind,
  capability,
  onDone,
}: {
  kind: string;
  capability: Capability | null;
  onDone: (out: CapabilityOut) => void;
}) {
  const { t } = useTranslation();
  if (netgsmCredentialKind(kind)) return <NetgsmForm kind={kind} capability={capability} onDone={onDone} />;
  if (!connectsByOAuth(kind)) return <Callout tone="info">{t('connect.unsupported')}</Callout>;
  return (
    <div className="flex flex-col gap-4">
      <OAuthPanel kind={kind} capability={capability} />
      {providerOf(kind) === 'meta' && (
        <Disclosure title={t('connect.advanced')}>
          <TokenForm kind={kind} capability={capability} onDone={onDone} />
        </Disclosure>
      )}
    </div>
  );
}

/**
 * `/connect`: connecting an account. `?kind=` preselects a kind; `?capability=` connects (or
 * reconnects) that capability instead of a new one: its kind is fixed and its id is sent.
 */
export function ConnectPage() {
  const { t } = useTranslation();
  const session = useSession();
  const canManage = can(session.data, 'capabilities.manage');
  const [params] = useSearchParams();
  const capabilityId = params.get('capability');
  const requested = params.get('kind');
  const [chosen, setChosen] = useState<string | null>(requested && providerOf(requested) ? requested : null);
  const [done, setDone] = useState<CapabilityOut | null>(null);
  const existing = useQuery({
    queryKey: [...CAPABILITIES_KEY, 'one', capabilityId],
    queryFn: () => getCapability(capabilityId as string),
    enabled: canManage && capabilityId !== null,
  });
  const capability = existing.data?.capability ?? null;
  const kind = capability ? capability.kind_key : chosen;

  let body: ReactNode;
  if (!canManage) {
    body = <Callout tone="warning">{t('connect.noPermission')}</Callout>;
  } else if (done) {
    body = (
      <Result
        out={done}
        onAnother={() => {
          setDone(null);
          setChosen(null);
        }}
      />
    );
  } else if (capabilityId !== null) {
    body = (
      <QueryState query={existing}>
        {capability && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground">
              {t('connect.forCapability', { name: capability.name })}{' '}
              <span className="text-muted-foreground">({kindLabel(t, capability.kind_key)})</span>
            </p>
            <ConnectKind kind={capability.kind_key} capability={capability} onDone={setDone} />
          </div>
        )}
      </QueryState>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        <KindPicker value={kind} onChange={setChosen} />
        {kind ? (
          <ConnectKind key={kind} kind={kind} capability={null} onDone={setDone} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('connect.chooseKind')}</p>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader title={t('connect.title')} description={t('connect.description')} />
      {body}
    </>
  );
}
