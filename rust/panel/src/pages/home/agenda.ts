import type { CallView } from '@/api/calls';
import type { PostFormat, WeeklySummary } from '@/api/posts';
import type { Actor, CampaignRow, InboxTask } from '@/api/types';

// The home calendar merges what the installed modules already schedule or record; nothing here is
// a new promise. Each source keeps its own meaning: a planned post is the planner's slot, a task is
// due, a call started, a campaign is scheduled or launched.

export type AgendaStatus = 'done' | 'active' | 'waiting' | 'planned' | 'overdue' | 'cancelled';
export type AgendaView = 'day' | 'week' | 'month';

export interface AgendaItem {
  id: string;
  /** RFC 3339. */
  at: string;
  /** The module's blueprint id; it picks the colour. */
  module: string;
  title: string;
  who: string;
  status: AgendaStatus;
  href: string;
}

/** One colour per built-in module, shared by the calendar, its legend and the log. */
const TONES: Record<string, { dot: string; edge: string }> = {
  inbox: { dot: 'bg-blue-500', edge: 'border-s-blue-500' },
  strategy: { dot: 'bg-slate-500', edge: 'border-s-slate-500' },
  materials: { dot: 'bg-emerald-500', edge: 'border-s-emerald-500' },
  content: { dot: 'bg-indigo-500', edge: 'border-s-indigo-500' },
  ads: { dot: 'bg-orange-500', edge: 'border-s-orange-500' },
  social: { dot: 'bg-violet-500', edge: 'border-s-violet-500' },
  outreach: { dot: 'bg-amber-500', edge: 'border-s-amber-500' },
  calls: { dot: 'bg-teal-500', edge: 'border-s-teal-500' },
  prospects: { dot: 'bg-rose-500', edge: 'border-s-rose-500' },
  people: { dot: 'bg-sky-500', edge: 'border-s-sky-500' },
};
const NEUTRAL = { dot: 'bg-zinc-400', edge: 'border-s-zinc-400' };
export function moduleTone(module: string | null | undefined) { return (module && TONES[module]) || NEUTRAL; }

/** The module a ledger action belongs to, by its prefix; `null` for workspace-wide actions. */
export function ledgerModule(action: string): string | null {
  const prefix = action.split('.')[0];
  switch (prefix) {
    case 'materials': return 'materials';
    case 'posts': return 'social';
    // The three modules' own records (production areas, scheduled versions and accounts, ad campaigns).
    case 'content': return 'content';
    case 'social': return 'social';
    case 'ads': return 'ads';
    case 'studio': {
      const operation = action.slice('studio.'.length);
      if (operation === 'slot_materials') return 'materials';
      // The records as the server writes them (`studio.publish.failure`, `studio.paid.refused`)
      // as well as the operations' own ids (`studio.budget_move`).
      if (/^(adset|budget_|binding_|external_drift|paid\.)/.test(operation)) return 'ads';
      if (/^(project_publication|project_schedule|project\.(scheduled|publication_linked)|post|slot|tiktok|publish\.|package\.|piece)/.test(operation)) return 'social';
      if (/^(project|material_production|calendar|material_policy)/.test(operation)) return 'content';
      if (/^(material|file|olay|shoot|piece)/.test(operation)) return 'materials';
      return null;
    }
    case 'inbox': case 'distribution': return 'inbox';
    case 'outreach': return 'outreach';
    case 'calls': case 'voice': return 'calls';
    case 'strategy': return 'strategy';
    case 'prospects': case 'research': return 'prospects';
    case 'people': return 'people';
    default: return null;
  }
}

// ---- dates (the viewer's local time) --------------------------------------------------------

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
/** Monday 00:00 of `d`'s week. */
export function startOfWeek(d: Date): Date { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); }

/** The days a view shows around `anchor`: one, seven, or the whole weeks covering its month. */
export function viewRange(view: AgendaView, anchor: Date): { from: Date; until: Date; days: Date[] } {
  let from: Date; let until: Date;
  if (view === 'day') { from = startOfDay(anchor); until = addDays(from, 1); }
  else if (view === 'week') { from = startOfWeek(anchor); until = addDays(from, 7); }
  else {
    from = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    until = addDays(startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)), 7);
  }
  const days: Date[] = [];
  for (let d = from; d < until; d = addDays(d, 1)) days.push(d);
  return { from, until, days };
}
/** The Mondays (`YYYY-MM-DD`) whose studio summaries cover a range. */
export function mondays(from: Date, until: Date): string[] {
  const out: string[] = [];
  for (let d = startOfWeek(from); d < until; d = addDays(d, 7)) out.push(dayKey(d));
  return out;
}
export function shiftAnchor(view: AgendaView, anchor: Date, step: 1 | -1): Date {
  if (view === 'day') return addDays(anchor, step);
  if (view === 'week') return addDays(anchor, 7 * step);
  return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
}

export function inRange(at: string, from: Date, until: Date): boolean {
  const t = new Date(at).getTime();
  return !Number.isNaN(t) && t >= from.getTime() && t < until.getTime();
}

// ---- sources ---------------------------------------------------------------------------------

export interface Words {
  published: (format: string) => string;
  toPublish: (format: string) => string;
  preparing: (format: string) => string;
  ready: (format: string) => string;
  dropped: (format: string) => string;
  format: (format: PostFormat | null) => string;
  call: (call: CallView) => string;
  campaign: (name: string) => string;
  actor: (actor: Actor) => string;
  member: (userId: string | null) => string;
  rep: (extension: string) => string;
  /** The agent assigned to a module, else the generic word. */
  moduleAgent: (module: string) => string;
}

export function studioItems(summary: WeeklySummary, words: Words, now: Date): AgendaItem[] {
  const who = words.moduleAgent('social');
  return [
    ...summary.published.map((p): AgendaItem => ({
      id: `studio-pub-${p.publication_id}`, at: p.published_at, module: 'social', who, href: `/social?slot=${encodeURIComponent(p.slot_id)}`,
      title: words.published(words.format(p.format)), status: 'done',
    })),
    ...summary.planned.map((p): AgendaItem => {
      const preparing = new Date(p.prep_start_at) <= now && now < new Date(p.publish_at);
      const late = new Date(p.publish_at) < now;
      const format = words.format(p.format);
      return {
        id: `studio-slot-${p.slot_id}`, at: p.publish_at, module: 'social', who, href: `/social?slot=${encodeURIComponent(p.slot_id)}`,
        title: p.state === 'ready' ? words.ready(format) : preparing ? words.preparing(format) : words.toPublish(format),
        status: late ? 'overdue' : preparing || p.state === 'ready' ? 'active' : 'planned',
      };
    }),
    ...summary.cancelled.map((p): AgendaItem => ({
      id: `studio-cancel-${p.slot_id}`, at: p.at, module: 'social', who, href: `/social?slot=${encodeURIComponent(p.slot_id)}`,
      title: words.dropped(words.format(p.format)), status: 'cancelled',
    })),
  ];
}

export function taskItems(tasks: readonly InboxTask[], words: Words, now: Date): AgendaItem[] {
  return tasks.map(task => ({
    id: `task-${task.id}`, at: task.due_at, module: 'inbox', title: task.title,
    who: words.member(task.assignee), href: `/inbox?task=${encodeURIComponent(task.id)}`,
    status: task.status === 'done' ? 'done' : task.status === 'cancelled' ? 'cancelled'
      : new Date(task.due_at) < now ? 'overdue' : 'planned',
  }));
}

export function callItems(calls: readonly CallView[], words: Words): AgendaItem[] {
  return calls.map(call => ({
    id: `call-${call.id}`, at: call.started_at, module: 'calls', title: words.call(call),
    who: call.mode.kind === 'agent' ? words.moduleAgent('calls') : words.rep(call.mode.rep_extension),
    href: `/calls/${encodeURIComponent(call.id)}`,
    status: call.state === 'ended' ? 'done' : call.state === 'planned' ? 'planned' : 'active',
  }));
}

export function campaignItems(campaigns: readonly CampaignRow[], words: Words): AgendaItem[] {
  const out: AgendaItem[] = [];
  for (const c of campaigns) {
    if (c.status === 'draft') continue;
    const at = c.launched_at ?? c.definition.schedule.start_at ?? c.updated_at;
    const status: AgendaStatus = c.status === 'awaiting_approval' ? 'waiting'
      : c.status === 'running' ? 'active' : c.status === 'completed' ? 'done'
      : c.status === 'scheduled' ? 'planned' : c.status === 'paused' ? 'waiting' : 'cancelled';
    out.push({ id: `campaign-${c.id}`, at, module: 'outreach', title: words.campaign(c.name), who: words.actor(c.created_by),
      href: `/outreach/${encodeURIComponent(c.id)}`, status });
  }
  return out;
}

/** Earliest first; on the same minute, unfinished work before what is done. */
export function sortAgenda(items: AgendaItem[]): AgendaItem[] {
  const rank: Record<AgendaStatus, number> = { overdue: 0, waiting: 1, active: 2, planned: 3, done: 4, cancelled: 5 };
  return [...items].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
}
