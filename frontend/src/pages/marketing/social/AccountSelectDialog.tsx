import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { Label } from '@/components/ui/Label';
import { EmptyState } from '@/components/ui/EmptyState';
import { Link2 } from 'lucide-react';
import { useSocialConnect } from './useSocialConnect';

interface Props {
  pendingId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * After the OAuth callback redirects to /social?connect=<id>, this lists the
 * provider assets the user can connect (pages, IG accounts, LinkedIn org/profile)
 * and turns the chosen ones into SocialAccounts.
 */
export function AccountSelectDialog({ pendingId, onOpenChange }: Props) {
  const { t } = useTranslation('marketing');
  const { usePending, confirm } = useSocialConnect();
  const { data, isLoading, isError } = usePending(pendingId);
  const [selected, setSelected] = useState<string[]>([]);
  // externalIds of Pages/IG accounts the user also wants as a messaging Channel.
  const [messaging, setMessaging] = useState<string[]>([]);

  // Default to all assets selected once they load (messaging stays opt-in/off).
  useEffect(() => {
    if (data?.assets) setSelected(data.assets.map((a) => a.externalId));
  }, [data]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const toggleMessaging = (id: string) =>
    setMessaging((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleConfirm = () => {
    if (!pendingId || selected.length === 0) return;
    confirm.mutate(
      { pendingId, selected, provisionMessaging: messaging.filter((id) => selected.includes(id)) },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={!!pendingId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('social.oauth.selectTitle', { defaultValue: 'Choose accounts to connect' })}
          </DialogTitle>
          <DialogDescription>
            {t('social.oauth.selectBody', {
              defaultValue: 'Pick the pages/accounts the planner may publish to.',
            })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : isError || !data || data.assets.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title={t('social.oauth.noAssets', { defaultValue: 'No connectable accounts found' })}
            description={t('social.oauth.noAssetsHint', {
              defaultValue: 'Make sure you granted access to at least one page or account.',
            })}
            className="border-0 py-4"
          />
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto py-1">
            {data.assets.map((a) => {
              const isMeta = a.accountType === 'PAGE' || a.accountType === 'IG_BUSINESS';
              const isSelected = selected.includes(a.externalId);
              return (
                <div key={a.externalId} className="rounded-lg border border-border">
                  <label
                    htmlFor={`asset-${a.externalId}`}
                    className="flex cursor-pointer items-center gap-3 p-3 hover:bg-surface-muted"
                  >
                    <Checkbox
                      id={`asset-${a.externalId}`}
                      checked={isSelected}
                      onCheckedChange={() => toggle(a.externalId)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {a.displayName}
                      </span>
                      <span className="block text-micro text-muted-foreground">{a.accountType}</span>
                    </span>
                  </label>
                  {/* Pages/IG can ALSO become a two-way messaging inbox channel —
                      opt-in (off by default) so we don't surprise the operator
                      with inbox/quota usage. WhatsApp numbers are messaging-only. */}
                  {isMeta && isSelected && (
                    <label
                      htmlFor={`msg-${a.externalId}`}
                      className="flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-micro text-muted-foreground hover:bg-surface-muted"
                    >
                      <Checkbox
                        id={`msg-${a.externalId}`}
                        aria-label={`messaging:${a.externalId}`}
                        checked={messaging.includes(a.externalId)}
                        onCheckedChange={() => toggleMessaging(a.externalId)}
                      />
                      {t('social.oauth.alsoMessaging', {
                        defaultValue: 'Also enable the messaging inbox for this account',
                      })}
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            loading={confirm.isPending}
            disabled={!data || selected.length === 0}
          >
            {t('social.oauth.connectSelected', { defaultValue: 'Connect selected' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
