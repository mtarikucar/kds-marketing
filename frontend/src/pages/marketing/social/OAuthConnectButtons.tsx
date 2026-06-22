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
 * The Epic-12 publish adapters (TWITTER/PINTEREST/GMB) are publish-configured via
 * env but their per-network OAuth exchange classes are a deferred follow-up, so
 * one-click connect stays disabled for them even when their publish env is set —
 * otherwise the button would dead-end on an unsupported-network backend error.
 */
const OAUTH_CAPABLE = new Set<SocialNetwork>(['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK']);

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
