import { useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { getOutreachSettings } from '@/api/outreach';
import type { CampaignStatus, OutreachSettingsOut } from '@/api/types';
import { Badge, Callout } from '@/components/ui';
import { useLeadsKey } from './LeadsShared';

// What the outreach pages share: the settings query, the lock notice, status badges and the
// panel's words for stop and skip reasons.

/** The workspace's outreach settings (and whether the platform switch is on). */
export function useOutreachSettings() {
  const key = useLeadsKey();
  return useQuery({ queryKey: [...key, 'outreach', 'settings'], queryFn: getOutreachSettings });
}

/** Why nothing launches yet: the platform switch, then the footer's sender identity. */
export function launchBlockers(t: TFunction, s: OutreachSettingsOut | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (!s.platform_enabled) out.push(t('leads.outreach.blocked.platform'));
  if (!s.sender_identity_complete) out.push(t('leads.outreach.blocked.identity'));
  return out;
}

/** The lock, said once at the top of each outreach page while it holds. */
export function LockNotice({ settings }: { settings: OutreachSettingsOut | undefined }) {
  const { t } = useTranslation();
  if (!settings) return null;
  return (
    <>
      {!settings.platform_enabled && (
        <Callout tone="warning" title={t('leads.outreach.locked.title')}>
          {t('leads.outreach.locked.body')}
        </Callout>
      )}
      {!settings.sender_identity_complete && (
        <Callout tone="info" title={t('leads.outreach.identityMissing.title')}>
          <p>{t('leads.outreach.identityMissing.body')}</p>
          <Link className="mt-1 inline-block text-primary underline" to="/outreach/settings">
            {t('leads.outreach.settingsLink')}
          </Link>
        </Callout>
      )}
    </>
  );
}

const TONE: Record<CampaignStatus, 'neutral' | 'warning' | 'info' | 'success' | 'primary' | 'danger'> = {
  draft: 'neutral',
  awaiting_approval: 'warning',
  scheduled: 'info',
  running: 'success',
  paused: 'warning',
  completed: 'primary',
  canceled: 'neutral',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[status]}>{t(`leads.campaignStatus.${status}`)}</Badge>;
}

const STOP_REASONS = [
  'replied',
  'bounced',
  'complained',
  'unsubscribed',
  'consent_withdrawn',
  'meeting_booked',
  'journey_won',
  'journey_lost',
  'person_erased',
  'person_merged',
  'human_holds_conversation',
  'do_not_contact',
  'campaign_canceled',
  'manual',
] as const;

const SKIP_REASONS = [
  'no_deliverable_email',
  'suppressed',
  'no_basis',
  'do_not_contact',
  'active_elsewhere',
  'person_gone',
  'journey_closed',
  'promotion_cap',
] as const;

/** A stop reason key (`replied`, `refused:<key>`, `missing_variable:<name>`) in the panel's words. */
export function stopText(t: TFunction, key: string): string {
  if (key.startsWith('refused:')) return t('leads.stop.refused', { reason: key.slice('refused:'.length) });
  if (key.startsWith('missing_variable:')) return t('leads.stop.missingVariable', { name: key.slice('missing_variable:'.length) });
  return (STOP_REASONS as readonly string[]).includes(key)
    ? t(`leads.stop.${key as (typeof STOP_REASONS)[number]}`)
    : key;
}

/** A skip reason key in the panel's words. */
export function skipText(t: TFunction, key: string): string {
  return (SKIP_REASONS as readonly string[]).includes(key) ? t(`leads.skip.${key as (typeof SKIP_REASONS)[number]}`) : key;
}
