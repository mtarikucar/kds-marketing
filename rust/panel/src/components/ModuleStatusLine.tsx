import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { listAgents } from '@/api/agents';
import { listKeys } from '@/api/apiKeys';
import { listBudgetItems } from '@/api/budget';
import { listCapabilities } from '@/api/capabilities';
import { getPending } from '@/api/work';
import { useSession } from '@/auth/useSession';
import { useModules } from '@/lib/modules';
import { can } from '@/lib/roles';
import { formatDateTime } from '@/lib/format';
import { pickNeed, useAgentWakes } from '@/lib/wake';
import type { NeedKey, WorkItem } from '@/api/types';
import { useKnowledge } from '@/pages/knowledge/queries';
import { AgentWakeLine } from './AgentWakeLine';

/** The permission a connection must hold to create ads, by the kind of its ad account (the server's `studio::chain::write_scopes`); `null`: the platform's authorization names none (TikTok). */
const AD_WRITE_SCOPES: Record<string, string | null> = { meta_ads: 'ads_management', google_ads: 'https://www.googleapis.com/auth/adwords', linkedin_ads: 'rw_ads', tiktok_ads: null, x_ads: 'ads.write' };
/**
 * The agent check-in, as one sentence, only when it matters to a person: work waits for an agent
 * and none that may do it checked in on time. Nothing when nothing waits or an agent is on time.
 * The sentence names how much waits and the most recent check-in among the agents, never one
 * line per agent.
 */
export function agentNotice(t: TFunction, language: string, waiting: number, agents: { last_seen_at: string | null; overdue: boolean }[]): string | null {
  const idle = agentIdle(waiting, agents);
  if (!idle) return null;
  return idle.last
    ? t('moduleStatus.overdue', { n: waiting, time: formatDateTime(idle.last, language) })
    : t('moduleStatus.noAgent', { n: waiting });
}
/** [`agentNotice`]'s rule without its words: `null` when it says nothing, else the most recent check-in (`null`: none). */
export function agentIdle(waiting: number, agents: { last_seen_at: string | null; overdue: boolean }[]): { last: string | null } | null {
  if (waiting <= 0 || agents.some(a => !a.overdue && a.last_seen_at)) return null;
  return { last: agents.map(a => a.last_seen_at).filter((at): at is string => !!at).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null };
}
/**
 * The agents that may work a module: those its settings assign (every agent when none is), whose
 * key is active and holds `{module}.work` where keys can be read. `undefined` until known, or
 * while the module is not installed.
 */
export function useModuleAgents(module: 'content' | 'social' | 'ads' | 'prospects') {
  const session = useSession();
  const workspace = session.data?.current_workspace;
  const modules = useModules();
  const agents = useQuery({ queryKey: ['agents', workspace], queryFn: listAgents, refetchInterval: 60_000 });
  // Connections outlive revoked keys. Where key metadata is readable, exclude those connections.
  const keys = useQuery({ queryKey: ['api-keys', workspace], queryFn: listKeys, enabled: can(session.data, 'api_keys.manage'), refetchInterval: 60_000 });
  const config = modules.data?.modules.find(m => m.blueprint.id === module)?.config;
  const assigned = config?.agent_ids ?? [];
  const candidates = config ? agents.data?.filter(a => (!assigned.length || assigned.includes(a.id)) && (!keys.data || keys.data.some(k => k.id === a.api_key_id && k.status === 'active' && k.scopes.includes(`${module}.work`)))) : undefined;
  return { candidates, assigned };
}
/**
 * The agents' work of `module` that waits, by the kind of work an agent's key must hold to take it
 * (`jt_app::usecases::wake::Need`): the content page's counts the files in the analysis queue too.
 */
export function waitingByNeed(items: WorkItem[] | undefined, module: 'content' | 'social' | 'ads'): Partial<Record<NeedKey, number>> {
  const count = (keep: (item: WorkItem) => boolean) => (items ?? []).filter(keep).length;
  if (module === 'content') return { content: count(item => item.kind.startsWith('content_')), materials: count(item => item.kind === 'studio_material_analysis') };
  if (module === 'social') return { social: count(item => ['studio_slot', 'studio_post_request'].includes(item.kind) || (item.kind === 'studio_approval' && 'slot' in item.target)) };
  return { ads: count(item => item.kind.startsWith('ads_campaign_') || item.kind === 'studio_budget_move' || (item.kind === 'studio_approval' && 'budget_move' in item.target)) };
}

/**
 * What a module's page must know to work: one sentence about the agent when work waits for one
 * (what will happen, from the wake states: [`AgentWakeLine`]; without them, or when no agent may
 * take the work, the check-in rule of [`agentNotice`]), then what else stops the module. `extra`
 * adds work the page itself sees waiting for an agent (the social page's versions waiting for a
 * time, its contents being revised), by kind of work.
 */
export function ModuleStatusLine({ module, extra }: { module: 'content' | 'social' | 'ads'; extra?: Partial<Record<NeedKey, number>> }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const workspace = session.data?.current_workspace;
  const { candidates, assigned } = useModuleAgents(module);
  const wakes = useAgentWakes();
  const knowledge = useKnowledge();
  const budget = useQuery({ queryKey: ['budget-items', workspace], queryFn: listBudgetItems, enabled: module === 'ads' });
  const adAccounts = useQuery({ queryKey: ['capabilities', workspace, 'ads'], queryFn: () => listCapabilities({ group: 'ads' }), enabled: module === 'ads' });
  const work = useQuery({ queryKey: ['work', 'pending', workspace], queryFn: getPending, refetchInterval: 60_000 });
  const rows: { key: string; text: string; href: string }[] = [];
  const counts = waitingByNeed(work.data?.items, module);
  for (const [need, n] of Object.entries(extra ?? {}) as [NeedKey, number][]) counts[need] = (counts[need] ?? 0) + n;
  const waiting = work.data ? Object.values(counts).reduce((a, b) => a + (b ?? 0), 0) : undefined;
  // One sentence about the agent: the wake state's when some agent may take the work, else the check-in's.
  const wake = pickNeed(wakes.data, counts);
  const speaks = wake && wake.state.state !== 'no_agent' ? wake : null;
  const notice = !speaks && candidates ? agentNotice(t, i18n.language, waiting ?? 0, candidates) : null;
  if (notice) rows.push({ key: 'agent', text: notice, href: !candidates?.length && assigned.length ? `/modules/${module}` : '/agents' });
  // No card has text (design 2026-11-19 §4.5.1): no frame, so nothing is posted or spent yet.
  if (knowledge.data?.empty) rows.push({ key: 'knowledge', text: t('moduleStatus.knowledge'), href: '/knowledge' });
  if (module === 'ads') {
    // The paid lane is mirrored from Kurallar's ad budget (`ads::check_money` reads it): none, or
    // zero, and no campaign can spend.
    const general = budget.data?.find(b => b.item.general && b.item.kind === 'ad_budget' && !b.item.retired_at);
    const rules = knowledge.data?.rules;
    if (rules && !(rules.ad_cap && rules.ad_cap.amount_minor > 0)) rows.push({ key: 'paid', text: t('moduleStatus.paid'), href: '/knowledge#kurallar' });
    if (budget.data && !general) rows.push({ key: 'budget', text: t('moduleStatus.budget'), href: '/budget' });
    // The seed opens no ad spend: the general item starts at 0 and the owner raises it in Bütçe,
    // up to Kurallar's ad budget (design 2026-11-19 §4.3.2).
    else if (general && general.item.cap <= 0 && rules?.ad_cap && rules.ad_cap.amount_minor > 0) rows.push({ key: 'budget-zero', text: t('moduleStatus.budgetZero'), href: '/budget' });
    // A connection may read an ad account without being allowed to create ads in it (the
    // server's rule, `studio::chain::capability_access`): every plan is then refused.
    const connected = adAccounts.data?.filter(c => c.effective_status === 'verified' && c.capability.kind_key in AD_WRITE_SCOPES);
    const creates = (c: NonNullable<typeof connected>[number]) => {
      const needed = AD_WRITE_SCOPES[c.capability.kind_key];
      if (needed === null) return true;
      const scopes = (c.capability.connector_public.access as { scopes?: unknown } | undefined)?.scopes;
      return Array.isArray(scopes) && scopes.includes(needed);
    };
    if (connected?.length && !connected.some(creates)) rows.push({ key: 'ad-scope', text: t('moduleStatus.adScope'), href: '/capabilities' });
  }
  const line = speaks && <AgentWakeLine need={speaks.need} waiting={speaks.waiting} />;
  if (!rows.length) return line || null;
  const section = <section aria-label={t('moduleStatus.label')} className="space-y-1 border-s-2 border-warning bg-warning-subtle px-4 py-2 text-sm">{rows.map(row => <p key={row.key}><Link className="break-words underline underline-offset-4" to={row.href}>{row.text}</Link></p>)}</section>;
  return line ? <div className="space-y-2">{line}{section}</div> : section;
}
