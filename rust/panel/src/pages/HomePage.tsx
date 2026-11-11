import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listAgents } from '@/api/agents';
import { listLedger } from '@/api/ledger';
import { listTeam } from '@/api/team';
import type { Actor, LedgerEntryOut } from '@/api/types';
import { getPending } from '@/api/work';
import { useSession } from '@/auth/useSession';
import { moduleReady, moduleVisibleTo, useModules } from '@/lib/modules';
import { can, currentMembership } from '@/lib/roles';
import { useModuleCopy } from './modules/copy';
import { AgendaCalendar } from './home/AgendaCalendar';
import { AgentsCard } from './home/AgentsCard';
import type { Words } from './home/agenda';
import { useHomeCopy } from './home/copy';
import { WorkFeed } from './home/WorkFeed';

const LOG_SIZE = 30;

/**
 * The agent center: who is connected (top left), what waits and what happened (bottom left), and
 * the calendar of every module's actions (right). Modules live in the side navigation, not here.
 * Agent rows show recorded contact only, never an online claim.
 */
export function HomePage() {
  const moduleCopy = useModuleCopy();
  const copy = useHomeCopy();
  const { t, i18n } = useTranslation();
  const session = useSession();
  const me = session.data;
  const workspaceId = me?.current_workspace;
  const active = currentMembership(me)?.workspace_status === 'active';

  const agents = useQuery({ queryKey: ['agents', workspaceId], queryFn: listAgents, enabled: !!workspaceId && active });
  const registry = useModules();
  const pending = useQuery({ queryKey: ['home', 'pending', workspaceId], queryFn: getPending, enabled: !!workspaceId, retry: false });
  const ledger = useQuery({ queryKey: ['home', 'ledger', workspaceId], queryFn: () => listLedger({ limit: LOG_SIZE }), enabled: !!workspaceId && active, retry: false });
  const team = useQuery({ queryKey: ['home', 'team', workspaceId], queryFn: listTeam, enabled: !!workspaceId && active, retry: false });

  const installed = registry.data?.modules.filter(module => module.installed && moduleVisibleTo(module, me)) ?? [];
  // A locked module (its capability not connected) has nothing to put on the calendar.
  const visible = new Set(installed.filter(module => moduleReady(registry.data, module.blueprint.id)).map(module => module.blueprint.id));
  const names = new Map([...(registry.data?.catalog ?? []), ...installed.map(module => module.blueprint)].map(b => [b.id, b.name]));
  const moduleName = (id: string) => names.get(id) ?? id;

  const agentName = (connectionId: string) => agents.data?.find(agent => agent.id === connectionId)?.client_name ?? copy('agent');
  const member = (userId: string | null) => {
    if (!userId) return copy('nobody');
    if (userId === me?.user_id) return copy('you');
    const row = team.data?.find(m => m.user_id === userId);
    return row?.display_name || row?.email || copy('member');
  };
  const actor = (a: Actor) => a.kind === 'human' ? member(a.user_id) : a.kind === 'agent' ? agentName(a.connection_id) : copy('system');
  const words: Words = {
    published: format => copy('published', { format }), toPublish: format => copy('toPublish', { format }),
    preparing: format => copy('preparing', { format }), ready: format => copy('ready', { format }),
    dropped: format => copy('dropped', { format }),
    format: format => format ? t(`posts.format.${format}`) : t('posts.format.feed_post'),
    call: call => copy('callTo', { purpose: copy(call.purpose), who: call.counterpart }),
    campaign: name => copy('campaign', { name }),
    actor, member, rep: ext => copy('rep', { ext }),
    moduleAgent: id => {
      const assigned = installed.find(module => module.blueprint.id === id)?.config.agent_ids ?? [];
      const found = assigned.map(agentId => agents.data?.find(agent => agent.id === agentId)?.client_name).filter(Boolean);
      return found.length ? found.join(', ') : copy('agent');
    },
  };
  const today = new Intl.DateTimeFormat(copy.isTurkish ? 'tr-TR' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const canConnect = can(me, 'api_keys.manage');

  return <div className="flex min-w-0 flex-col [overflow-wrap:anywhere] lg:h-[calc(100dvh-61px)] lg:min-h-[38rem]">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
      <h1 className="font-display text-xl font-medium">{moduleCopy('center')}</h1>
      <span className="text-sm text-muted-foreground">{today}</span>
    </div>
    <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
      <AgentsCard className="rounded-none border-0 border-b lg:col-start-1 lg:row-start-1 lg:border-e" copy={copy} active={active} agents={agents.data} loading={agents.isLoading}
        installed={installed} canConnect={canConnect} connectHref={canConnect ? '/api-keys' : '/agents'} />
      <WorkFeed className="max-h-[32rem] rounded-none border-0 border-b lg:col-start-1 lg:row-start-2 lg:max-h-none lg:border-b-0 lg:border-e" copy={copy} pending={pending.data?.items}
        log={ledger.data} logAvailable={active && !ledger.isError} moduleName={moduleName}
        actorName={(row: LedgerEntryOut) => actor(row.entry.actor)} />
      <AgendaCalendar className="min-h-[24rem] rounded-none border-0 lg:col-start-2 lg:row-span-2 lg:row-start-1" copy={copy} active={active}
        modules={visible} moduleName={moduleName} words={words} key={i18n.language} />
    </div>
  </div>;
}
