import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Button, Callout } from '@/components/ui';

/**
 * Drop-in replacement for a tool the current workspace isn't entitled to.
 * Without a gate the tool renders and is clickable, the user clicks, and the
 * call silently 403s with a generic error and no guidance; this states what is
 * missing and links to /billing.
 *
 * The copy used to name the "Growth plan" specifically. That tier is retired —
 * there is one plan now, and the trial already grants every feature — so the
 * only way to reach this state is without an active subscription. Naming a
 * plan that no longer exists sent people hunting for an upgrade they could
 * not find. These keys also had no entry in ANY locale file, so Turkish users
 * were reading the English default.
 */
export function UpgradeCallout({ className }: { className?: string }) {
  const { t } = useTranslation('marketing');
  return (
    <Callout
      tone="info"
      icon={<Lock className="h-4 w-4" aria-hidden="true" />}
      title={t('gate.upgrade.title', 'Requires an active subscription')}
      className={className}
    >
      <div className="flex flex-col items-start gap-3">
        <p>
          {t(
            'gate.upgrade.body',
            'Your subscription does not cover this right now. Activate the plan to unlock it.',
          )}
        </p>
        <Button asChild variant="primary" size="sm">
          <Link to="/billing">{t('gate.upgrade.cta', 'View the plan')}</Link>
        </Button>
      </div>
    </Callout>
  );
}
