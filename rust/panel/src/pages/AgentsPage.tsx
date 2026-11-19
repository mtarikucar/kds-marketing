import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { listAgents } from '@/api/agents';
import { listKeys, revokeKey } from '@/api/apiKeys';
import { listLedger } from '@/api/ledger';
import { getPending } from '@/api/work';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, ConfirmDialog, EmptyState, PageHeader, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useModules } from '@/lib/modules';
import { can } from '@/lib/roles';
import { useAgentWakes, useNow } from '@/lib/wake';
import { AgentRow } from './agents/AgentRow';
import { useAgentCopy } from './agents/copy';
import { ConnectAgentDialog, KEYS_KEY } from './agents/keys';
import { agentsOf, groupCounts, type Agent, type Group } from './agents/model';
import { tabClass } from './prospects/PoolHeader';

/** How many of the agents' latest ledger entries an opened row looks through for its actions. */
const LEDGER_LOOK = 200;

type Filter = Exclude<Group, 'revoked'>;
const CHIPS: { group: Filter; label: 'chipWorking' | 'chipAttention' | 'chipUnused' }[] = [
  { group: 'attention', label: 'chipAttention' },
  { group: 'working', label: 'chipWorking' },
  { group: 'unused', label: 'chipUnused' },
];

/**
 * `/agents`: one row per agent, where an agent is an API key (its wake address, its schedule and
 * its connections all belong to the key). Each row says what the agent does and how it stands in
 * a sentence, with "Şimdi çalıştır" and its wake address on the row, and opens in place for the
 * rest. Agents not in use stand folded at the bottom; counted chips filter when there is more
 * than one group. Connecting an agent issues its key; removing its access revokes the key.
 * `?connect=1` opens the connect dialog on arrival.
 */
export function AgentsPage() {
  const copy = useAgentCopy();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const workspace = session.data?.current_workspace;
  const canKeys = can(session.data, 'api_keys.manage');
  const manage = can(session.data, 'team.manage');
  const canLedger = can(session.data, 'ledger.read');
  const [params, setParams] = useSearchParams();
  const connections = useQuery({ queryKey: ['agents'], queryFn: listAgents });
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: listKeys, enabled: canKeys });
  const wakes = useAgentWakes();
  const work = useQuery({ queryKey: ['work', 'pending', workspace], queryFn: getPending, refetchInterval: 60_000, enabled: !!workspace, retry: false });
  const modules = useModules();
  const [connecting, setConnecting] = useState(() => params.get('connect') === '1');
  const [revoking, setRevoking] = useState<Agent | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const ledger = useQuery({
    queryKey: ['agents', 'ledger', workspace],
    queryFn: () => listLedger({ actor_kind: 'agent', limit: LEDGER_LOOK }),
    enabled: canLedger && expanded !== null,
    retry: false,
    staleTime: 30_000,
  });
  const now = useNow(30_000);

  const setConnect = (open: boolean) => {
    setConnecting(open);
    if (!open) {
      // The agent that just got its key shows up as soon as it connects.
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      if (params.has('connect')) {
        const next = new URLSearchParams(params);
        next.delete('connect');
        setParams(next, { replace: true });
      }
    }
  };

  const revoke = useMutation({
    mutationFn: (id: string) => revokeKey(id),
    onSuccess: async () => {
      setRevoking(null);
      toast.success(copy('revoked'));
      await queryClient.invalidateQueries({ queryKey: KEYS_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const agents = agentsOf({
    keys: canKeys ? keys.data : undefined,
    connections: connections.data ?? [],
    wakes: wakes.data?.agents,
    items: work.data?.items,
    modules: modules.data?.modules,
    now,
  });
  const counts = groupCounts(agents);
  const groupsShown = CHIPS.filter((c) => counts[c.group] > 0);
  const chips = groupsShown.length > 1 ? groupsShown : [];
  const active = filter && counts[filter] > 0 ? filter : null;
  const inUse = agents.filter((a) => (active ? a.group === active : a.group === 'attention' || a.group === 'working'));
  const unused = agents.filter((a) => a.group === 'unused');
  const revoked = agents.filter((a) => a.group === 'revoked');

  const connect = canKeys ? (
    <Button onClick={() => setConnect(true)}>
      <Plus className="h-4 w-4" aria-hidden="true" />
      {copy('connect')}
    </Button>
  ) : null;
  const row = (agent: Agent) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      now={now}
      expanded={expanded === agent.id}
      onToggle={() => setExpanded((id) => (id === agent.id ? null : agent.id))}
      manage={manage}
      onRevoke={canKeys && agent.key && agent.group !== 'revoked' ? () => setRevoking(agent) : undefined}
      ledger={ledger.data}
    />
  );
  const fold = (label: string, list: Agent[], open: boolean, help?: string) => (
    <details className="group rounded-lg border border-border bg-surface" open={open || undefined}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">{label}</summary>
      <div className="space-y-2 border-t border-border p-2 sm:p-3">
        {help && <p className="px-1 text-caption text-muted-foreground">{help}</p>}
        {list.map(row)}
      </div>
    </details>
  );

  const list = agents.length === 0 ? (
    <EmptyState title={copy('empty')} description={canKeys ? copy('emptyBody') : copy('emptyBodyReadOnly')} action={connect} />
  ) : (
    <section aria-label={copy('listLabel')} className="min-w-0 space-y-3">
      {chips.length > 0 && (
        <div role="group" aria-label={copy('filterLabel')} className="flex flex-wrap gap-0.5">
          {chips.map((chip) => (
            <button key={chip.group} type="button" aria-pressed={active === chip.group} onClick={() => setFilter((f) => (f === chip.group ? null : chip.group))} className={tabClass(active === chip.group)}>
              {copy(chip.label)} <span className="ms-0.5 font-mono text-xs tabular-nums">{counts[chip.group]}</span>
            </button>
          ))}
        </div>
      )}
      {inUse.length > 0 && <div className="min-w-0 space-y-2">{inUse.map(row)}</div>}
      {!active && unused.length > 0 && fold(copy('unusedGroup', { n: unused.length }), unused, inUse.length === 0, copy('unusedHelp'))}
      {!active && revoked.length > 0 && fold(copy('revokedGroup', { n: revoked.length }), revoked, false)}
    </section>
  );

  return (
    <>
      <PageHeader title={copy('title')} description={copy('description')} actions={agents.length > 0 ? connect : null} />
      <QueryState query={connections}>
        {canKeys ? <QueryState query={keys}>{list}</QueryState> : list}
      </QueryState>
      {canKeys && connecting && <ConnectAgentDialog key={workspace} open onOpenChange={setConnect} />}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={copy('revokeTitle')}
        description={revoking ? copy('revokeBody', { name: revoking.name }) : undefined}
        confirmLabel={copy('revoke')}
        cancelLabel={copy('cancel')}
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </>
  );
}
