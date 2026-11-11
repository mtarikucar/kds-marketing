import type { TFunction } from 'i18next';
import { INBOUND_EVENTS_COUNT_CAP, type WorkItem } from '@/api/types';

/** What a pending work item asks, in the panel's own words (the `hint` is for the agent). */
export function workItemText(t: TFunction, item: WorkItem, tiktokWaiting = false): string {
  if (tiktokWaiting) return t('socialAccounts.finishTiktok');
  switch (item.kind) {
    case 'content_area':
      return item.redo_note ? t('contentAreas.redoStatus', { note: item.redo_note }) : t('home.pending.content_area');
    case 'verify_capability':
      return item.stale
        ? t('home.pending.verify_capability_stale', { name: item.name })
        : t('home.pending.verify_capability', { name: item.name });
    case 'connect_connector':
      return t('home.pending.connect_connector', { name: item.name });
    case 'reconnect_connector':
      return t('home.pending.reconnect_connector', { name: item.name });
    case 'voice_bridge_offline':
      return t('home.pending.voice_bridge_offline', { name: item.name });
    case 'phone_offline':
      return t('home.pending.phone_offline', { name: item.name });
    case 'inbound_events':
      // `count` picks the plural form; `n` is what is shown, a count of the cap as at least that many.
      return t('home.pending.inbound_events', {
        count: item.count,
        n: item.count >= INBOUND_EVENTS_COUNT_CAP ? `${INBOUND_EVENTS_COUNT_CAP}+` : String(item.count),
      });
    default:
      return t(`home.pending.${item.kind}`);
  }
}

/**
 * Where an item is acted on: a capability to reconnect goes straight to its reconnection; the
 * inbound events are the agent's to read and acknowledge, so nothing opens for them.
 */
export function workItemLink(item: WorkItem, tiktokWaiting = false): string | null {
  if (tiktokWaiting) {
    const id = socialSlotId(item);
    if (id) return `/social?tiktok=${encodeURIComponent(id)}`;
  }
  switch (item.kind) {
    case 'ads_campaign_proposal':
    case 'ads_campaign_held':
      return `/ads?campaign=${encodeURIComponent(item.campaign_id)}`;
    case 'studio_slot':
      return `/social?slot=${encodeURIComponent(item.slot_id)}`;
    case 'studio_approval':
      return 'slot' in item.target ? `/social?slot=${encodeURIComponent(item.target.slot)}` : '/ads?tab=external';
    case 'studio_budget_move':
      return '/ads?tab=external';
    case 'studio_shoot_request':
      return '/materials?view=shoots';
    case 'studio_post_request':
      return '/social?tab=posts';
    case 'content_area':
    case 'content_material_request':
    case 'content_area_held':
      return `/content?area=${encodeURIComponent(item.project_id)}`;
    case 'studio_material_analysis':
      return `/materials?view=olays&material=${encodeURIComponent(item.material_id)}`;
    case 'studio_material_production':
      return '/materials?view=library';
    case 'reply_due':
    case 'reopen_question':
      return `/inbox/${encodeURIComponent(item.conversation_id)}`;
    case 'merge_suggested':
      return `/inbox/merges?merge=${encodeURIComponent(item.merge_id)}`;
    case 'task_due':
      return `/inbox?task=${encodeURIComponent(item.task_id)}`;
    case 'consult_strategy':
    case 'approve_strategy':
      return '/strategy';
    case 'reconnect_connector':
      return `/connect?capability=${encodeURIComponent(item.capability_id)}`;
    case 'research_due':
      return '/prospects/tasks';
    case 'prospects_to_score':
    case 'prospects_to_promote':
      return '/prospects';
    case 'ownerless_journeys':
    case 'assignment_stalled':
      return '/team/distribution';
    case 'promoted_not_contacted':
      return '/inbox';
    case 'campaign_approval':
    case 'campaign_blocked':
    case 'personalization_due':
      return `/outreach/${encodeURIComponent(item.campaign_id)}`;
    case 'inbound_events':
      return null;
    default:
      return '/capabilities';
  }
}

/** Only slot work can lead to the TikTok posting screen. */
export function socialSlotId(item: WorkItem): string | null {
  return item.kind === 'studio_slot' ? item.slot_id : item.kind === 'studio_approval' && 'slot' in item.target ? item.target.slot : null;
}
