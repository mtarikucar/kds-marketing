import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { NETWORK_META } from './networks';
import { SOCIAL_NETWORKS, type SocialNetwork } from './socialSchemas';
import type { NetworkStatus } from './types';
import { useSocialConnect } from './useSocialConnect';

interface Props {
  status?: NetworkStatus;
}

/**
 * Networks with a wired OAuth connect flow (mirrors the backend OAUTH_NETWORKS).
 * All seven now have a per-network OAuth exchange (X uses OAuth2 + PKCE,
 * Pinterest Basic-auth token exchange, GMB Google OAuth) — one-click connect is
 * enabled for each once its platform-app env creds are present (per the status
 * endpoint); the manual token dialog remains as a fallback.
 */
const OAUTH_CAPABLE = new Set<SocialNetwork>([
  'FACEBOOK',
  'INSTAGRAM',
  'LINKEDIN',
  'TIKTOK',
  'TWITTER',
  'PINTEREST',
  'GMB',
]);

/**
 * One "Connect <Network>" button per network. A network is clickable only when
 * its platform app is configured (env creds present, per the status endpoint)
 * AND its OAuth flow is wired; otherwise the button is DISABLED with a hint, so
 * the one-click path is always discoverable and it's obvious why it's not yet
 * active. The manual "Connect account" dialog remains as the fallback.
 */
export function OAuthConnectButtons({ status }: Props) {
  const { t } = useTranslation('marketing');
  const { startConnect } = useSocialConnect();

  if (!status) return null;
  const anyConnectable = SOCIAL_NETWORKS.some((n) => status[n] && OAUTH_CAPABLE.has(n));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {SOCIAL_NETWORKS.map((network: SocialNetwork) => {
          const meta = NETWORK_META[network];
          const Icon = meta.icon;
          const oauthWired = OAUTH_CAPABLE.has(network);
          const connectable = !!status[network] && oauthWired;
          return (
            <Button
              key={network}
              variant="outline"
              size="sm"
              disabled={!connectable}
              title={
                connectable
                  ? undefined
                  : oauthWired
                    ? t('social.oauth.notConfigured', {
                        defaultValue: 'An admin must add this network’s app credentials first',
                      })
                    : t('social.oauth.comingSoon', {
                        defaultValue: 'One-click connect for this network is coming soon',
                      })
              }
              onClick={() => connectable && startConnect(network)}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t('social.oauth.connect', { defaultValue: 'Connect' })} {meta.label}
            </Button>
          );
        })}
      </div>
      {!anyConnectable && (
        <p className="text-micro text-muted-foreground">
          {t('social.oauth.setupHint', {
            defaultValue:
              'One-click connect activates once an admin adds each network’s app credentials. Until then, use “Connect account” below to add a token manually.',
          })}
        </p>
      )}
    </div>
  );
}
