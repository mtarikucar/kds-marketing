import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link2 } from 'lucide-react';
import {
  getTiktokAdsPending,
  confirmTiktokAdsPending,
} from '../../../features/marketing/api/ads.service';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Switch } from '@/components/ui/Switch';
import { Label } from '@/components/ui/Label';
import { EmptyState } from '@/components/ui/EmptyState';

interface Props {
  pendingId: string | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

/**
 * After the TikTok Business OAuth callback redirects to /ads?connect=<id>,
 * this dialog lists the advertiser accounts the user can connect and optionally
 * enables TikTok DM inbox integration.
 */
export function TiktokAdsSelectDialog({ pendingId, onOpenChange, onSuccess }: Props) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [enableMessaging, setEnableMessaging] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['marketing', 'ads', 'tiktok', 'pending', pendingId],
    queryFn: () => getTiktokAdsPending(pendingId!),
    enabled: !!pendingId,
    retry: false,
  });

  // Default to all advertisers selected once they load.
  useEffect(() => {
    if (data?.advertisers) {
      setSelected(data.advertisers.map((a) => a.externalAdId));
    }
  }, [data]);

  const confirmMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: { selected: string[]; enableMessaging?: boolean };
    }) => confirmTiktokAdsPending(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'ads', 'accounts'] });
      toast.success(
        t('ads.toast.tiktokConnected', { defaultValue: 'TikTok advertiser(s) connected' }),
      );
      onSuccess();
      onOpenChange(false);
    },
    onError: () => {
      toast.error(
        t('ads.toast.tiktokConnectFailed', {
          defaultValue: 'Failed to connect TikTok account',
        }),
      );
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleConfirm = () => {
    if (!pendingId || selected.length === 0) return;
    confirmMutation.mutate({
      id: pendingId,
      payload: {
        selected,
        enableMessaging: data?.messaging ? enableMessaging : undefined,
      },
    });
  };

  return (
    <Dialog open={!!pendingId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('ads.oauth.selectTitle', {
              defaultValue: 'Choose TikTok advertiser accounts',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('ads.oauth.selectBody', {
              defaultValue: 'Select the advertiser accounts to connect to this workspace.',
            })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : isError || !data || data.advertisers.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title={t('ads.oauth.noAdvertisers', { defaultValue: 'No advertiser accounts found' })}
            description={t('ads.oauth.noAdvertisersHint', {
              defaultValue:
                'Make sure you granted access to at least one TikTok advertiser account.',
            })}
            className="border-0 py-4"
          />
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto py-1">
            {data.advertisers.map((a) => (
              <label
                key={a.externalAdId}
                htmlFor={`advertiser-${a.externalAdId}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 hover:bg-surface-muted"
              >
                <Checkbox
                  id={`advertiser-${a.externalAdId}`}
                  checked={selected.includes(a.externalAdId)}
                  onCheckedChange={() => toggle(a.externalAdId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {a.displayName}
                  </span>
                  <span className="block text-micro text-muted-foreground">{a.currency}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {data?.messaging && (
          <div className="flex items-center gap-3 rounded-lg border border-border p-3">
            <Switch
              id="enable-dm"
              checked={enableMessaging}
              onCheckedChange={setEnableMessaging}
            />
            <Label htmlFor="enable-dm" className="cursor-pointer text-sm">
              {t('ads.oauth.enableDm', { defaultValue: 'Also enable TikTok DM inbox' })}
            </Label>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            loading={confirmMutation.isPending}
            disabled={!data || selected.length === 0}
          >
            {t('ads.oauth.connectSelected', { defaultValue: 'Connect selected' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
