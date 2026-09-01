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
 * there is one plan now — so the only way to reach the default variant is
 * without an active subscription. Naming a plan that no longer exists sent
 * people hunting for an upgrade they could not find. These keys also had no
 * entry in ANY locale file, so Turkish users were reading the English default.
 *
 * `addOn` switches to the second variant, and it exists because the default
 * copy is a lie in front of an add-on-only feature: `smsOtp`, `voiceCampaigns`
 * and `fax` are false on JEETA *and on TRIAL* (seed-packages.ts:81,95,97),
 * each needing a separately purchased NetGSM package upstream, so "activate the
 * plan to unlock it" would send the customer to buy something that changes
 * nothing. Pass the add-on's display name; the body points at Boosts instead.
 */
export function UpgradeCallout({ className, addOn }: { className?: string; addOn?: string }) {
  const { t } = useTranslation('marketing');
  const isAddOn = !!addOn;
  return (
    <Callout
      tone="info"
      icon={<Lock className="h-4 w-4" aria-hidden="true" />}
      // Concatenated, NOT an i18n {{addOn}} placeholder: several page tests mock
      // `t` to return `defaultValue` verbatim with no interpolation, so a
      // placeholder would render literally and nothing would catch it.
      title={
        isAddOn
          ? `${addOn} — ${t('gate.addOn.title', 'paid add-on')}`
          : t('gate.upgrade.title', 'Requires an active subscription')
      }
      className={className}
    >
      <div className="flex flex-col items-start gap-3">
        <p>
          {isAddOn
            ? t(
                'gate.addOn.body',
                'This is not part of the plan. Buy it once under Boosts on the billing page, then it switches on for everyone in the workspace.',
              )
            : t(
                'gate.upgrade.body',
                'Your subscription does not cover this right now. Activate the plan to unlock it.',
              )}
        </p>
        <Button asChild variant="primary" size="sm">
          <Link to="/billing">
            {isAddOn
              ? t('gate.addOn.cta', 'See the add-ons')
              : t('gate.upgrade.cta', 'View the plan')}
          </Link>
        </Button>
      </div>
    </Callout>
  );
}
