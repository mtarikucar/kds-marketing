import type { TFunction } from 'i18next';
import type { PromoteOutcome, ResearchTask } from '@/api/types';

// Words the pool's pages share with each other (and with the research tasks page).

/** A promotion outcome in the panel's words. */
export function promoteOutcomeText(t: TFunction, o: PromoteOutcome): string {
  switch (o.outcome) {
    case 'promoted':
      return t('leads.outcome.promoted');
    case 'already_promoted':
      return t('leads.outcome.alreadyPromoted');
    case 'refused':
      return isPromoteRefusal(o.reason) ? t(`leads.promoteRefused.${o.reason}`) : t('leads.promoteRefused.other');
  }
}

/** The refusal reasons of `prospects.promote` the panel has its own words for. */
const PROMOTE_REFUSALS = [
  'not_found',
  'not_qualified',
  'daily_cap',
  'no_contact_identity',
  'do_not_contact',
  'erased_identity',
  'identity_split',
  'lost_journey_exists',
  'person_already_linked',
  'already_promoted',
] as const;

function isPromoteRefusal(reason: string): reason is (typeof PROMOTE_REFUSALS)[number] {
  return (PROMOTE_REFUSALS as readonly string[]).includes(reason);
}

/** What a research task is called in a list: its ICP entry, or its brief's sectors. */
export function taskLabel(t: TFunction, task: ResearchTask): string {
  return task.kind.type === 'standing'
    ? t('leads.tasks.kind.standing', { key: task.kind.icp_key })
    : t('leads.tasks.kind.ad_hoc', { sectors: task.brief.sectors.join(', ') });
}
