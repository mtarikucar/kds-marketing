import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
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
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  SECRET_FIELDS,
  NEEDS_EXTERNAL_ID,
  SECRET_LABELS,
  SECRET_MASKED,
  type ChannelType,
} from '../channels/channelFields';

const TYPE_LABEL: Record<string, string> = {
  SMS: 'SMS (NetGSM)',
  EMAIL: 'Email',
  WEBCHAT: 'Web chat',
  VOICE: 'Voice',
};

/**
 * Inline manual-channel setup for the Account Center — so SMS / Email / Web chat /
 * Voice are connected right here instead of bouncing to another page. Posts the
 * same POST /channels the Channels page uses (server seals the secrets), then
 * refreshes the connections list.
 */
export function ManualChannelDialog({
  type,
  onOpenChange,
  onCreated,
}: {
  type: ChannelType | null;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation('marketing');
  const [name, setName] = useState('');
  const [externalId, setExternalId] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  // Reset the form whenever a different provider's dialog opens.
  useEffect(() => {
    setName('');
    setExternalId('');
    setSecrets({});
  }, [type]);

  const create = useMutation({
    mutationFn: () =>
      marketingApi.post('/channels', {
        type,
        name: name.trim(),
        externalId: externalId.trim() || undefined,
        secrets: Object.keys(secrets).length ? secrets : undefined,
      }),
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
      toast.success(t('accounts.channelCreated', 'Channel connected'));
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || t('accounts.channelFailed', 'Could not connect the channel')),
  });

  if (!type) return null;
  const secretKeys = SECRET_FIELDS[type] ?? [];
  const extLabel = NEEDS_EXTERNAL_ID[type];
  const canSubmit =
    !!name.trim() &&
    secretKeys.every((k) => (secrets[k] ?? '').trim()) &&
    (!extLabel || !!externalId.trim());

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('accounts.setUpChannel', {
              type: TYPE_LABEL[type] ?? type,
              defaultValue: 'Connect {{type}}',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('accounts.setUpChannelDesc', 'Enter the details below — this connects the channel to your inbox.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label={t('accounts.channelName', 'Name')} required>
            {({ id }) => (
              <Input
                id={id}
                placeholder={t('accounts.channelName', 'Name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          {extLabel && (
            <Field label={extLabel} required>
              {({ id }) => (
                <Input
                  id={id}
                  placeholder={extLabel}
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                />
              )}
            </Field>
          )}
          {secretKeys.map((k) => {
            const label = SECRET_LABELS[k] ?? k;
            return (
              <Field key={k} label={label} required>
                {({ id }) => (
                  <Input
                    id={id}
                    type={SECRET_MASKED.has(k) ? 'password' : 'text'}
                    placeholder={label}
                    value={secrets[k] ?? ''}
                    onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))}
                  />
                )}
              </Field>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!canSubmit}>
            {t('accounts.connect', 'Connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
