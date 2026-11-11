import { Bot, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AgentConnectionOut } from '@/api/types';
import type { WorkspaceModule } from '@/api/modules';
import { Button, cn } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { ActivationNotice } from '../modules/ActivationNotice';
import { moduleTone } from './agenda';
import type { HomeCopy } from './copy';

const SHOWN = 4;
/** Contact within this many minutes reads as recent; it is a record of contact, never an online claim. */
const RECENT_MINUTES = 15;

interface Props {
  copy: HomeCopy;
  active: boolean;
  agents: AgentConnectionOut[] | undefined;
  loading: boolean;
  installed: WorkspaceModule[];
  connectHref: string;
  canConnect: boolean;
  className?: string;
}

/** The compact agents strip: who is connected, when it last made contact, and where it works. */
export function AgentsCard({ copy, active, agents, loading, installed, connectHref, canConnect, className }: Props) {
  const language = copy.isTurkish ? 'tr' : 'en';
  const now = Date.now();
  return <section aria-labelledby="home-agents" className={cn('flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4', className)}>
    <div className="flex items-center justify-between gap-3">
      <h2 id="home-agents" className="flex items-center gap-2 text-sm font-medium"><Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{copy('agents')}
        {active && agents && <span className="text-xs tabular-nums text-muted-foreground">{agents.length}</span>}</h2>
      {active && <Button asChild size="sm" variant={agents?.length ? 'outline' : 'primary'}><Link to={connectHref}><Plus className="h-4 w-4" aria-hidden="true" />{canConnect ? copy('connect') : copy('manage')}</Link></Button>}
    </div>
    {!active ? <ActivationNotice />
      : loading ? <div className="h-10 animate-pulse rounded-md bg-surface-muted" />
      : !agents?.length ? <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{copy('noAgents')}</span> {copy('noAgentsBody')}</p>
      : <ul className="flex flex-col gap-1.5">
        {agents.slice(0, SHOWN).map(agent => {
          const assigned = installed.filter(module => module.config.agent_ids.includes(agent.id));
          const minutes = (now - new Date(agent.last_seen_at).getTime()) / 60_000;
          const when = formatRelative(agent.last_seen_at, language);
          const dot = agent.overdue ? 'bg-amber-500' : minutes <= RECENT_MINUTES ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600';
          return <li key={agent.id} className="flex min-w-0 items-center gap-2 text-sm">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden="true" />
            <span className="shrink-0 font-medium">{agent.client_name}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {agent.overdue ? copy('overdue', { when }) : copy('idle', { when })}
              {' · '}
              {assigned.length ? assigned.map((module, i) => <span key={module.blueprint.id}>{i > 0 && ', '}<span className={cn('me-1 inline-block h-1.5 w-1.5 rounded-full align-middle', moduleTone(module.blueprint.id).dot)} aria-hidden="true" />{module.blueprint.name}</span>) : copy('unassigned')}
            </span>
          </li>;
        })}
        {agents.length > SHOWN && <li><Link to="/agents" className="text-xs text-muted-foreground hover:text-foreground hover:underline">{copy('moreAgents', { n: agents.length - SHOWN })}</Link></li>}
      </ul>}
  </section>;
}
