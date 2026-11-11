import type { CapabilityOut, ConnectorHealth, KindGroup } from '@/api/types';
import { kindOf } from './capabilities';
import { healthView } from './connectors';

export const CAPABILITY_GOALS = [
  'all',
  'messages',
  'publishing',
  'calls',
  'devices',
  'growth',
  'tools',
  'custom',
] as const;
export type CapabilityGoal = (typeof CAPABILITY_GOALS)[number];
export const GOAL_GROUPS: Record<CapabilityGoal, readonly KindGroup[]> = {
  all: [],
  messages: ['messaging'],
  publishing: ['social_account'],
  calls: ['telephony'],
  devices: ['device', 'computer_access'],
  growth: ['ads', 'community'],
  tools: ['calendar', 'marketplace', 'agent_connection', 'third_party'],
  custom: ['third_party'],
};
export const GOAL_CONNECTIONS: Record<CapabilityGoal, readonly string[]> = {
  all: [],
  messages: ['whatsapp_cloud', 'instagram_dm', 'messenger', 'mailbox', 'sms_line'],
  publishing: ['instagram', 'facebook_page', 'linkedin_page', 'linkedin_member', 'x', 'tiktok'],
  calls: ['netgsm_pbx'],
  devices: [],
  growth: ['meta_ads', 'google_ads', 'linkedin_ads', 'tiktok_ads', 'x_ads'],
  tools: [],
  custom: [],
};
export function matchesGoal(item: CapabilityOut, goal: CapabilityGoal): boolean {
  if (goal === 'custom') return item.capability.kind_key === 'other';
  const group = kindOf(item.capability.kind_key)?.group;
  return goal === 'all' || (!!group && GOAL_GROUPS[goal].includes(group));
}
/** Retired resources need no repair. Unknown health alone is not a failure. */
export function needsCapabilityAttention(item: CapabilityOut, health?: ConnectorHealth): boolean {
  if (item.effective_status === 'retired') return false;
  if (item.effective_status !== 'verified') return true;
  return !!health && !['ok', 'never'].includes(healthView(health).kind);
}
