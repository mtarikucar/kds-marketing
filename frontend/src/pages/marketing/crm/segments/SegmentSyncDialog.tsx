import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Megaphone } from 'lucide-react';
import { listAdAccounts, type AdAccount } from '../../../../features/marketing/api/ads.service';
import { useSyncSegmentAudience } from '../hooks';
import type { Segment } from '../types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

interface Props {
  segment: Segment | null;
  onOpenChange: (open: boolean) => void;
}

/** Providers with a Custom-Audience sync endpoint (Google Customer-Match not shipped). */
const SYNCABLE = new Set<AdAccount['provider']>(['META', 'TIKTOK', 'LINKEDIN']);

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

/**
 * Push a saved segment to a connected ad account as a Custom Audience
 * (POST /segments/:id/sync/:accountId). Meta additionally supports a phone
 * match and an optional Lookalike seeded from a country.
 */
export function SegmentSyncDialog({ segment, onOpenChange }: Props) {
  const { t } = useTranslation('marketing');
  const open = !!segment;

  const [accountId, setAccountId] = useState('');
  const [includePhone, setIncludePhone] = useState(true);
  const [createLookalike, setCreateLookalike] = useState(false);
  const [country, setCountry] = useState('US');

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'ads', 'accounts'],
    queryFn: listAdAccounts,
    enabled: open,
  });

  const accounts: AdAccount[] = (Array.isArray(data) ? data : []).filter((a) =>
    SYNCABLE.has(a.provider),
  );

  const selected = accounts.find((a) => a.id === accountId) ?? null;
  const isMeta = selected?.provider === 'META';

  // Default the account selection to the first syncable account once loaded.
  useEffect(() => {
    if (open) {
      setIncludePhone(true);
      setCreateLookalike(false);
      setCountry('US');
    }
  }, [open]);
  useEffect(() => {
    if (accounts.length > 0 && !accounts.some((a) => a.id === accountId)) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId]);

  const sync = useSyncSegmentAudience();

  const handleSubmit = () => {
    if (!segment || !accountId) return;
    sync.mutate(
      {
        segmentId: segment.id,
        accountId,
        opts: {
          includePhone: isMeta ? includePhone : undefined,
          createLookalike: isMeta ? createLookalike : undefined,
          country: isMeta && createLookalike ? country.trim().toUpperCase() : undefined,
        },
      },
      {
        onSuccess: (res) => {
          onOpenChange(false);
          toast.success(
            t('crm.seg.syncDone', {
              defaultValue: 'Synced {{count}} member(s) to the ad account',
              count: res.uploaded,
            }),
          );
        },
        onError: (e) =>
          toast.error(apiError(e, t('crm.seg.syncFailed', { defaultValue: 'Failed to sync audience' }))),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('crm.seg.syncTitle', { defaultValue: 'Sync to ad platform' })}</DialogTitle>
          <DialogDescription>
            {t('crm.seg.syncBody', {
              defaultValue:
                'Push this segment to a connected ad account as a Custom Audience. Only consenting members with a hashed email (and phone for Meta) are uploaded.',
            })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="h-8 w-8" />}
            title={t('crm.seg.noAdAccounts', { defaultValue: 'No connected ad accounts' })}
            description={t('crm.seg.noAdAccountsHint', {
              defaultValue: 'Connect a Meta, TikTok, or LinkedIn ad account under Ads first.',
            })}
            className="border-0 py-4"
          />
        ) : (
          <div className="space-y-4">
            <Field label={t('crm.seg.adAccount', { defaultValue: 'Ad account' })} required>
              {({ id, describedBy }) => (
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger id={id} aria-describedby={describedBy}>
                    <SelectValue placeholder={t('crm.seg.pickAccount', { defaultValue: 'Choose an account' })} />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.displayName} ({a.provider})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            {isMeta && (
              <>
                <label className="flex cursor-pointer items-center gap-3">
                  <Checkbox
                    checked={includePhone}
                    onCheckedChange={(v) => setIncludePhone(v === true)}
                  />
                  <span className="text-sm text-foreground">
                    {t('crm.seg.includePhone', { defaultValue: 'Also match on hashed phone numbers' })}
                  </span>
                </label>

                <label className="flex cursor-pointer items-center gap-3">
                  <Checkbox
                    checked={createLookalike}
                    onCheckedChange={(v) => setCreateLookalike(v === true)}
                  />
                  <span className="text-sm text-foreground">
                    {t('crm.seg.createLookalike', { defaultValue: 'Also seed a Lookalike audience' })}
                  </span>
                </label>

                {createLookalike && (
                  <Field
                    label={t('crm.seg.lookalikeCountry', { defaultValue: 'Lookalike country' })}
                    hint={t('crm.seg.lookalikeCountryHint', { defaultValue: '2-letter code (e.g. US, TR).' })}
                  >
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        maxLength={2}
                        value={country}
                        onChange={(e) => setCountry(e.target.value)}
                        className="w-24 uppercase"
                      />
                    )}
                  </Field>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sync.isPending}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            loading={sync.isPending}
            disabled={accounts.length === 0 || !accountId}
          >
            {t('crm.seg.syncSubmit', { defaultValue: 'Sync audience' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
