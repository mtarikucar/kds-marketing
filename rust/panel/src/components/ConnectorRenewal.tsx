import { useTranslation } from 'react-i18next';
import { providerOf, renewalOf } from '@/lib/connectors';
import { formatDateTime } from '@/lib/format';

/**
 * What a connection's access expiry means for a person, in one sentence: nothing when Jeeta
 * renews it by itself (X, TikTok), else its end as a date and who acts then (`renewalOf`).
 */
export function ConnectorRenewal({ kind, expiresAt, onboarding, className }: { kind: string; expiresAt: string; onboarding?: unknown; className?: string }) {
  const { t, i18n } = useTranslation();
  const at = formatDateTime(expiresAt, i18n.language);
  const renewal = renewalOf(kind, onboarding);
  const text = renewal === 'self'
    ? t(providerOf(kind) === 'tiktok' ? 'capabilities.connector.renewal.selfTiktok' : 'capabilities.connector.renewal.self')
    : t(`capabilities.connector.renewal.${renewal}`, { at });
  return <p className={className} data-renewal={renewal}>{text}</p>;
}
