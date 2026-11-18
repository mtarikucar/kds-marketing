import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { Bot, Inbox } from 'lucide-react';
import { analysisQueue, GENEL, type QueueItem, type QueueStage, type TreeOut } from '@/api/content';
import { listAgents } from '@/api/agents';
import { listKeys } from '@/api/apiKeys';
import * as m from '@/api/materials';
import type { AgentConnectionOut, KeySummary } from '@/api/types';
import { getPending } from '@/api/work';
import { useSession } from '@/auth/useSession';
import { Badge, Button, ConfirmDialog, EmptyState } from '@/components/ui';
import { QueryState } from '@/components/QueryState';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';
import { fieldClass, MaterialPreview, materialLabel, MaterialsError, useDecider, useMaterialsMutation } from '../materials/MaterialsShared';
import { placeHref, useContentKey, useContentPlace } from './location';

const TONE: Record<QueueStage, 'neutral' | 'info' | 'warning' | 'danger'> = {
  waiting: 'neutral',
  analysing: 'info',
  needs_filing: 'warning',
  failed: 'danger',
};

/** A person files an analysed upload nobody filed: an olay of the tree, or Genel (`studio.material_bind`). */
function FileInto({ item, tree }: { item: QueueItem; tree: TreeOut }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState('');
  const bind = useMaterialsMutation(() =>
    m.materialBind(item.material.id, item.material.revision, target === GENEL ? { kind: 'genel' } : { kind: 'olay', olay_id: target }),
  );
  const label = `${t('content.queue.fileInto')} · ${materialLabel(t, item.material)}`;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (target && !bind.isPending) bind.mutate(undefined);
      }}
    >
      <select aria-label={label} className={`${fieldClass} w-auto min-w-[12rem] flex-1`} value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{t('content.queue.choose')}</option>
        {tree.olays.map((o) => <option key={o.olay.id} value={o.olay.id}>{o.olay.title}</option>)}
        <option value={GENEL}>{t('content.genel')}</option>
      </select>
      <Button type="submit" size="sm" disabled={!target} loading={bind.isPending}>{t('content.queue.file')}</Button>
      <div className="basis-full empty:hidden"><MaterialsError error={bind.error} /></div>
    </form>
  );
}

/** Erases an upload nobody could place, as the file drawer erases a file (`studio.material_delete`). */
function Erase({ item }: { item: QueueItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const remove = useMaterialsMutation(() => m.materialDelete(item.material.id, item.material.revision), () => setOpen(false));
  return (
    <>
      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setOpen(true)}>{t('content.queue.erase')}</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !remove.isPending && setOpen(next)}
        title={t('materials.editor.deleteTitle')}
        description={t('materials.editor.deleteKvkk')}
        confirmLabel={t('materials.editor.deleteConfirm')}
        cancelLabel={t('materials.editor.deleteCancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => { if (!remove.isPending) remove.mutate(undefined); }}
      />
      <MaterialsError error={remove.error} />
    </>
  );
}

/**
 * When an agent that can analyse files was last seen and when the next one is expected by the
 * workspace's check-in interval, in one line; that it is late when it is. The agents are those
 * whose key may work the library (`materials.work`) when the keys can be read, else every agent.
 * No time is given that cannot be derived: with no sighting, none; with no interval, no next.
 */
export function analysisAgentLine(
  t: TFunction,
  language: string,
  agents: Pick<AgentConnectionOut, 'api_key_id' | 'last_seen_at'>[],
  keys: Pick<KeySummary, 'id' | 'status' | 'scopes'>[] | undefined,
  interval: number | undefined,
  now = Date.now(),
): string {
  const able = agents.filter((a) => !keys || keys.some((k) => k.id === a.api_key_id && k.status === 'active' && k.scopes.includes('materials.work')));
  const last = able.map((a) => Date.parse(a.last_seen_at)).filter((at) => !Number.isNaN(at)).sort((a, b) => a - b).at(-1);
  if (last === undefined) return t('content.queue.agent.none');
  const seen = formatDateTime(new Date(last).toISOString(), language);
  if (!interval) return t('content.queue.agent.seen', { last: seen });
  const next = last + interval * 60_000;
  const expected = formatDateTime(new Date(next).toISOString(), language);
  return now > next ? t('content.queue.agent.overdue', { last: seen, next: expected }) : t('content.queue.agent.next', { last: seen, next: expected });
}

function Retry({ item }: { item: QueueItem }) {
  const { t } = useTranslation();
  const retry = useMaterialsMutation(() => m.materialAnalysisRetry(item.material.id, item.material.revision));
  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" loading={retry.isPending} onClick={() => retry.mutate(undefined)}>{t('materials.intelligence.retry')}</Button>
      <MaterialsError error={retry.error} />
    </div>
  );
}

/**
 * "Analiz sırası": what was uploaded and is not yet in a folder, or whose analysis waits or runs,
 * oldest first, each with where it is. With no agent connected a file simply waits; the page says
 * so from the agent check-in. An analysed upload nobody filed is filed here by a person.
 */
export function QueueView({ tree }: { tree: TreeOut }) {
  const { t, i18n } = useTranslation();
  const key = useContentKey();
  const decider = useDecider();
  const [place] = useContentPlace();
  const session = useSession();
  const workspace = session.data?.current_workspace;
  const queue = useQuery({ queryKey: [...key, 'queue'], queryFn: analysisQueue, refetchInterval: 15_000 });
  const work = useQuery({ queryKey: ['work', 'pending', workspace], queryFn: getPending, refetchInterval: 60_000, retry: false });
  const agents = useQuery({ queryKey: ['agents', workspace], queryFn: listAgents, refetchInterval: 60_000, retry: false });
  const keys = useQuery({ queryKey: ['api-keys', workspace], queryFn: listKeys, enabled: can(session.data, 'api_keys.manage'), refetchInterval: 60_000 });
  const items = queue.data?.items ?? [];
  const agent = work.data?.agent;
  // Files an agent has yet to analyse: the line says when one was seen and is next expected.
  const waiting = items.filter((i) => i.stage === 'waiting').length;
  // The agents and their keys when the session may read them, else the workspace's check-in.
  const sightings = agents.data ?? (agent ? (agent.last_seen_at ? [{ api_key_id: '', last_seen_at: agent.last_seen_at }] : []) : undefined);
  const line1 = waiting > 0 && sightings ? analysisAgentLine(t, i18n.language, sightings, agents.data ? keys.data : undefined, agent?.interval_minutes) : null;
  const noAgent = !!sightings && !sightings.length;
  const late = noAgent || !!agent?.overdue;
  const line = (item: QueueItem) => {
    if (item.stage === 'waiting' && noAgent) return t('content.queue.line.noAgent');
    if (item.stage === 'needs_filing') return t('content.queue.line.needs_filing');
    if (item.stage === 'failed') return t('content.queue.line.failed');
    return t(`content.queue.line.${item.stage}${item.unfiled ? '' : 'Filed'}`);
  };
  return (
    <section aria-label={t('content.queue.title')} className="min-w-0 space-y-5">
      <header className="flex items-start gap-3">
        <Inbox aria-hidden="true" className="h-9 w-9 shrink-0 text-muted-foreground" strokeWidth={1.3} />
        <div className="min-w-0">
          <h2 className="text-xl font-medium">{t('content.queue.title')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('content.queue.help')}</p>
        </div>
      </header>
      {line1 && (
        <p role="status" className={`flex items-center gap-2 border-s-2 px-4 py-2 text-sm ${late ? 'border-warning bg-warning-subtle' : 'border-border bg-surface-muted'}`}>
          <Bot aria-hidden="true" className={`h-4 w-4 shrink-0 ${late ? 'text-warning' : 'text-muted-foreground'}`} />
          <Link className="min-w-0 underline underline-offset-4" to="/agents">{line1}</Link>
        </p>
      )}
      <QueryState query={queue} keepOnError>
        {queue.data && !items.length && <EmptyState title={t('content.queue.empty')} description={t('content.queue.emptyHelp')} />}
        {items.length > 0 && (
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {items.map((item) => (
              <li key={item.material.id} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto]">
                <Link to={placeHref({ ...place, file: item.material.id })} aria-label={materialLabel(t, item.material)} className="h-11 w-11 overflow-hidden rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_img]:h-11 [&_img]:object-cover [&_span]:h-11 [&_video]:h-11 [&_.text-xs]:hidden">
                  <MaterialPreview material={item.material} />
                </Link>
                <div className="min-w-0 space-y-1">
                  <Link to={placeHref({ ...place, file: item.material.id })} className="block truncate text-sm font-medium hover:underline">{materialLabel(t, item.material)}</Link>
                  <p className={`line-clamp-2 text-xs ${item.stage === 'needs_filing' ? 'font-medium text-warning' : 'text-muted-foreground'}`}>{line(item)}</p>
                  {item.stage === 'needs_filing' && item.intelligence.description && <p className="line-clamp-2 text-xs text-muted-foreground">{item.intelligence.description}</p>}
                  {item.stage === 'needs_filing' && item.unfiled && (decider
                    ? <div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1"><FileInto item={item} tree={tree} /></div><Erase item={item} /></div>
                    : <p className="text-xs text-muted-foreground">{t('content.queue.managerFiles')}</p>)}
                  {item.stage === 'failed' && <Retry item={item} />}
                </div>
                <span className="col-start-2 sm:col-start-auto"><Badge tone={TONE[item.stage]}>{t(`content.queue.stage.${item.stage}`)}</Badge></span>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
