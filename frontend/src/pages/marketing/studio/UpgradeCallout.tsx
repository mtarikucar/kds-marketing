import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Button, Callout } from '@/components/ui';

/**
 * Drop-in replacement for a Growth-plan tool the current workspace's package
 * doesn't entitle. Without a gate the tool renders and is clickable, the user
 * clicks, and the call silently 403s with a generic error and no guidance; this
 * states plainly what's missing and links to /billing to upgrade.
 */
export function UpgradeCallout({ className }: { className?: string }) {
  const { t } = useTranslation('marketing');
  return (
    <Callout
      tone="info"
      icon={<Lock className="h-4 w-4" aria-hidden="true" />}
      title={t('gate.upgrade.title', 'Part of the Growth plan')}
      className={className}
    >
      <div className="flex flex-col items-start gap-3">
        <p>{t('gate.upgrade.body', 'This is part of the Growth plan — upgrade to unlock it.')}</p>
        <Button asChild variant="primary" size="sm">
          <Link to="/billing">{t('gate.upgrade.cta', 'View plans')}</Link>
        </Button>
      </div>
    </Callout>
  );
}
