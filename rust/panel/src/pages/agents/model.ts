import type { WorkspaceModule } from '@/api/modules';
import type { AgentConnectionOut, AgentWakeOut, KeySummary, NeedKey, Permission, WaitingFor, WorkItem } from '@/api/types';

// The agents page's model: one agent per API key (its wake address, schedule and connections
// belong to the key), its state as the server's wake read gives it, and the group it stands in.

/** An agent seen this recently is at work (`jt_app::usecases::wake::WORKING_WINDOW`). */
export const WORKING_MS = 2 * 60_000;
/** A call this recent, with the agent not seen since, reads as "called" (`CALLED_WINDOW`). */
export const CALLED_MS = 15 * 60_000;
/**
 * An agent not seen for a week, or for two of its own intervals when it comes less often, and
 * without a wake address is not in use: it stands folded at the bottom. A key nobody ever used
 * is not in use once it is a week old.
 */
export const UNUSED_DAYS = 7;
/** How far past its own interval an agent that comes less often than weekly may go before it is not in use. */
export const UNUSED_INTERVALS = 2;
/** A late agent last seen this many days ago or more reads "N gündür uğramadı". */
export const AWAY_DAYS = 2;
const MIN = 60_000;
const DAY = 86_400_000;

/** What `work.pending` asks of an agent, by the kind of work its key must hold (`jt_app::usecases::wake::NEEDS`). */
export const NEEDS: { need: NeedKey; permission: Permission; module: string | null }[] = [
  { need: 'content', permission: 'content.work', module: 'content' },
  { need: 'materials', permission: 'materials.work', module: 'materials' },
  { need: 'social', permission: 'social.work', module: 'social' },
  { need: 'ads', permission: 'ads.work', module: 'ads' },
  { need: 'research', permission: 'prospects.work', module: null },
  { need: 'inbox', permission: 'inbox.work', module: null },
  { need: 'knowledge', permission: 'content.work', module: null },
];

/**
 * The items of a person's `work.pending` read that are an agent's to take, by need. Only work an
 * agent clears counts: a person's own tasks (an upload an agent asked for, an approval, a held
 * area) do not, and the items `work.pending` lists only to an agent (an area whose time has come,
 * a version waiting for a time, an ad plan) are not in a person's read at all.
 */
export function agentWorkByNeed(items: readonly WorkItem[]): Record<NeedKey, number> {
  const out: Record<NeedKey, number> = { content: 0, materials: 0, social: 0, ads: 0, research: 0, inbox: 0, knowledge: 0 };
  for (const item of items) {
    switch (item.kind) {
      case 'content_area': out.content += 1; break;
      case 'studio_material_analysis': out.materials += 1; break;
      case 'studio_slot': case 'studio_post_request': out.social += 1; break;
      case 'studio_budget_move': out.ads += 1; break;
      case 'research_due': if (item.remaining_today > 0) out.research += 1; break;
      case 'prospects_to_score': if (item.count > 0) out.research += 1; break;
      case 'reply_due': case 'reopen_question': out.inbox += 1; break;
      default: break;
    }
  }
  return out;
}

export type Presence =
  | { kind: 'working' }
  | { kind: 'calling'; waitingFor: WaitingFor; dueAt: string }
  | { kind: 'called'; at: string }
  | { kind: 'never'; issuedAt: string | null; old: boolean }
  | { kind: 'onSchedule'; last: string; next: string | null; interval: number }
  | { kind: 'late'; last: string; expected: string | null }
  | { kind: 'away'; last: string; days: number }
  | { kind: 'revoked'; at: string | null };

export type Group = 'working' | 'attention' | 'unused' | 'revoked';

export interface Agent {
  id: string;
  name: string;
  /** `null` for a member who may not read keys. */
  key: KeySummary | null;
  /** `null` when the wake read is not known (or the key is revoked). */
  wake: AgentWakeOut | null;
  /** Newest contact first. */
  connections: AgentConnectionOut[];
  lastSeen: string | null;
  presence: Presence;
  /** Work waiting that this agent may take, by need; `null` when not known. */
  waiting: Partial<Record<NeedKey, number>> | null;
  waitingTotal: number;
  /** Why a person should look: a refused address, or work waiting while the agent stays away. */
  attention: 'refused' | 'late' | null;
  group: Group;
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** The needs agent `key` may take: its permission, and the module installed and offered to it. */
function needsOf(key: KeySummary, connections: AgentConnectionOut[], modules: readonly WorkspaceModule[] | undefined): NeedKey[] | null {
  return NEEDS.filter(({ permission, module }) => {
    if (!key.scopes.includes(permission)) return false;
    if (!module) return true;
    if (!modules) return true;
    const found = modules.find((m) => m.blueprint.id === module);
    return !!found?.installed && (!found.config.agent_ids.length || connections.some((c) => found.config.agent_ids.includes(c.id)));
  }).map(({ need }) => need);
}

export interface Inputs {
  keys: KeySummary[] | undefined;
  connections: AgentConnectionOut[];
  /** The wake read's agents: every active key. */
  wakes: AgentWakeOut[] | undefined;
  /** A person's `work.pending` items; `undefined` when not known. */
  items: readonly WorkItem[] | undefined;
  modules: readonly WorkspaceModule[] | undefined;
  now: number;
}

/**
 * Every agent, one per key: the keys when they can be read, else the keys the wake read and the
 * connections name (a connection whose key the wake read does not list is a revoked key's). Each
 * with its state and its group, attention first, then the latest contact, then the newest key.
 */
export function agentsOf({ keys, connections, wakes, items, modules, now }: Inputs): Agent[] {
  const byKey = new Map<string, { id: string; name: string; key: KeySummary | null; connections: AgentConnectionOut[] }>();
  for (const key of keys ?? []) byKey.set(key.id, { id: key.id, name: key.name, key, connections: [] });
  for (const wake of wakes ?? []) if (!byKey.has(wake.api_key_id) && !keys) byKey.set(wake.api_key_id, { id: wake.api_key_id, name: '', key: null, connections: [] });
  for (const c of connections) {
    const found = byKey.get(c.api_key_id) ?? { id: c.api_key_id, name: c.api_key_name, key: null, connections: [] };
    if (!found.name) found.name = c.api_key_name;
    found.connections.push(c);
    byKey.set(found.id, found);
  }
  const work = items ? agentWorkByNeed(items) : null;
  const agents = [...byKey.values()].map((raw): Agent => {
    const conns = [...raw.connections].sort((a, b) => time(b.last_seen_at) - time(a.last_seen_at));
    const wake = wakes?.find((w) => w.api_key_id === raw.id) ?? null;
    const revoked = raw.key ? raw.key.status === 'revoked' : !!wakes && !wake;
    const lastSeen = wake?.last_seen_at ?? conns[0]?.last_seen_at ?? null;
    const needs = raw.key && !revoked ? needsOf(raw.key, conns, modules) : null;
    const waiting = needs && work ? Object.fromEntries(needs.filter((n) => work[n] > 0).map((n) => [n, work[n]])) as Partial<Record<NeedKey, number>> : null;
    const waitingTotal = waiting ? Object.values(waiting).reduce((a, b) => a + (b ?? 0), 0) : 0;
    const presence = presenceOf(revoked, raw.key, wake, conns, lastSeen, now);
    const address = wake?.address ?? null;
    const quiet = Math.max(UNUSED_DAYS * DAY, UNUSED_INTERVALS * (wake?.interval_minutes ?? 0) * MIN);
    const unused = !revoked && !address
      && (lastSeen ? now - time(lastSeen) >= quiet : !!raw.key && now - time(raw.key.created_at) >= UNUSED_DAYS * DAY);
    let attention: Agent['attention'] = null;
    if (!revoked && address?.refused_at) attention = 'refused';
    else if (!revoked && !unused && waitingTotal > 0 && ['late', 'away', 'never'].includes(presence.kind)) attention = 'late';
    const group: Group = revoked ? 'revoked' : unused ? 'unused' : attention ? 'attention' : 'working';
    return { id: raw.id, name: raw.name || raw.id, key: raw.key, wake, connections: conns, lastSeen, presence, waiting, waitingTotal, attention, group };
  });
  const rank: Record<Group, number> = { attention: 0, working: 1, unused: 2, revoked: 3 };
  return agents.sort((a, b) => rank[a.group] - rank[b.group]
    || time(b.lastSeen) - time(a.lastSeen)
    || time(b.key?.created_at) - time(a.key?.created_at)
    || a.name.localeCompare(b.name));
}

function presenceOf(revoked: boolean, key: KeySummary | null, wake: AgentWakeOut | null, conns: AgentConnectionOut[], lastSeen: string | null, now: number): Presence {
  if (revoked) return { kind: 'revoked', at: key?.revoked_at ?? null };
  if (lastSeen && now - time(lastSeen) <= WORKING_MS) return { kind: 'working' };
  if (wake?.pending) return { kind: 'calling', waitingFor: wake.pending.waiting_for, dueAt: wake.pending.due_at };
  const last = wake?.last;
  if (last && last.outcome === 'fired' && now - time(last.at) <= CALLED_MS && (!lastSeen || time(lastSeen) < time(last.at))) return { kind: 'called', at: last.at };
  if (!lastSeen) {
    const issuedAt = key?.created_at ?? null;
    return { kind: 'never', issuedAt, old: !!issuedAt && now - time(issuedAt) >= UNUSED_DAYS * DAY };
  }
  const next = wake?.next_expected_at ?? null;
  // Without the wake read, the latest connection's own lateness is the key's: both use its interval.
  const late = wake ? !!next && time(next) <= now : !!conns[0]?.overdue;
  if (!late) return { kind: 'onSchedule', last: lastSeen, next, interval: wake?.interval_minutes ?? 0 };
  const days = Math.floor((now - time(lastSeen)) / DAY);
  if (days >= AWAY_DAYS) return { kind: 'away', last: lastSeen, days };
  return { kind: 'late', last: lastSeen, expected: next };
}

/** How many agents stand in each group. */
export function groupCounts(agents: readonly Agent[]): Record<Group, number> {
  const out: Record<Group, number> = { working: 0, attention: 0, unused: 0, revoked: 0 };
  for (const a of agents) out[a.group] += 1;
  return out;
}

// What an agent does, from its key's permissions, in the order a person reads them.
export const DOES: [Permission[], 'doesContent' | 'doesMaterials' | 'doesSocial' | 'doesAds' | 'doesProspects' | 'doesOutreach' | 'doesInbox' | 'doesCalls' | 'doesDevices' | 'doesBridge'][] = [
  [['content.work'], 'doesContent'],
  [['materials.work'], 'doesMaterials'],
  [['social.work'], 'doesSocial'],
  [['ads.work'], 'doesAds'],
  [['prospects.work'], 'doesProspects'],
  [['outreach.work'], 'doesOutreach'],
  [['inbox.work'], 'doesInbox'],
  [['calls.work'], 'doesCalls'],
  [['devices.work'], 'doesDevices'],
  [['calls.bridge', 'devices.bridge'], 'doesBridge'],
];
/** Permissions that change the workspace's settings rather than do its work. */
export const MANAGES: Permission[] = [
  'team.manage', 'api_keys.manage', 'capabilities.manage', 'budget.manage', 'inbox.manage', 'content.manage',
  'social.manage', 'ads.manage', 'calls.manage', 'prospects.manage', 'outreach.manage',
];
/** How many kinds of work the sentence names before "N more". */
export const DOES_SHOWN = 3;
