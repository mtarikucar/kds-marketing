import { isApiError } from '@/api/client';
import { ProviderSetup } from './ProviderSetup';
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
  PROVIDER_NAMES,
  connectableKinds,
  connectsByOAuth,
  isConnectable,
  isErrorKind,
  netgsmCredentialKind,
  providerOf,
  tokenNeedsExternalId,
} from '@/lib/connectors';
import { rememberStart } from '@/lib/oauthFlow';
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
            {connectableKinds(provider).map((kind) => {
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

/**
 * One text field of a form, labelled; a secret is a password field. These are a provider's
 * credentials, never the panel's sign-in: neither the browser nor a password manager may fill
 * them, or a saved panel e-mail and password would quietly become the provider's.
 */
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
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
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
  // An existing capability signs in through a flow bound to it: a renewal reads as a
  // reconnection; a declared one's first connection as a sign-in, whose first chosen account
  // becomes it.
  const bound = capability !== null;
  const reconnecting = bound && capability.status !== 'declared';
  const [redirecting, setRedirecting] = useState(false);
  const start = useMutation({
    mutationFn: async () => {
      const out = bound ? await reconnectConnector(capability.id) : await startOAuth(kind);
      const url = providerUrl(out.authorize_url);
      if (!url) throw new Error('the provider address is not an https address');
      rememberStart(out, bound ? capability.id : null);
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
        {capability !== null && capability.external_id === null && (
          <Callout tone="info">{t('connect.oauth.firstBindsNote')}</Callout>
        )}
        {isApiError(start.error) && start.error.code === 'CONFLICT' && start.error.details.reason === 'provider_app_not_configured' ? <Callout tone="warning">{t('providerSetup.missing')}</Callout> : <ErrorCallout error={start.error} />}
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

/** Public access metadata is useful both immediately after a probe and on a later visit. */
function ConnectorAccess({ capability }: { capability: Capability }) {
  const { t } = useTranslation();
  const access = capability.connector_public.access as { expires_at?: unknown } | undefined;
  return <>
    {capability.connector_public.reconnect_required === true &&
      <Callout tone="warning">{t('providerSetup.reconnect')}</Callout>}
    {typeof access?.expires_at === 'string' &&
      <p>{t('providerSetup.expires')}: <time dateTime={access.expires_at}>{access.expires_at}</time></p>}
  </>;
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
        <ConnectorAccess capability={out.capability} />
        {out.capability.kind_key === 'sms_line' && <IysForm capability={out.capability} />}
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
        {shape === 'netgsm_sms' && <div className="mt-4">
          {capability ? <IysForm capability={capability} /> : <p className="text-sm text-muted-foreground">{t('connect.iys.first')}</p>}
        </div>}
      </CardContent>
    </Card>
  );
}

/** A separate optional form: attaching IYS never resubmits or replaces SMS credentials. */
function IysForm({ capability }: { capability: Capability }) {
  const { t } = useTranslation();
  const empty = { usercode: capability.external_id ?? '', password: '', brand_code: '' };
  const [form, setForm] = useState(empty);
  const [saved, setSaved] = useState(false);
  const save = useCredentialsMutation(() => { setForm(empty); setSaved(true); });
  const complete = form.usercode.trim() !== '' && form.password !== '' && form.brand_code.trim() !== '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete) save.mutate({ capability_id: capability.id, credential: {
      kind: 'netgsm_iys', usercode: form.usercode.trim(), password: form.password, brand_code: form.brand_code.trim(),
    } });
  };
  return <Disclosure title={t('connect.iys.title')}>
    {saved ? <Callout tone="success">{t('connect.iys.saved')}</Callout> :
      <form className="flex flex-col gap-4" onSubmit={submit} autoComplete="off">
        <p className="text-sm text-muted-foreground">{t('connect.iys.body')}</p>
        <ErrorCallout error={save.error} />
        <TextField label={t('connect.iys.usercode')} value={form.usercode} onChange={(usercode) => setForm((f) => ({ ...f, usercode }))} />
        <TextField label={t('connect.iys.password')} value={form.password} secret onChange={(password) => setForm((f) => ({ ...f, password }))} />
        <TextField label={t('connect.iys.brandCode')} value={form.brand_code} onChange={(brand_code) => setForm((f) => ({ ...f, brand_code }))} />
        <Button type="submit" loading={save.isPending} disabled={!complete}>{t('connect.iys.submit')}</Button>
      </form>}
  </Disclosure>;
}

/** SMTP/IMAP credentials use the same mutation and secret-clearing lifecycle. */
function MailboxForm({ capability, onDone }: { capability: Capability | null; onDone: (out: CapabilityOut) => void }) {
  const { t } = useTranslation();
  const empty = { name: '', smtp_host: '', imap_host: '', username: '', password: '', from_address: '' };
  const [form, setForm] = useState(empty);
  const [tls, setTls] = useState<'implicit' | 'start_tls'>('implicit');
  const save = useCredentialsMutation((out) => { setForm(empty); onDone(out); });
  const complete = Object.entries(form).every(([key, value]) => (key === 'name' && capability !== null) || value.trim() !== '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!complete) return;
    save.mutate({ ...target('mailbox', capability, form.name), credential: {
      kind: 'mailbox', smtp_host: form.smtp_host.trim(), smtp_port: tls === 'implicit' ? 465 : 587,
      imap_host: form.imap_host.trim(), imap_port: tls === 'implicit' ? 993 : 143,
      username: form.username.trim(), password: form.password, from_address: form.from_address.trim(), tls,
    } });
  };
  return <Card><CardHeader><CardTitle>{t('connect.mail.title')}</CardTitle><CardDescription>{t('connect.mail.body')}</CardDescription></CardHeader>
    <CardContent><form className="flex flex-col gap-4" onSubmit={submit} autoComplete="off">
      <ErrorCallout error={save.error} />
      {(Object.keys(empty) as (keyof typeof empty)[]).filter((key) => key !== 'name' || capability === null).map((key) =>
        <TextField key={key} label={t(`connect.mail.${key}`)} value={form[key]} secret={key === 'password'} onChange={(value) => setForm((f) => ({ ...f, [key]: value }))} />)}
      <Field label={t('connect.mail.tls')}>{(ids) => <select id={ids.id} className="rounded-md border border-border bg-surface p-2" value={tls} onChange={(e) => setTls(e.target.value as typeof tls)}>
        <option value="implicit">TLS (SMTP 465 / IMAP 993)</option><option value="start_tls">STARTTLS (SMTP 587 / IMAP 143)</option>
      </select>}</Field>
      <Button type="submit" loading={save.isPending} disabled={!complete}>{t('connect.credentials.submit')}</Button>
    </form></CardContent></Card>;
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
  if (kind === 'sms_line' && capability?.status === 'verified') return <IysForm capability={capability} />;
  if (kind === 'mailbox') return <MailboxForm capability={capability} onDone={onDone} />;
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
  const [chosen, setChosen] = useState<string | null>(requested && isConnectable(requested) ? requested : null);
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
            <ConnectorAccess capability={capability} />
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
      <Link className="text-primary underline" to="/onboarding">{t('onboarding.title')}</Link>
      {body}
      {canManage && <ProviderSetup />}
    </>
  );
}
