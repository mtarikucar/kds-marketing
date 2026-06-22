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
 * One "Connect <Network>" button per network whose platform app is configured
 * (env creds present, reported by the status endpoint). Clicking starts the
 * OAuth redirect. Networks without configured app creds are omitted — the
 * manual "Connect account" dialog remains available as the fallback.
 */
export function OAuthConnectButtons({ status }: Props) {
  const { t } = useTranslation('marketing');
  const { startConnect } = useSocialConnect();

  if (!status) return null;
  const configured = SOCIAL_NETWORKS.filter((n) => status[n]);
  if (configured.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {configured.map((network: SocialNetwork) => {
        const meta = NETWORK_META[network];
        const Icon = meta.icon;
        return (
          <Button
            key={network}
            variant="outline"
            size="sm"
            onClick={() => startConnect(network)}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {t('social.oauth.connect', { defaultValue: 'Connect' })} {meta.label}
          </Button>
        );
      })}
    </div>
  );
}
