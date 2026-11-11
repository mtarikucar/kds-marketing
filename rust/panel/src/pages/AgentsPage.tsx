import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { listAgents } from '@/api/agents';
import { listKeys, revokeKey } from '@/api/apiKeys';
import type { AgentConnectionOut, KeySummary } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { PermissionList } from '@/components/PermissionList';
import { QueryState } from '@/components/QueryState';
import { KeyStatusBadge } from '@/components/StatusBadges';
import { Badge, Button, ConfirmDialog, EmptyState, PageHeader, cn, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { can } from '@/lib/roles';
import { ConnectAgent, ConnectAgentDialog, KEYS_KEY } from './agents/keys';

/** Contact within this many minutes reads as recent; it is a record of contact, never an online claim. */
const RECENT_MINUTES = 15;

/**
 * One way into the workspace: a key and the agents that connected with it. `key` is absent for a
 * member who may not read keys; the agents then stand under the key's name alone.
 */
export interface Access {
  id: string;
  name: string;
  key: KeySummary | null;
  agents: AgentConnectionOut[];
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * Keys and connections as one list: every key with the agents that used it, and the agents of a
 * key the viewer cannot read under that key's name. The latest contact comes first, then the
 * newest key that nobody has used yet.
 */
export function accessesOf(keys: KeySummary[] | undefined, agents: AgentConnectionOut[]): Access[] {
  const byKey = new Map<string, Access>();
  for (const key of keys ?? []) byKey.set(key.id, { id: key.id, name: key.name, key, agents: [] });
  for (const agent of agents) {
    const access = byKey.get(agent.api_key_id)
      ?? { id: agent.api_key_id, name: agent.api_key_name, key: null, agents: [] };
    access.agents.push(agent);
    byKey.set(access.id, access);
  }
  const contact = (access: Access) => Math.max(0, ...access.agents.map(agent => time(agent.last_seen_at)));
  return [...byKey.values()]
    .map(access => ({ ...access, agents: [...access.agents].sort((a, b) => time(b.last_seen_at) - time(a.last_seen_at)) }))
    .sort((a, b) => contact(b) - contact(a) || time(b.key?.created_at) - time(a.key?.created_at) || a.name.localeCompare(b.name));
}

/** One connection. A revoked key's agent can no longer check in, so it carries no check-in state. */
function AgentLine({ agent, live }: { agent: AgentConnectionOut; live: boolean }) {
  const { t, i18n } = useTranslation();
  const minutes = (Date.now() - time(agent.last_seen_at)) / 60_000;
  const dot = !live ? 'bg-zinc-300 dark:bg-zinc-600' : agent.overdue ? 'bg-amber-500' : minutes <= RECENT_MINUTES ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600';
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden="true" />
      <span className="font-medium text-foreground">{agent.client_name}</span>
      <span className="font-mono text-caption text-muted-foreground" title={t('agents.protocol', { version: agent.protocol_version })}>
        {agent.client_version}
      </span>
      {live && (agent.overdue
        ? <Badge tone="danger" size="sm">{t('agents.overdue')}</Badge>
        : <Badge tone="success" size="sm">{t('agents.onTime')}</Badge>)}
      <span className="text-muted-foreground" title={formatDateTime(agent.last_seen_at, i18n.language)}>
        {t('agents.lastContact', { when: formatRelative(agent.last_seen_at, i18n.language) })}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {t('agents.toolCalls', { count: formatNumber(agent.tool_calls, i18n.language) })}
      </span>
      <span className="text-caption text-muted-foreground">
        {t('agents.firstSeen', { when: formatDateTime(agent.first_seen_at, i18n.language) })}
      </span>
    </li>
  );
}

function AccessRow({ access, onRevoke }: { access: Access; onRevoke?: (key: KeySummary) => void }) {
  const { t, i18n } = useTranslation();
  const { key, agents } = access;
  const revoked = key?.status === 'revoked';
  const [showPermissions, setShowPermissions] = useState(false);
  return (
    <li className={cn('flex flex-col gap-2 border-b border-border px-4 py-3 last:border-0', revoked && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">{access.name}</h3>
        {key && <span className="font-mono text-caption text-muted-foreground">{`${key.prefix}…`}</span>}
        {revoked && key && <KeyStatusBadge status={key.status} />}
        {key && (
          <span className="text-caption text-muted-foreground">
            {revoked && key.revoked_at
              ? t('agents.revokedAt', { when: formatDateTime(key.revoked_at, i18n.language) })
              : t('agents.issuedAt', { when: formatDateTime(key.created_at, i18n.language) })}
          </span>
        )}
        {key && (
          <span className="ms-auto flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" aria-expanded={showPermissions} onClick={() => setShowPermissions(open => !open)}>
              {t('agents.permissions', { count: key.scopes.length })}
              <ChevronDown className={cn('h-4 w-4 transition-transform', showPermissions && 'rotate-180')} aria-hidden="true" />
            </Button>
            {!revoked && onRevoke && (
              <Button variant="ghost" size="sm" onClick={() => onRevoke(key)}>
                {t('agents.revoke')}
              </Button>
            )}
          </span>
        )}
      </div>
      {agents.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label={t('agents.connected', { name: access.name })}>
          {agents.map(agent => <AgentLine key={agent.id} agent={agent} live={!revoked} />)}
        </ul>
      ) : revoked ? (
        <p className="text-sm text-muted-foreground">{t('agents.neverConnected')}</p>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">{t('agents.waiting')}</p>
          <details>
            <summary className="cursor-pointer text-primary underline underline-offset-4">{t('agents.howTo')}</summary>
            <div className="mt-3 max-w-2xl"><ConnectAgent showTitle={false} missingKey={t('agents.keyShownOnce')} /></div>
          </details>
        </div>
      )}
      {key && showPermissions && <PermissionList permissions={key.scopes} />}
    </li>
  );
}

/**
 * Agents and their keys as one thing: an agent gets in with a key issued here, so each row is a
 * key with whoever connected through it. Connecting an agent issues its key; removing its access
 * revokes the key. A member without `api_keys.manage` sees the agents under their keys' names.
 * `?connect=1` opens the connect dialog on arrival.
 */
export function AgentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const canManage = can(session.data, 'api_keys.manage');
  const [params, setParams] = useSearchParams();
  const agents = useQuery({ queryKey: ['agents'], queryFn: listAgents });
  const keys = useQuery({ queryKey: KEYS_KEY, queryFn: listKeys, enabled: canManage });
  const [connecting, setConnecting] = useState(() => params.get('connect') === '1');
  const [revoking, setRevoking] = useState<KeySummary | null>(null);

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
      toast.success(t('agents.revoked'));
      await queryClient.invalidateQueries({ queryKey: KEYS_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const accesses = accessesOf(canManage ? keys.data : undefined, agents.data ?? []);
  const live = accesses.filter(access => access.key?.status !== 'revoked');
  const revoked = accesses.filter(access => access.key?.status === 'revoked');
  const connect = canManage ? (
    <Button onClick={() => setConnect(true)}>
      <Plus className="h-4 w-4" aria-hidden="true" />
      {t('agents.connect')}
    </Button>
  ) : null;
  const list = (
    <>
      {live.length > 0 ? (
        <ul aria-label={t('agents.title')}>
          {live.map(access => <AccessRow key={access.id} access={access} onRevoke={canManage ? setRevoking : undefined} />)}
        </ul>
      ) : (
        <EmptyState
          className="rounded-none border-0"
          title={t('agents.empty')}
          description={canManage ? t('agents.emptyBody') : t('agents.emptyBodyReadOnly')}
          action={connect}
        />
      )}
      {revoked.length > 0 && (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground">
            {t('agents.revokedGroup', { count: revoked.length })}
          </summary>
          <ul aria-label={t('agents.revokedGroup', { count: revoked.length })}>
            {revoked.map(access => <AccessRow key={access.id} access={access} />)}
          </ul>
        </details>
      )}
    </>
  );

  return (
    <>
      <PageHeader title={t('agents.title')} description={t('agents.description')} actions={connect} />
      <QueryState query={agents}>
        {canManage ? <QueryState query={keys}>{list}</QueryState> : list}
      </QueryState>
      {canManage && connecting && <ConnectAgentDialog key={session.data?.current_workspace} open onOpenChange={setConnect} />}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('agents.revokeTitle')}
        description={revoking ? t('agents.revokeBody', { name: revoking.name }) : undefined}
        confirmLabel={t('agents.revoke')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </>
  );
}
