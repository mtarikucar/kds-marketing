import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import i18n from '@/i18n/config';
import type { WorkItem } from '@/api/types';
import type { WorkspaceModule } from '@/api/modules';
import { DAY, HOUR, MIN, at, connection, key, routine, wake } from '@/test/agents';
import { AGENT_COPY, type AgentCopy } from './copy';
import { UNUSED_DAYS, agentWorkByNeed, agentsOf } from './model';
import { doesText, stateText } from './words';

const copyOf = (language: 'tr' | 'en'): AgentCopy => {
  const table = AGENT_COPY[language];
  const copy = ((k: keyof typeof table, vars: Record<string, string | number> = {}) => table[k].replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? ''))) as AgentCopy;
  copy.language = language;
  copy.isTurkish = language === 'tr';
  return copy;
};
const tr = copyOf('tr');
const t = i18n.getFixedT('tr') as TFunction;

describe('agentsOf', () => {
  it('is one agent per key, with its connections newest first', () => {
    const k = key({ name: 'a' });
    const old = connection(k, { last_seen_at: at(-3 * DAY) });
    const live = connection(k, { last_seen_at: at(-MIN * 30) });
    const [agent] = agentsOf({ keys: [k], connections: [old, live], wakes: undefined, items: undefined, modules: undefined, now: Date.now() });
    expect(agent.connections).toEqual([live, old]);
    expect(agent.lastSeen).toBe(live.last_seen_at);
  });

  it('puts an agent away after a week (or two of its own turns) without contact and without a wake address', () => {
    const now = Date.now();
    const away = key({ name: 'away' });
    const woken = key({ name: 'woken' });
    const newKey = key({ name: 'new', created_at: at(-DAY) });
    const oldKey = key({ name: 'old', created_at: at(-(UNUSED_DAYS + 1) * DAY) });
    const weekly = key({ name: 'weekly' });
    const weeklySeen = at(-10 * DAY);
    const seen = at(-(UNUSED_DAYS + 1) * DAY);
    const list = agentsOf({
      keys: [away, woken, newKey, oldKey],
      connections: [connection(away, { last_seen_at: seen }), connection(woken, { last_seen_at: seen }), connection(weekly, { last_seen_at: weeklySeen })],
      wakes: [wake(away, { last_seen_at: seen, next_expected_at: at(-DAY) }), wake(woken, { last_seen_at: seen, address: routine(), next_expected_at: at(-DAY) }), wake(newKey, { last_seen_at: null, next_expected_at: null }), wake(oldKey, { last_seen_at: null, next_expected_at: null }), wake(weekly, { last_seen_at: weeklySeen, interval_minutes: 7 * 1440, next_expected_at: at(-3 * DAY) })],
      items: [], modules: undefined, now,
    });
    const group = (name: string) => list.find((a) => a.name === name)?.group;
    expect(group('away')).toBe('unused');
    expect(group('woken')).toBe('working');
    expect(group('new')).toBe('working');
    expect(group('old')).toBe('unused');
    // A weekly agent is in use until it misses two of its turns.
    expect(group('weekly')).toBe('working');
  });

  it('counts only the work its key and modules let it take', () => {
    const k = key({ name: 'files', scopes: ['workspace.read', 'materials.work', 'prospects.work'] });
    const conn = connection(k);
    const items = [
      { kind: 'studio_material_analysis', material_id: 'm', expected_revision: 1 },
      { kind: 'research_due', task_id: 't', remaining_today: 3 },
      { kind: 'research_due', task_id: 't2', remaining_today: 0 },
      { kind: 'reply_due', conversation_id: 'c' },
    ] as WorkItem[];
    const modules = [{ blueprint: { id: 'materials' }, installed: true, config: { agent_ids: ['someone-else'] } }] as unknown as WorkspaceModule[];
    const [assignedElsewhere] = agentsOf({ keys: [k], connections: [conn], wakes: [wake(k)], items, modules, now: Date.now() });
    expect(assignedElsewhere.waiting).toEqual({ research: 1 });
    const [offered] = agentsOf({ keys: [k], connections: [conn], wakes: [wake(k)], items, modules: [{ ...modules[0], config: { ...modules[0].config, agent_ids: [conn.id] } }], now: Date.now() });
    expect(offered.waiting).toEqual({ materials: 1, research: 1 });
    expect(offered.waitingTotal).toBe(2);
  });

  it('leaves a person’s own tasks out of an agent’s work', () => {
    expect(agentWorkByNeed([
      { kind: 'content_material_request', project_id: 'p', request_id: 'r' },
      { kind: 'content_area_held', project_id: 'p' },
      { kind: 'studio_approval', target: { slot: 's' } },
      { kind: 'ads_campaign_proposal', campaign_id: 'c' },
    ] as WorkItem[])).toEqual({ content: 0, materials: 0, social: 0, ads: 0, research: 0, inbox: 0 });
  });
});

describe('the sentences', () => {
  const sentence = (over: Parameters<typeof wake>[1], extra: { items?: WorkItem[]; scopes?: string[] } = {}) => {
    const k = key({ name: 'x', created_at: at(-DAY), scopes: (extra.scopes ?? ['workspace.read', 'materials.work']) as never });
    const w = wake(k, over);
    const [agent] = agentsOf({ keys: [k], connections: w.last_seen_at ? [connection(k, { last_seen_at: w.last_seen_at })] : [], wakes: [w], items: extra.items ?? [], modules: undefined, now: Date.now() });
    return { text: stateText(tr, t, agent, Date.now()), agent };
  };
  it('says each state in words', () => {
    expect(sentence({ last_seen_at: at(-30_000) }).text).toBe('Şu an çalışıyor.');
    expect(sentence({ pending: { due_at: at(20_000), waiting_for: 'settle', reasons: [] } }).text).toBe('Şimdi çağrılıyor.');
    expect(sentence({ last_seen_at: at(-HOUR), last: { at: at(-5 * MIN), reasons: [], outcome: 'fired', status: 200, session_id: null, session_url: null } }).text).toMatch(/çağrıldı; gelmesi bekleniyor\.$/);
    expect(sentence({ last_seen_at: null, next_expected_at: null }).text).toBe('Henüz hiç uğramadı.');
    expect(sentence({ last_seen_at: at(-17 * DAY), next_expected_at: at(-16 * DAY), address: routine() }).text).toBe('17 gündür uğramadı.');
    expect(sentence({ last_seen_at: at(-51 * MIN), next_expected_at: at(9 * MIN) }).text).toMatch(/^51 dakika önce uğradı; saat başı uğrar, sıradaki \d\d:\d\d\.$/);
  });
  it('adds the work waiting, and asks for attention only when the agent stays away from it', () => {
    const items = [{ kind: 'studio_material_analysis', material_id: 'm', expected_revision: 1 }] as WorkItem[];
    const late = sentence({ last_seen_at: at(-3 * HOUR), next_expected_at: at(-2 * HOUR) }, { items });
    expect(late.text).toMatch(/bekleniyordu\. 1 iş onu bekliyor\.$/);
    expect(late.agent.attention).toBe('late');
    const onTime = sentence({ last_seen_at: at(-30 * MIN), next_expected_at: at(30 * MIN) }, { items });
    expect(onTime.agent.attention).toBeNull();
    expect(sentence({ last_seen_at: at(-3 * HOUR), next_expected_at: at(-2 * HOUR) }).agent.attention).toBeNull();
    expect(sentence({ address: routine({ refused_at: at(-HOUR) }) }).agent.attention).toBe('refused');
  });
});

describe('doesText', () => {
  it('says what a key lets an agent do, not how many permissions it has', () => {
    expect(doesText(tr, ['workspace.read', 'materials.work', 'content.work', 'social.work'])).toBe('İçerik hazırlar, dosyaları inceleyip etiketler ve paylaşımları planlar.');
    expect(doesText(tr, ['workspace.read', 'prospects.work'])).toBe('Aday araştırır.');
    expect(doesText(tr, ['workspace.read', 'ledger.read'])).toBe('Yalnızca okur.');
    expect(doesText(tr, [])).toBe('Hiçbir izni yok.');
    expect(doesText(tr, ['content.work', 'materials.work', 'social.work', 'ads.work', 'prospects.work', 'inbox.work']))
      .toBe('İçerik hazırlar, dosyaları inceleyip etiketler, paylaşımları planlar ve 3 iş daha yapar.');
    expect(doesText(tr, ['team.manage', 'content.work', 'materials.work', 'social.work', 'ads.work', 'prospects.work']))
      .toBe('Kurulum anahtarı: hemen her işi yapar ve ayarları değiştirebilir.');
    expect(doesText(tr, ['content.manage', 'content.work'])).toBe('İçerik hazırlar. Ayarları da değiştirebilir.');
    expect(doesText(copyOf('en'), ['content.work', 'social.work'])).toBe('Prepares content and plans posts.');
  });
});
