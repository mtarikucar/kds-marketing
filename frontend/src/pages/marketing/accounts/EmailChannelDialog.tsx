import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, AlertTriangle, MailCheck } from 'lucide-react';
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
import marketingApi from '../../../features/marketing/api/marketingApi';
import { CopyField } from './CopyField';

interface CreatedEmail {
  id: string;
  webhookUrl: string | null;
  inboundSecretConfigured: boolean;
  inboundAddress: string | null;
}

/**
 * Complete Email setup for the Account Center. Email is TWO-way: outbound SMTP
 * (sealed) + inbound replies parsed by the workspace's email provider POSTing to
 * our signed webhook. The old one-shot dialog only did SMTP; this makes BOTH
 * halves explicit — send config, the inbound webhook URL to paste into the ESP,
 * whether the platform inbound signing key is set, and an SMTP self-test.
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
  const [form, setForm] = useState({
    name: '',
    smtpHost: '',
    smtpPort: '587',
    smtpUser: '',
    smtpPass: '',
    fromEmail: '',
    inboundAddress: '',
  });
  const [created, setCreated] = useState<CreatedEmail | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) {
      setForm({ name: '', smtpHost: '', smtpPort: '587', smtpUser: '', smtpPass: '', fromEmail: '', inboundAddress: '' });
      setCreated(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      marketingApi
        .post('/channels', {
          type: 'EMAIL',
          name: form.name.trim(),
          externalId: form.inboundAddress.trim() || undefined,
          secrets: {
            smtpHost: form.smtpHost.trim(),
            smtpPort: form.smtpPort.trim() || '587',
            smtpUser: form.smtpUser.trim(),
            smtpPass: form.smtpPass,
            ...(form.fromEmail.trim() ? { fromEmail: form.fromEmail.trim() } : {}),
          },
        })
        .then((r) => r.data as CreatedEmail),
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
    !!form.name.trim() && !!form.smtpHost.trim() && !!form.smtpUser.trim() && !!form.smtpPass;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('accounts.email.title', 'Connect Email')}</DialogTitle>
          <DialogDescription>
            {t('accounts.email.desc', 'Email is two-way: send from your SMTP server, and receive replies via your provider’s inbound webhook.')}
          </DialogDescription>
        </DialogHeader>

        {!created ? (
          <div className="space-y-4">
            <section className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('accounts.email.sending', 'Sending (SMTP)')}</p>
              <Input placeholder={t('accounts.channelName', 'Name')} value={form.name} onChange={(e) => set('name', e.target.value)} />
              <div className="flex gap-2">
                <Input className="flex-1" placeholder={t('accounts.email.smtpHost', 'SMTP host')} value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} />
                <Input className="w-24" placeholder={t('accounts.email.smtpPort', 'Port')} value={form.smtpPort} onChange={(e) => set('smtpPort', e.target.value)} />
              </div>
              <Input placeholder={t('accounts.email.smtpUser', 'SMTP username')} value={form.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} />
              <Input type="password" placeholder={t('accounts.email.smtpPass', 'SMTP password')} value={form.smtpPass} onChange={(e) => set('smtpPass', e.target.value)} />
              <Input type="email" placeholder={t('accounts.email.fromEmail', 'From email (optional)')} value={form.fromEmail} onChange={(e) => set('fromEmail', e.target.value)} />
            </section>

            <section className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('accounts.email.receiving', 'Receiving replies')}</p>
              <Input type="email" placeholder={t('accounts.email.inboundAddress', 'Inbound address (the one your provider parses)')} value={form.inboundAddress} onChange={(e) => set('inboundAddress', e.target.value)} />
              <p className="text-caption text-muted-foreground">
                {t('accounts.email.receivingHint', 'This is the address whose inbound mail your provider (Mailgun/SendGrid/Postmark…) forwards to us. The webhook URL to paste there appears after you save.')}
              </p>
            </section>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-2 text-sm text-foreground">
              <CheckCircle2 className="h-4 w-4 text-success" /> {t('accounts.email.sendingDone', 'Sending is configured.')}
            </div>
            {created.webhookUrl && (
              <CopyField
                label={t('accounts.email.webhookLabel', 'Inbound webhook URL — paste this into your email provider’s inbound-parse route')}
                value={created.webhookUrl}
              />
            )}
            {(() => {
              const ready = created.inboundSecretConfigured && !!created.inboundAddress;
              const msg = !created.inboundSecretConfigured
                ? t('accounts.email.inboundOff', 'Inbound not active yet — an admin must set EMAIL_INBOUND_SECRET on the server.')
                : !created.inboundAddress
                  ? t('accounts.email.inboundNoAddr', 'Inbound signing key is set, but no inbound address was configured — replies can’t be matched to this channel.')
                  : t('accounts.email.inboundOn', 'Inbound signing key is configured — replies will flow.');
              return (
                <div
                  className={`flex items-center gap-2 rounded-lg border p-2 text-sm ${
                    ready ? 'border-success/30 bg-success/10 text-foreground' : 'border-warning/30 bg-warning/10 text-foreground'
                  }`}
                >
                  {ready ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
                  {msg}
                </div>
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
              <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
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
