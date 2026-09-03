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

interface SmtpSuggestion {
  host: string;
  port: number;
  secure: boolean;
  provider: string;
  oauth?: 'GOOGLE' | 'MICROSOFT';
}

const EMPTY_FORM = {
  address: '',
  password: '',
  smtpHost: '',
  smtpPort: '587',
  smtpSecure: false,
  smtpUser: '',
};

/**
 * Connecting the workspace's mailbox.
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
 */
export function EmailChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation('marketing');
  const [form, setForm] = useState(EMPTY_FORM);
  const [suggestion, setSuggestion] = useState<SmtpSuggestion | null>(null);
  const [suggestedFor, setSuggestedFor] = useState('');
  const [created, setCreated] = useState<CreatedEmail | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_FORM);
      setSuggestion(null);
      setSuggestedFor('');
      setCreated(null);
    }
  }, [open]);

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
      }));
    },
  });

  const onAddressSettled = () => {
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

  /** This address is run by a provider we can connect WITHOUT a password. */
  const passwordlessOffer = suggestion?.oauth
    ? oauthProviders.find((p) => p.provider === suggestion.oauth)
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('accounts.email.title', 'Connect Email')}</DialogTitle>
          <DialogDescription>
            {t(
              'accounts.email.desc',
              'Email is two-way: send from your mailbox, and receive replies via your provider’s inbound webhook.',
            )}
          </DialogDescription>
        </DialogHeader>

        {!created ? (
          <div className="space-y-4">
            {oauthProviders.length > 0 && (
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
                bury the consent buttons it is supposed to sit under. */}
            {providers.isFetched && (
            <Disclosure
              title={t('accounts.email.ownServer', 'I have my own mail server')}
              defaultOpen={oauthProviders.length === 0}
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
                      onChange={(e) => set('address', e.target.value)}
                      onBlur={onAddressSettled}
                    />
                  )}
                </Field>

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
          {!created ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!canCreate}>
                {t('accounts.connect', 'Connect')}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>{t('common.done', 'Done')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
