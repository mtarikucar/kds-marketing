import type { AgentConnectionOut, AgentWakeOut, KeySummary, NeedWake, WakesOut } from '@/api/types';
import { USER_ID } from '@/test/fixtures';

// Agents as the owner's workspace has them, for the agents page's tests: keys, their connections
// and their wake states, at times relative to now.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const at = (ms: number) => new Date(Date.now() + ms).toISOString();

let n = 0;
const id = (prefix: string) => `${prefix}-${(n += 1).toString().padStart(4, '0')}`;

export function key(over: Partial<KeySummary> & { name: string }): KeySummary {
  return {
    id: id('key'), prefix: `jt_live_${over.name.slice(0, 4)}`, scopes: ['workspace.read'], status: 'active',
    issued_by: USER_ID, created_at: at(-30 * DAY), last_used_at: null, revoked_at: null, ...over,
  };
}

export function connection(k: KeySummary, over: Partial<AgentConnectionOut> = {}): AgentConnectionOut {
  return {
    id: id('conn'), api_key_id: k.id, api_key_name: k.name, client_name: 'claude-code', client_version: '2.1.309',
    protocol_version: '2025-06-18', first_seen_at: at(-20 * DAY), last_seen_at: at(-HOUR), tool_calls: 12, overdue: false, ...over,
  };
}

export function wake(k: KeySummary, over: Partial<AgentWakeOut> = {}): AgentWakeOut {
  return {
    api_key_id: k.id, address: null, pending: null, last: null, last_seen_at: at(-HOUR), interval_minutes: 60,
    interval_learned: true, next_expected_at: at(10 * MIN), run_now: null, ...over,
  };
}

export const routine = (over: Partial<NonNullable<AgentWakeOut['address']>> = {}): AgentWakeOut['address'] => ({
  kind: 'claude_routine', target: 'trig_01ABC', has_secret: true, set_at: at(-DAY), set_by: USER_ID, refused_at: null, ...over,
});

const none: NeedWake = { state: 'no_agent' };
export function wakesOf(...agents: AgentWakeOut[]): WakesOut {
  return { agents, needs: { content: none, materials: none, social: none, ads: none, research: none, inbox: none } };
}
