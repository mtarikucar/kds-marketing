import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link2 } from 'lucide-react';
import {
  getGoogleAdsPending,
  confirmGoogleAdsPending,
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
import { EmptyState } from '@/components/ui/EmptyState';

interface Props {
  pendingId: string | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

/**
 * After the Google Ads OAuth callback redirects to /ads?connect=<id>, this
 * dialog lists the accessible customer accounts the user can connect. Mirrors
 * {@link LinkedinAdsSelectDialog}.
 */
export function GoogleAdsSelectDialog({ pendingId, onOpenChange, onSuccess }: Props) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['marketing', 'ads', 'google', 'pending', pendingId],
    queryFn: () => getGoogleAdsPending(pendingId!),
    enabled: !!pendingId,
    retry: false,
  });

  useEffect(() => {
    if (data?.accounts) {
      setSelected(data.accounts.map((a) => a.externalAdId));
    }
  }, [data]);

  const confirmMutation = useMutation({
    mutationFn: ({ id, sel }: { id: string; sel: string[] }) => confirmGoogleAdsPending(id, sel),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'ads', 'accounts'] });
      toast.success(
        t('ads.toast.googleConnected', { defaultValue: 'Google Ads account(s) connected' }),
      );
      onSuccess();
      onOpenChange(false);
    },
    onError: () => {
      toast.error(
        t('ads.toast.googleConnectFailed', { defaultValue: 'Failed to connect Google Ads account' }),
      );
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleConfirm = () => {
    if (!pendingId || selected.length === 0) return;
    confirmMutation.mutate({ id: pendingId, sel: selected });
  };

  return (
    <Dialog open={!!pendingId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('ads.oauth.googleSelectTitle', {
              defaultValue: 'Choose Google Ads accounts',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('ads.oauth.googleSelectBody', {
              defaultValue: 'Select the customer accounts to connect to this workspace.',
            })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : isError || !data || data.accounts.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title={t('ads.oauth.noGoogleAccounts', { defaultValue: 'No ad accounts found' })}
            description={t('ads.oauth.noGoogleAccountsHint', {
              defaultValue: 'Make sure you have access to at least one Google Ads customer account.',
            })}
            className="border-0 py-4"
          />
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto py-1">
            {data.accounts.map((a) => (
              <label
                key={a.externalAdId}
                htmlFor={`ga-account-${a.externalAdId}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 hover:bg-surface-muted"
              >
                <Checkbox
                  id={`ga-account-${a.externalAdId}`}
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
