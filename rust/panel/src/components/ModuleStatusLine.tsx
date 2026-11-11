import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listAgents } from '@/api/agents';
import { listKeys } from '@/api/apiKeys';
import { listBudgetItems } from '@/api/budget';
import { listCapabilities } from '@/api/capabilities';
import { getStrategy } from '@/api/strategy';
import { getPending } from '@/api/work';
import { useSession } from '@/auth/useSession';
import { useModules } from '@/lib/modules';
import { can } from '@/lib/roles';
import { formatDateTime } from '@/lib/format';

/** The permission a connection must hold to create ads, by the kind of its ad account (the server's `studio::chain::write_scopes`); `null`: the platform's authorization names none (TikTok). */
const AD_WRITE_SCOPES: Record<string, string | null> = { meta_ads: 'ads_management', google_ads: 'https://www.googleapis.com/auth/adwords', linkedin_ads: 'rw_ads', tiktok_ads: null };
export function ModuleStatusLine({ module }: { module: 'content' | 'social' | 'ads' }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const workspace = session.data?.current_workspace;
  const modules = useModules();
  const agents = useQuery({ queryKey: ['agents', workspace], queryFn: listAgents, refetchInterval: 60_000 });
  // Connections outlive revoked keys. Where key metadata is readable, exclude those connections.
  const keys = useQuery({ queryKey: ['api-keys', workspace], queryFn: listKeys, enabled: can(session.data, 'api_keys.manage'), refetchInterval: 60_000 });
  const strategy = useQuery({ queryKey: ['strategy', workspace], queryFn: getStrategy });
  const budget = useQuery({ queryKey: ['budget-items', workspace], queryFn: listBudgetItems, enabled: module === 'ads' });
  const adAccounts = useQuery({ queryKey: ['capabilities', workspace, 'ads'], queryFn: () => listCapabilities({ group: 'ads' }), enabled: module === 'ads' });
  const work = useQuery({ queryKey: ['work', 'pending', workspace], queryFn: getPending, refetchInterval: 60_000 });
  const config = modules.data?.modules.find(m => m.blueprint.id === module)?.config;
  const assigned = config?.agent_ids ?? [];
  const candidates = agents.data?.filter(a => (!assigned.length || assigned.includes(a.id)) && (!keys.data || keys.data.some(k => k.id === a.api_key_id && k.status === 'active' && k.scopes.includes(`${module}.work`))));
  const rows: { key: string; text: string; href: string }[] = [];
  if (config && candidates && !candidates.length) rows.push({ key: 'no-agent', text: t('moduleStatus.noAgent'), href: assigned.length ? `/modules/${module}` : '/agents' });
  const waiting = work.data?.items.filter(item => module === 'content' ? item.kind.startsWith('content_') : module === 'social' ? ['studio_slot', 'studio_post_request'].includes(item.kind) || (item.kind === 'studio_approval' && 'slot' in item.target) : item.kind.startsWith('ads_campaign_') || item.kind === 'studio_budget_move' || (item.kind === 'studio_approval' && 'budget_move' in item.target)).length;
  for (const agent of candidates ?? []) {
    if (agent.overdue && waiting !== undefined) rows.push({ key: agent.id, text: t('moduleStatus.overdue', { time: formatDateTime(agent.last_seen_at, i18n.language), n: waiting }), href: '/agents' });
  }
  if (strategy.data && !strategy.data.approved) rows.push({ key: 'strategy', text: t('moduleStatus.strategy'), href: '/strategy' });
  // The posting engine takes a post only for a live hypothesis with an organic cadence above zero
  // posts a week (`studio::posts::content_types`); a strategy without one posts nothing.
  if (module === 'social' && strategy.data?.approved && !strategy.data.approved.hypotheses.some(h => h.state !== 'retired' && (h.cadence.organic?.slots_per_week ?? 0) > 0 && h.cadence.organic?.content_types.some(c => c.max_bps > 0))) rows.push({ key: 'no-posting', text: t('moduleStatus.noPosting'), href: '/strategy' });
  if (module === 'ads') {
    // The server's own rule (`ads::check_money`): paid is on and the strategy has a paid lane in
    // the general ad budget's currency. Which channels the strategy names does not matter.
    const general = budget.data?.find(b => b.item.general && b.item.kind === 'ad_budget' && !b.item.retired_at);
    const currency = general?.item.unit.kind === 'currency' ? general.item.unit.value : undefined;
    const sections = strategy.data?.approved?.sections;
    if (sections && !(sections.paid_enabled && sections.budget_frame.lanes.some(l => l.lane === 'paid' && (!currency || l.currency === currency)))) rows.push({ key: 'paid', text: t('moduleStatus.paid'), href: '/strategy' });
    if (budget.data && !general) rows.push({ key: 'budget', text: t('moduleStatus.budget'), href: '/budget' });
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
  if (!rows.length) return null;
  return <section aria-label={t('moduleStatus.label')} className="space-y-2 border-s-2 border-warning bg-warning-subtle px-4 py-3 text-sm">{rows.map(row => <p key={row.key}><Link className="break-words underline underline-offset-4" to={row.href}>{row.text}</Link></p>)}</section>;
}
