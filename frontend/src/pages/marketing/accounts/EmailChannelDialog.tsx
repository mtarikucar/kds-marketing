import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, AlertTriangle, MailCheck, ShieldCheck } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Disclosure } from '@/components/ui/Disclosure';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { navigateExternal } from '../../../lib/navigateExternal';
import { CopyField } from './CopyField';

interface CreatedEmail {
  id: string;
  webhookUrl: string | null;
  inboundSecretConfigured: boolean;
  inboundAddress: string | null;
}

interface OAuthProvider {
  provider: 'GOOGLE' | 'MICROSOFT';
  label: string;
}

/**
 * A mailbox that already exists, handed in to edit it rather than replace it.
 *
 * The whole reason this prop exists: `ChannelsService.remove` hard-deletes, so
 * "delete and reconnect" — the only way to change a password before this —
 * orphaned every conversation and contact identity hanging off the channel.
 * Old threads 404 and the customer's next reply opens a duplicate. Editing
 * keeps the row, so nothing is orphaned.
 */
export interface EditableMailbox {
  id: string;
  /** What this mailbox answers to (or the address it has claimed). LOCKED in
   *  the form: `externalId` is the inbound routing key and `fromEmail` is the
   *  outbound identity, so changing one here would leave the mailbox sending
   *  from one address and receiving at another. */
  address: string | null;
  /** Connected by provider consent rather than by password. */
  consent?: boolean;
  /** The grant itself is dead — the repair is one click at the provider, not
   *  five fields. */
  reauthRequired?: boolean;
  /** Which credential keys the channel already holds (names only, never
   *  values), so a blank field does not read as a missing setting. */
  configuredSecrets?: string[];
}

/**
 * The consent keys a password must displace.
 *
 * `EmailChannelAdapter` checks `oauthProvider` FIRST and never looks at the
 * SMTP block again (`email.adapter.ts` `oauth()`), so a password patched onto
 * a channel that still carries stale `oauth*` keys is silently ignored — the
 * save succeeds, nothing changes, and Edit looks broken. This is the exact
 * mirror of `SMTP_KEYS` in `email-oauth.service.ts`, which has no counterpart
 * on the backend today.
 */
export const OAUTH_KEYS = [
  'oauthProvider',
  'oauthAccessToken',
  'oauthRefreshToken',
  'oauthExpiresAt',
] as const;

interface SmtpSuggestion {
  host: string;
  port: number;
  secure: boolean;
  provider: string;
  oauth?: 'GOOGLE' | 'MICROSOFT';
  /** The INCOMING server for the same provider, where one exists — the backend
   *  has always sent it and this type used to drop it on the floor. Absent for
   *  a provider the MX table doesn't know and for pure outbound relays, which
   *  is exactly when the person has to supply it themselves. */
  imap?: { host: string; port: number };
}

const EMPTY_FORM = {
  address: '',
  password: '',
  smtpHost: '',
  smtpPort: '587',
  smtpSecure: false,
  smtpUser: '',
  // Blank rather than 993: an empty override leaves autodiscovery in charge,
  // which is the right answer for every provider the MX table already knows.
  imapHost: '',
  imapPort: '',
  // Off means "decide from the port" (993/994 are IMAPS). On is for the hosts
  // that serve IMAPS somewhere else, which no port rule can guess.
  imapSecure: false,
};

/**
 * Connecting the workspace's mailbox — and, with `channel`, editing the one it
 * already has.
 *
 * Consent comes first and a password is the fallback, because for most people
 * the mailbox is Gmail or Microsoft and typing that password into someone
 * else's form is the wrong habit to teach. The custom-SMTP path stays for
 * everyone else — a self-hosted server, a small host, an address the platform
 * has no app registration for.
 *
 * The SMTP half asks for an address and a password rather than five fields:
 * host, port and security are properties of the DOMAIN, so they are read from
 * its MX record. They stay visible and editable underneath, because the
 * autodiscovery table cannot know every host and a wrong guess must be
 * correctable rather than hidden.
 *
 * ## Edit mode
 *
 * Blank means UNCHANGED, never "erase this": `ChannelsService.update` merges
 * partial secrets, so only the fields somebody actually typed into are sent.
 * That is what lets an owner rotate a password without re-typing a host they
 * chose months ago — and what stops a half-filled form from sealing an empty
 * string that reads as a configured credential.
 */
export function EmailChannelDialog({
  open,
  onOpenChange,
  onCreated,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  channel?: EditableMailbox | null;
}) {
  const { t } = useTranslation('marketing');
  const editing = !!channel;
  /** Edit mode starts empty apart from the locked address — including the
   *  port, because `587` as a starting value would be PATCHed over whatever
   *  the mailbox actually uses. */
  const initialForm = () =>
    channel
      ? { ...EMPTY_FORM, address: channel.address ?? '', smtpPort: '' }
      : EMPTY_FORM;
  const [form, setForm] = useState(initialForm);
  const [suggestion, setSuggestion] = useState<SmtpSuggestion | null>(null);
  const [suggestedFor, setSuggestedFor] = useState('');
  const [created, setCreated] = useState<CreatedEmail | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) {
      setForm(initialForm());
      setSuggestion(null);
      setSuggestedFor('');
      setCreated(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel?.id]);

  const providers = useQuery({
    queryKey: ['email-oauth-providers'],
    queryFn: () =>
      marketingApi
        .get('/channels/email/oauth/providers')
        .then((r) => (r.data?.providers ?? []) as OAuthProvider[]),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const oauthProviders = providers.data ?? [];

  const startOAuth = useMutation({
    mutationFn: (provider: string) =>
      marketingApi.post('/channels/email/oauth/start', { provider }).then((r) => r.data),
    onSuccess: (res: any) => {
      // Leaves the app for the provider's consent screen and comes back to
      // /accounts, so there is no success state to render here. Through the
      // shared helper, which refuses anything that is not http(s).
      if (!navigateExternal(res?.authorizeUrl)) {
        toast.error(t('accounts.channelFailed', 'Could not connect the channel'));
      }
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || t('accounts.channelFailed', 'Could not connect the channel')),
  });

  /** Read the domain's mail host once the address looks complete. */
  const suggest = useMutation({
    mutationFn: (address: string) =>
      marketingApi
        .post('/channels/email/oauth/smtp-suggest', { address })
        .then((r) => (r.data?.smtp ?? null) as SmtpSuggestion | null),
    onSuccess: (smtp, address) => {
      setSuggestion(smtp);
      setSuggestedFor(address);
      if (!smtp) return;
      // Only fills what the person has not typed over: someone who has already
      // corrected the host knows something the MX table does not.
      setForm((f) => ({
        ...f,
        smtpHost: f.smtpHost || smtp.host,
        smtpPort: f.smtpPort === '587' ? String(smtp.port) : f.smtpPort,
        smtpSecure: f.smtpHost ? f.smtpSecure : smtp.secure,
        smtpUser: f.smtpUser || address,
        // Same rule as the host above: a value the person typed themselves wins
        // over the table's. Left blank when the provider has no known IMAP.
        imapHost: f.imapHost || smtp.imap?.host || '',
        imapPort: f.imapPort || (smtp.imap ? String(smtp.imap.port) : ''),
      }));
    },
  });

  const onAddressSettled = () => {
    // Never in edit mode: the address is locked, and refilling the server
    // fields from the MX table would PATCH a guess over a host the owner
    // deliberately typed.
    if (editing) return;
    const address = form.address.trim().toLowerCase();
    if (!address.includes('@') || address === suggestedFor) return;
    suggest.mutate(address);
  };

  const create = useMutation({
    mutationFn: () => {
      const address = form.address.trim().toLowerCase();
      return marketingApi
        .post('/channels', {
          type: 'EMAIL',
          name: address,
          externalId: address,
          secrets: {
            smtpHost: form.smtpHost.trim(),
            smtpPort: form.smtpPort.trim() || '587',
            smtpSecure: String(form.smtpSecure),
            smtpUser: form.smtpUser.trim() || address,
            smtpPass: form.password,
            fromEmail: address,
            // Only when actually filled in: an empty string would sit in the
            // sealed secrets looking like a configured override, and the
            // poller's `imapHost?.trim()` would read it as one.
            ...(form.imapHost.trim() ? { imapHost: form.imapHost.trim() } : {}),
            ...(form.imapPort.trim() ? { imapPort: form.imapPort.trim() } : {}),
            ...(form.imapSecure ? { imapSecure: 'true' } : {}),
          },
        })
        .then((r) => r.data as CreatedEmail);
    },
    onSuccess: (ch) => {
      setCreated(ch);
      onCreated();
      toast.success(t('accounts.email.sendingSaved', 'Sending set up — now finish receiving'));
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || t('accounts.channelFailed', 'Could not connect the channel')),
  });

  /** Only what was typed. Blank is "leave it alone", because the backend
   *  merges — see the class docstring. */
  const editedSecrets = (): Record<string, string> => {
    const secrets: Record<string, string> = {};
    const put = (key: string, raw: string) => {
      const value = raw.trim();
      if (value) secrets[key] = value;
    };
    // Not trimmed: a password may legitimately begin or end with a space.
    if (form.password) secrets.smtpPass = form.password;
    put('smtpHost', form.smtpHost);
    put('smtpPort', form.smtpPort);
    put('smtpUser', form.smtpUser);
    put('imapHost', form.imapHost);
    put('imapPort', form.imapPort);
    // Only alongside a port, for the same reason as smtpSecure below: a stored
    // `true` from one host must not follow the mailbox to another.
    if (secrets.imapPort) secrets.imapSecure = String(form.imapSecure);
    // Written WITH the port and only then, because a stored `smtpSecure: true`
    // left behind by a 465 mailbox would break the same mailbox moved to 587.
    // The adapter also implies TLS from 465, so this only ever agrees with it.
    if (secrets.smtpPort) secrets.smtpSecure = String(secrets.smtpPort === '465');
    return secrets;
  };

  const save = useMutation({
    mutationFn: async () => {
      const secrets = editedSecrets();
      await marketingApi.patch(`/channels/${channel!.id}`, {
        secrets,
        // ONLY when a password is actually being set. Clearing a live grant
        // because somebody corrected where replies are read from would take
        // the mailbox's ability to send away with it.
        ...(secrets.smtpPass ? { clearSecretKeys: [...OAUTH_KEYS] } : {}),
      });
      // The credential rewrite re-proves the mailbox server-side already; this
      // is the answer the person standing at the dialog is waiting for.
      return marketingApi.post(`/channels/${channel!.id}/verify`).then((r) => r.data);
    },
    onSuccess: (res: any) => {
      onCreated();
      if (res?.ok === false) {
        toast.error(res?.message || t('accounts.email.smtpFailed', 'SMTP check failed'));
        return;
      }
      toast.success(t('accounts.email.editSaved', 'Mailbox updated'));
      onOpenChange(false);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || t('accounts.email.editFailed', 'Could not update the mailbox')),
  });

  const verify = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/channels/${id}/verify`).then((r) => r.data),
    onSuccess: (res: any) =>
      res?.ok === false
        ? toast.error(res?.message || t('accounts.email.smtpFailed', 'SMTP check failed'))
        : toast.success(t('accounts.email.smtpOk', 'SMTP verified')),
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || t('accounts.email.smtpFailed', 'SMTP check failed')),
  });

  const canCreate =
    form.address.trim().includes('@') && !!form.password && !!form.smtpHost.trim();
  /** An edit that changes nothing must not be submittable: it would re-run a
   *  health check and report a result nobody asked for. */
  const canSave = Object.keys(editedSecrets()).length > 0;

  /** This address is run by a provider we can connect WITHOUT a password. */
  const passwordlessOffer = suggestion?.oauth
    ? oauthProviders.find((p) => p.provider === suggestion.oauth)
    : undefined;

  /** Consent is offered on a NEW mailbox, and on an existing one only when
   *  consent is what it runs on — an SMTP mailbox is edited, not re-granted. */
  const showConsent = oauthProviders.length > 0 && (!editing || !!channel?.consent);
  /** Folded away only when the repair is the consent button above it. */
  const serverFieldsOpen = editing ? !channel?.reauthRequired : oauthProviders.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('accounts.email.edit', 'Edit mailbox')
              : t('accounts.email.title', 'Connect Email')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'accounts.email.desc',
              'Email is two-way: send from your mailbox, and receive replies via your provider’s inbound webhook.',
            )}
          </DialogDescription>
        </DialogHeader>

        {!created ? (
          <div className="space-y-4">
            {/* The grant is dead, not the password — say so before the form,
                so nobody starts typing credentials that cannot help. */}
            {editing && channel?.reauthRequired && (
              <Callout tone="warning" icon={<AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />}>
                <div className="space-y-1">
                  <p>
                    {t(
                      'accounts.email.reauthRequired',
                      'Connection needs renewing — the provider consent expired, so this mailbox can neither send nor receive.',
                    )}
                  </p>
                  <p className="text-caption text-muted-foreground">
                    {t('accounts.email.reauthRequiredHint', 'Only the mailbox owner can reconnect it.')}
                  </p>
                </div>
              </Callout>
            )}

            {showConsent && (
              <section className="space-y-3">
                <p className="text-sm font-medium text-foreground">
                  {t('accounts.email.consentTitle', 'Connect your mailbox')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'accounts.email.consentDesc',
                    'You sign in at your provider and approve sending. No password is stored here.',
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  {oauthProviders.map((p) => (
                    <Button
                      key={p.provider}
                      variant="outline"
                      onClick={() => startOAuth.mutate(p.provider)}
                      loading={startOAuth.isPending && startOAuth.variables === p.provider}
                      disabled={startOAuth.isPending}
                    >
                      <ShieldCheck className="h-4 w-4" />
                      {t('accounts.email.connectWith', 'Connect with {{provider}}', { provider: p.label })}
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {/* Held back until the providers query settles. `defaultOpen` seeds
                state on FIRST render only, and on that render the query has no
                data — so rendering early would open this section every time and
                bury the consent buttons it is supposed to sit under. Edit mode
                does not wait: its fold state is decided by the channel, not by
                the provider list. */}
            {(providers.isFetched || editing) && (
            <Disclosure
              title={
                editing
                  ? t('accounts.email.sending', 'Sending (SMTP)')
                  : t('accounts.email.ownServer', 'I have my own mail server')
              }
              defaultOpen={serverFieldsOpen}
            >
              <div className="space-y-3 pt-1">
                <Field
                  label={t('accounts.email.address', 'Email address')}
                  hint={t(
                    'accounts.email.addressHint',
                    'Replies to this address come back into the inbox. The server settings are read from its domain.',
                  )}
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      type="email"
                      aria-describedby={describedBy}
                      value={form.address}
                      // The inbound routing key. Editable here, it would be
                      // changed WITHOUT the `fromEmail` beside it and the
                      // mailbox would send from one address and receive at
                      // another.
                      disabled={editing}
                      onChange={(e) => set('address', e.target.value)}
                      onBlur={onAddressSettled}
                    />
                  )}
                </Field>

                {/* What the mailbox already holds, so an empty field reads as
                    "already set" rather than "missing". Key names only — the
                    values never leave the server. */}
                {editing && (channel?.configuredSecrets?.length ?? 0) > 0 && (
                  <p className="text-caption text-muted-foreground">
                    {`${t('channels.secretsSet', 'credentials set')}: ${channel!.configuredSecrets!.join(', ')}`}
                  </p>
                )}

                {passwordlessOffer && (
                  <Callout tone="info" icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}>
                    <div className="space-y-2">
                      <p>
                        {t(
                          'accounts.email.passwordlessAvailable',
                          'This address is run by {{provider}} — you can connect it without a password.',
                          { provider: passwordlessOffer.label },
                        )}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => startOAuth.mutate(passwordlessOffer.provider)}
                        loading={startOAuth.isPending}
                      >
                        {t('accounts.email.connectWith', 'Connect with {{provider}}', {
                          provider: passwordlessOffer.label,
                        })}
                      </Button>
                    </div>
                  </Callout>
                )}

                <Field label={t('accounts.email.mailboxPassword', 'Mailbox password')}>
                  {({ id }) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(e) => set('password', e.target.value)}
                    />
                  )}
                </Field>

                {suggestion && (
                  <p className="text-xs text-muted-foreground">
                    {t('accounts.email.recognised', 'Recognised {{provider}} — server settings filled in below.', {
                      provider: suggestion.provider,
                    })}
                  </p>
                )}
                {!suggestion && suggestedFor && (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'accounts.email.notRecognised',
                      'We don’t recognise this domain’s mail host — please fill the server settings in yourself.',
                    )}
                  </p>
                )}

                <div className="flex gap-2">
                  <Field label={t('accounts.email.smtpHost', 'SMTP host')} className="flex-1">
                    {({ id }) => (
                      <Input id={id} value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} />
                    )}
                  </Field>
                  <Field label={t('accounts.email.smtpPort', 'Port')} className="w-24">
                    {({ id }) => (
                      <Input id={id} value={form.smtpPort} onChange={(e) => set('smtpPort', e.target.value)} />
                    )}
                  </Field>
                </div>
                <Field
                  label={t('accounts.email.smtpUser', 'SMTP username')}
                  hint={t('accounts.email.smtpUserHint', 'Usually the same as the address.')}
                >
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={form.smtpUser}
                      placeholder={form.address.trim().toLowerCase()}
                      onChange={(e) => set('smtpUser', e.target.value)}
                    />
                  )}
                </Field>

                {/* Incoming mail. Filled in for a provider we recognise; for one
                    we don't, this is the only place to say where replies live —
                    without it the poller has no host and skips the mailbox, so
                    it would send and never receive. */}
                <div className="flex gap-2">
                  <Field
                    label={t('accounts.email.imapHost', 'IMAP host')}
                    hint={t(
                      'accounts.email.imapHint',
                      'Where replies are read from. Leave blank to use the settings we recognise for this provider.',
                    )}
                    className="flex-1"
                  >
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        value={form.imapHost}
                        onChange={(e) => set('imapHost', e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t('accounts.email.imapPort', 'IMAP port')} className="w-28">
                    {({ id }) => (
                      <Input
                        id={id}
                        value={form.imapPort}
                        placeholder="993"
                        onChange={(e) => set('imapPort', e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.imapSecure}
                    onChange={(e) => set('imapSecure', e.target.checked)}
                  />
                  {t('accounts.email.imapSecure', 'This port uses SSL/TLS directly')}
                </label>
              </div>
            </Disclosure>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <Callout tone="success" icon={<CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />}>
              {t('accounts.email.sendingDone', 'Sending is configured.')}
            </Callout>
            {created.webhookUrl && (
              <CopyField
                label={t(
                  'accounts.email.webhookLabel',
                  'Inbound webhook URL — paste this into your email provider’s inbound-parse route',
                )}
                value={created.webhookUrl}
              />
            )}
            {(() => {
              const ready = created.inboundSecretConfigured && !!created.inboundAddress;
              const msg = !created.inboundSecretConfigured
                ? t(
                    'accounts.email.inboundOff',
                    'Inbound not active yet — an admin must set EMAIL_INBOUND_SECRET on the server.',
                  )
                : !created.inboundAddress
                  ? t(
                      'accounts.email.inboundNoAddr',
                      'Inbound signing key is set, but no inbound address was configured — replies can’t be matched to this channel.',
                    )
                  : t('accounts.email.inboundOn', 'Inbound signing key is configured — replies will flow.');
              return (
                <Callout
                  tone={ready ? 'success' : 'warning'}
                  icon={
                    ready ? (
                      <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
                    )
                  }
                >
                  {msg}
                </Callout>
              );
            })()}
            <Button variant="outline" size="sm" onClick={() => verify.mutate(created.id)} loading={verify.isPending}>
              <MailCheck className="h-4 w-4" /> {t('accounts.email.testSmtp', 'Test SMTP connection')}
            </Button>
          </div>
        )}

        <DialogFooter>
          {created ? (
            <Button onClick={() => onOpenChange(false)}>{t('common.done', 'Done')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              {editing ? (
                <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!canSave}>
                  {t('common.save', 'Save')}
                </Button>
              ) : (
                <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!canCreate}>
                  {t('accounts.connect', 'Connect')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
