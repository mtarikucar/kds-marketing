import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { LedgerEntryOut, NeedKey } from '@/api/types';
import { PermissionList } from '@/components/PermissionList';
import { Button, cn } from '@/components/ui';
import { formatDateTime, formatNumber, formatRelative, formatWhen } from '@/lib/format';
import { capitalise } from '@/lib/wake';
import { useHomeCopy } from '../home/copy';
import { useAgentCopy, type AgentCopyKey } from './copy';
import { ConnectAgent } from './keys';
import type { Agent } from './model';
import { RunNowButton, WakeForm, WakeLine } from './wake';
import { doesText, stateText } from './words';

/** How many of its latest actions an opened agent lists. */
const RECENT = 3;
/** Ledger actions that say nothing a person needs: every tool call, every check-in, the first contact. */
const QUIET = new Set(['mcp.tool_call', 'work.checkin', 'agent.connected']);

const NEED_WORD: Record<NeedKey, AgentCopyKey> = {
  content: 'needContent', materials: 'needMaterials', social: 'needSocial', ads: 'needAds', research: 'needResearch', inbox: 'needInbox',
};

/** A group of the opened row: a small heading and what it says. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      <div className="text-sm [overflow-wrap:anywhere]">{children}</div>
    </section>
  );
}

/** The agent's latest actions in words, from the ledger's agent entries; nothing when none is worded. */
function Recent({ agent, ledger }: { agent: Agent; ledger: LedgerEntryOut[] | undefined }) {
  const home = useHomeCopy();
  const copy = useAgentCopy();
  if (!ledger) return null;
  const ids = new Set(agent.connections.map((c) => c.id));
  const lines: { id: number; at: string; text: string }[] = [];
  for (const { id, entry } of ledger) {
    if (lines.length >= RECENT) break;
    if (entry.actor.kind !== 'agent' || !ids.has(entry.actor.connection_id) || QUIET.has(entry.action)) continue;
    const text = home.action(entry.action, entry.payload);
    if (text) lines.push({ id, at: entry.at, text });
  }
  if (!lines.length) return null;
  return (
    <Group title={copy('recentTitle')}>
      <ul className="space-y-0.5">
        {lines.map((line) => (
          <li key={line.id}><span className="tabular-nums text-muted-foreground">{formatWhen(line.at, copy.language)}</span> · {line.text}</li>
        ))}
      </ul>
    </Group>
  );
}

/** The opened row: what it does exactly, the work waiting, its latest actions, the key and its connections. */
function Details({ agent, ledger, onRevoke }: { agent: Agent; ledger: LedgerEntryOut[] | undefined; onRevoke?: () => void }) {
  const copy = useAgentCopy();
  const { i18n } = useTranslation();
  const lang = copy.language;
  const { key, connections } = agent;
  const [live, ...earlier] = connections;
  const waiting = Object.entries(agent.waiting ?? {}).filter(([, n]) => (n ?? 0) > 0) as [NeedKey, number][];
  const line = (c: typeof live) => copy('connectionLine', { client: c.client_name, version: c.client_version, when: formatRelative(c.last_seen_at, lang) });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="min-w-0 space-y-4">
        {key && (
          <Group title={copy('doesTitle')}>
            <p>{doesText(copy, key.scopes)}</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground">{copy('permissionsFold', { n: key.scopes.length })}</summary>
              <div className="mt-2"><PermissionList permissions={key.scopes} /></div>
            </details>
          </Group>
        )}
        {waiting.length > 0 && (
          <Group title={copy('waitingTitle')}>
            <p>{waiting.map(([need, n]) => `${capitalise(copy(NEED_WORD[need]), lang)}: ${formatNumber(n, i18n.language)}`).join(' · ')}</p>
          </Group>
        )}
        <Recent agent={agent} ledger={ledger} />
      </div>
      <div className="min-w-0 space-y-4">
        {live ? (
          <Group title={copy('connectionTitle')}>
            <p title={formatDateTime(live.last_seen_at, lang)}>{line(live)}</p>
            <p className="text-caption text-muted-foreground">{copy('toolCalls', { n: formatNumber(live.tool_calls, i18n.language) })}</p>
            {earlier.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground">{copy('earlier', { n: earlier.length })}</summary>
                <ul className="mt-1 space-y-0.5 text-caption text-muted-foreground">
                  {earlier.map((c) => <li key={c.id} title={formatDateTime(c.last_seen_at, lang)}>{line(c)}</li>)}
                </ul>
              </details>
            )}
          </Group>
        ) : agent.group !== 'revoked' ? (
          <Group title={copy('howTo')}>
            <ConnectAgent missingKey={copy('keyShownOnce')} />
          </Group>
        ) : null}
        {key && (
          <Group title={copy('keyTitle')}>
            <p className="text-muted-foreground"><span className="font-mono text-caption">{key.prefix}…</span> · {copy('keyIssued', { when: formatDateTime(key.created_at, lang) })}</p>
          </Group>
        )}
        {onRevoke && <Button size="sm" variant="ghost" className="-ms-3 text-danger hover:text-danger" onClick={onRevoke}>{copy('revoke')}</Button>}
      </div>
    </div>
  );
}

/**
 * One agent as one row: its name, what it does, its state in a sentence; "Şimdi çalıştır" or
 * "Hemen çağrılabilsin" at the end; its wake address as one line under it. Opening it shows the
 * rest in place. `manage`: `team.manage` (the wake address); `onRevoke`: `api_keys.manage`.
 */
export function AgentRow({ agent, now, expanded, onToggle, manage, onRevoke, ledger }: {
  agent: Agent;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  manage: boolean;
  onRevoke?: () => void;
  ledger: LedgerEntryOut[] | undefined;
}) {
  const copy = useAgentCopy();
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const panel = `agent-${agent.id}-detail`;
  const { wake, key } = agent;
  const live = agent.group !== 'revoked';
  const refused = !!wake?.address?.refused_at;
  const dot = agent.attention ? 'bg-danger' : agent.presence.kind === 'working' ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600';
  const state = stateText(copy, t, agent, now);
  // Work waits and the agent stays away: the sentence asks a person to look, whatever else is wrong.
  const stays = live && agent.group !== 'unused' && agent.waitingTotal > 0 && ['late', 'away', 'never'].includes(agent.presence.kind);
  return (
    <article aria-label={agent.name} data-testid="agent-row" className={cn('min-w-0 rounded-lg border bg-surface shadow-xs', agent.attention ? 'border-danger/50' : 'border-border', !live && 'bg-surface/60')}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panel}
          aria-label={copy('open', { name: agent.name })}
          aria-describedby={state ? `${panel}-state` : undefined}
          onClick={onToggle}
          className="-m-1 flex min-w-[14rem] flex-1 items-start gap-2.5 rounded-md p-1 text-start hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden="true" className={cn('mt-2 h-2 w-2 shrink-0 rounded-full', dot)} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={cn('block font-medium [overflow-wrap:anywhere]', !live && 'text-muted-foreground')}>{agent.name}</span>
            {key && live && <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{doesText(copy, key.scopes)}</span>}
            {state && <span id={`${panel}-state`} className={cn('text-sm [overflow-wrap:anywhere]', stays ? 'font-medium text-danger' : 'text-foreground')}>{state}</span>}
          </span>
          <ChevronDown aria-hidden="true" className={cn('mt-0.5 h-5 w-5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
        </button>
        {live && (
          <div className="ms-auto flex min-w-0 max-w-full flex-wrap items-start justify-end gap-2">
            {wake && !refused && <RunNowButton wake={wake} now={now} />}
            {wake && !wake.address && manage && !editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{copy('wakeNone')}</Button>
            )}
            {agent.group === 'unused' && onRevoke && <Button size="sm" variant="ghost" onClick={onRevoke}>{copy('revoke')}</Button>}
          </div>
        )}
      </div>
      {live && wake && (wake.address || editing) && (
        <div className="space-y-2 px-3 pb-3 ps-8 sm:px-4 sm:ps-9">
          {!editing && <WakeLine wake={wake} manage={manage} onEdit={() => setEditing(true)} />}
          {manage && editing && <WakeForm apiKeyId={agent.id} name={agent.name} initial={wake.address?.kind ?? 'claude_routine'} onDone={() => setEditing(false)} />}
        </div>
      )}
      {expanded && (
        <div id={panel} className="border-t border-border bg-surface-muted/40 px-3 py-4 sm:px-4">
          <Details agent={agent} ledger={ledger} onRevoke={live && agent.group !== 'unused' ? onRevoke : undefined} />
        </div>
      )}
    </article>
  );
}
