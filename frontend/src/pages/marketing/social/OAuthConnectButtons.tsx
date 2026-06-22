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
 * One "Connect <Network>" button per network. A network whose platform app is
 * configured (env creds present, per the status endpoint) is clickable and
 * starts the OAuth redirect; an unconfigured network shows the button DISABLED
 * with a hint, so the one-click path is always discoverable and it's obvious
 * why it's not yet active (admin must add the app credentials). The manual
 * "Connect account" dialog remains as the fallback.
 */
export function OAuthConnectButtons({ status }: Props) {
  const { t } = useTranslation('marketing');
  const { startConnect } = useSocialConnect();

  if (!status) return null;
  const anyConfigured = SOCIAL_NETWORKS.some((n) => status[n]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {SOCIAL_NETWORKS.map((network: SocialNetwork) => {
          const meta = NETWORK_META[network];
          const Icon = meta.icon;
          const configured = !!status[network];
          return (
            <Button
              key={network}
              variant="outline"
              size="sm"
              disabled={!configured}
              title={
                configured
                  ? undefined
                  : t('social.oauth.notConfigured', {
                      defaultValue: 'An admin must add this network’s app credentials first',
                    })
              }
              onClick={() => configured && startConnect(network)}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t('social.oauth.connect', { defaultValue: 'Connect' })} {meta.label}
            </Button>
          );
        })}
      </div>
      {!anyConfigured && (
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
