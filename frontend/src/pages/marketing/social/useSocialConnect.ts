import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import marketingApi from '../../../features/marketing/api/marketingApi';
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

  /** POST start → redirect the browser to the provider's consent screen. */
  const startConnect = async (network: SocialNetwork) => {
    try {
      const { data } = await marketingApi.post(
        `/social/oauth/${network.toLowerCase()}/start`,
      );
      if (data?.authorizeUrl) {
        window.location.href = data.authorizeUrl as string;
      }
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
