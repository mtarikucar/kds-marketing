import { useEffect, useMemo, useState } from 'react';
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
import { EmptyState } from '@/components/ui/EmptyState';
import { Link2 } from 'lucide-react';
import { useSocialConnect } from './useSocialConnect';

interface Props {
  pendingId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Where the connect was launched: 'channels' pre-selects only Meta assets +
   *  pre-checks their inbox; 'account-center' selects everything AND pre-checks
   *  messaging (all capabilities on). Default 'social' keeps the Planner flow. */
  context?: 'social' | 'channels' | 'account-center';
  /** Called after a successful confirm — e.g. to refetch the channels list. */
  onConnected?: () => void;
}

/**
 * After the OAuth callback redirects to /accounts?connect=<id>,
 * this lists the provider assets the user can connect (pages, IG accounts,
 * LinkedIn org/profile) and turns the chosen ones into SocialAccounts — and,
 * for Meta Page/IG assets, optionally a two-way messaging Channel.
 */
export function AccountSelectDialog({ pendingId, onOpenChange, context = 'social', onConnected }: Props) {
  const { t } = useTranslation('marketing');
  const { usePending, confirm } = useSocialConnect();
  const { data, isLoading, isError } = usePending(pendingId);
  // null means "the user has not touched this yet", so the defaults below apply.
  // Storing the override rather than the value is what removes the frame where
  // the list has rendered and nothing is selected: an effect that sets the
  // default runs AFTER that commit, so for one paint every checkbox was empty
  // and "Connect selected" — disabled while the selection is empty — was greyed
  // out on a dialog that had just finished loading. Derived during render, the
  // list is never shown in a state the user did not choose.
  const [selectedOverride, setSelected] = useState<string[] | null>(null);
  // externalIds of Pages/IG accounts the user also wants as a messaging Channel.
  const [messagingOverride, setMessaging] = useState<string[] | null>(null);

  // A different hand-off is a different question: drop anything the user picked
  // for the previous one rather than carrying it over.
  useEffect(() => {
    setSelected(null);
    setMessaging(null);
  }, [pendingId]);

  // Defaults per entry point. From Social, pre-select everything (the point is
  // publishing). From Channels, ONLY the messaging-eligible Meta assets
  // (Page/IG) with their inbox pre-checked — so we never silently connect ad
  // accounts or WhatsApp numbers the user didn't come here for; they stay
  // visible and opt-in-able.
  const defaults = useMemo(() => {
    if (!data?.assets) return { selected: [] as string[], messaging: [] as string[] };
    const all = data.assets.map((a) => a.externalId);
    const metaIds = data.assets
      .filter((a) => a.accountType === 'PAGE' || a.accountType === 'IG_BUSINESS')
      .map((a) => a.externalId);
    if (context === 'channels') return { selected: metaIds, messaging: metaIds };
    if (context === 'account-center') return { selected: all, messaging: metaIds };
    return { selected: all, messaging: [] as string[] };
  }, [data, context]);

  const selected = selectedOverride ?? defaults.selected;
  const messaging = messagingOverride ?? defaults.messaging;

  // Both toggles start from the EFFECTIVE list, not from the override: the
  // first click must edit what the user can see, not an empty array.
  const toggle = (id: string) =>
    setSelected((prev) => {
      const base = prev ?? defaults.selected;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });

  const toggleMessaging = (id: string) =>
    setMessaging((prev) => {
      const base = prev ?? defaults.messaging;
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });

  const handleConfirm = () => {
    if (!pendingId || selected.length === 0) return;
    confirm.mutate(
      { pendingId, selected, provisionMessaging: messaging.filter((id) => selected.includes(id)) },
      {
        onSuccess: () => {
          onConnected?.();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={!!pendingId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {context === 'channels'
              ? t('social.oauth.selectChannelTitle', { defaultValue: 'Connect messaging channels' })
              : context === 'account-center'
                ? t('social.oauth.selectAllTitle', { defaultValue: 'Connect accounts' })
                : t('social.oauth.selectTitle', { defaultValue: 'Choose accounts to connect' })}
          </DialogTitle>
          <DialogDescription>
            {context === 'channels'
              ? t('social.oauth.selectChannelBody', {
                  defaultValue:
                    'Pick the Facebook Pages / Instagram accounts to use as a two-way inbox. They are also added to the Social Planner.',
                })
              : context === 'account-center'
                ? t('social.oauth.selectAllBody', {
                    defaultValue:
                      'Pick which accounts to connect. Facebook Pages / Instagram are used for publishing AND (with the inbox checkbox) two-way messaging.',
                  })
                : t('social.oauth.selectBody', {
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
        ) : isError ? (
          /* A hand-off that cannot be LOADED is not a hand-off that returned
             nothing. It expired (they last 15 minutes) or belongs to another
             workspace — telling that user to check what they granted sends
             them to re-examine a permission that was never the problem, and
             omits the one action that works. */
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title={t('social.oauth.pendingUnavailable', {
              defaultValue: 'This connection attempt is no longer available',
            })}
            description={t('social.oauth.pendingUnavailableHint', {
              defaultValue:
                'Connection attempts expire after 15 minutes. Close this and start the connection again.',
            })}
            className="border-0 py-4"
          />
        ) : !data || data.assets.length === 0 ? (
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
