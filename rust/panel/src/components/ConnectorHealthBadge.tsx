import { useTranslation } from 'react-i18next';
import type { ConnectorHealth } from '@/api/types';
import { Badge, type BadgeProps } from '@/components/ui';
import { healthView, isErrorKind } from '@/lib/connectors';
import { formatDateTime, formatRelative } from '@/lib/format';

/**
 * A connector capability's health, most pressing first: it must be reconnected, its token has
 * expired or expires soon, its last probe failed (and why) or succeeded (and how long ago), or it
 * was never probed.
 */
export function ConnectorHealthBadge({ health }: { health: ConnectorHealth }) {
  const { t, i18n } = useTranslation();
  const view = healthView(health);
  const when = (iso: string) => formatRelative(iso, i18n.language);
  let tone: NonNullable<BadgeProps['tone']>;
  let text: string;
  let title: string | undefined;
  switch (view.kind) {
    case 'reconnect':
      tone = 'danger';
      text = t('capabilities.connector.health.reconnect');
      break;
    case 'expired':
      tone = 'danger';
      text = t('capabilities.connector.health.expired');
      break;
    case 'expiresSoon':
      tone = 'warning';
      text = t('capabilities.connector.health.expiresSoon', { when: when(view.at) });
      title = formatDateTime(view.at, i18n.language);
      break;
    case 'failed': {
      tone = 'danger';
      const reason = isErrorKind(view.errorKind)
        ? t(`capabilities.connector.errorKinds.${view.errorKind}`)
        : t('capabilities.connector.errorKinds.unknown');
      text = t('capabilities.connector.health.failed', { reason, when: when(view.at) });
      title = formatDateTime(view.at, i18n.language);
      break;
    }
    case 'ok':
      tone = 'success';
      text = t('capabilities.connector.health.ok', { when: when(view.at) });
      title = formatDateTime(view.at, i18n.language);
      break;
    case 'never':
      tone = 'neutral';
      text = t('capabilities.connector.health.never');
      break;
  }
  return (
    <Badge tone={tone} size="sm" title={title} data-connector-health={view.kind}>
      {text}
    </Badge>
  );
}
