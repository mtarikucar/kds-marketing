import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { navigateExternal } from '../../../lib/navigateExternal';
import type { SocialNetwork } from './socialSchemas';

export interface PendingAsset {
  externalId: string;
  displayName: string;
  accountType: string;
}

export interface PendingConnection {
  network: SocialNetwork;
  assets: PendingAsset[];
}

/**
 * Drives the one-click OAuth connect flow: kick off `start` (full-page
 * redirect to the provider), read back the pending assets after the callback
 * returns to `/social?connect=<id>`, and confirm the user's selection.
 */
export function useSocialConnect() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  /** POST start → redirect the browser to the provider's consent screen. The
   *  `origin` tells the callback which page to land back on ('channels' when the
   *  connect was launched from the inbox/channels page). */
  const startConnect = async (
    network: SocialNetwork,
    opts?: { origin?: 'social' | 'channels' },
  ) => {
    try {
      const url = `/social/oauth/${network.toLowerCase()}/start`;
      // Only send a body when there's an origin, so existing (no-origin) callers
      // keep their exact 1-arg POST signature.
      const { data } = opts?.origin
        ? await marketingApi.post(url, { origin: opts.origin })
        : await marketingApi.post(url);
      navigateExternal(data?.authorizeUrl as string | undefined);
    } catch {
      toast.error(
        t('social.oauth.startFailed', { defaultValue: 'Could not start the connection' }),
      );
    }
  };

  const usePending = (pendingId: string | null) =>
    useQuery({
      queryKey: ['marketing', 'social', 'pending', pendingId],
      queryFn: () =>
        marketingApi
          .get(`/social/oauth/pending/${pendingId}`)
          .then((r) => r.data as PendingConnection),
      enabled: !!pendingId,
      retry: false,
    });

  const confirm = useMutation({
    mutationFn: ({
      pendingId,
      selected,
      provisionMessaging,
    }: {
      pendingId: string;
      selected: string[];
      /** externalIds of Pages/IG accounts to ALSO wire up as a messaging Channel. */
      provisionMessaging?: string[];
    }) =>
      marketingApi.post(`/social/oauth/pending/${pendingId}/confirm`, {
        selected,
        ...(provisionMessaging && provisionMessaging.length ? { provisionMessaging } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'social', 'accounts'] });
      toast.success(t('social.toast.connected', { defaultValue: 'Account connected' }));
    },
    onError: () => {
      toast.error(t('social.toast.connectFailed', { defaultValue: 'Failed to connect account' }));
    },
  });

  return { startConnect, usePending, confirm };
}
