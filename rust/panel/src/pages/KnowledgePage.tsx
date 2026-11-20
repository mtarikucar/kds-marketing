import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { KnowledgeOut } from '@/api/knowledge';
import { useSession } from '@/auth/useSession';
import { AgentWakeLine } from '@/components/AgentWakeLine';
import { Button, Callout, PageHeader, Skeleton } from '@/components/ui';
import { can } from '@/lib/roles';
import { Cards } from './knowledge/Cards';
import { GoalsBox } from './knowledge/GoalsBox';
import { Learned } from './knowledge/Learned';
import { NoteComposer } from './knowledge/NoteComposer';
import { Proposals } from './knowledge/Proposals';
import { RulesBox } from './knowledge/RulesBox';
import { useKnowledge } from './knowledge/queries';

/** Loading: the composer's place, two box skeletons and six card skeletons (§4.11 States). */
function Loading() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t('common.loading')} className="flex flex-col gap-5">
      <Skeleton className="h-14 w-full rounded-xl" />
      <div className="flex flex-wrap gap-3.5">
        <Skeleton className="h-40 min-w-0 flex-[1_1_22rem] rounded-xl" />
        <Skeleton className="h-40 min-w-0 flex-[1_1_18rem] rounded-xl" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
    </div>
  );
}

/** Whether the system's own proposals wait (seeding found texts never applied, §4.3.1). */
function systemProposalsWait(data: KnowledgeOut): boolean {
  return data.proposals.some((p) => !p.proposed_by || p.proposed_by.kind === 'system');
}

/** The callout of an empty knowledge base (no card has text): start with "Biz kimiz", or add what waits. */
function EmptyCallout({ data }: { data: KnowledgeOut }) {
  const { t } = useTranslation();
  if (systemProposalsWait(data)) {
    return (
      <Callout tone="info">
        <p>
          {t('knowledge.empty.proposals')}{' '}
          <a className="font-medium text-primary underline underline-offset-4" href="#oneriler">{t('knowledge.empty.toProposals')}</a>
        </p>
      </Callout>
    );
  }
  return (
    <Callout tone="info">
      <p>{t('knowledge.empty.callout')}</p>
    </Callout>
  );
}

/** Scrolls to the box an address names (`#kurallar`, `#hedefler`, `#oneriler`) once it is drawn. */
function useHashTarget(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView({ block: 'start' });
  }, [ready, hash]);
}

/**
 * Bilgi bankası (`/knowledge`, design 2026-11-19 §4.11): what the agents know about the business,
 * in one column, no tabs. The owner's edits apply at once. Address: `card={id}` opens a card's
 * editor (`new` a new card), `history={card id}` its history; `#kurallar`, `#hedefler` and
 * `#oneriler` scroll to their box.
 */
export function KnowledgePage() {
  const { t } = useTranslation();
  const session = useSession();
  const editable = can(session.data, 'team.manage');
  // Agents file notes, propose and derive while the page is open: it reads again on its own.
  const knowledge = useKnowledge({ live: true });
  const [params, setParams] = useSearchParams();
  const [autoClosed, setAutoClosed] = useState(false);
  const data = knowledge.data;
  useHashTarget(!!data);

  const set = (key: 'card' | 'history', value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  // An empty knowledge base opens "Biz kimiz" for the owner, unless older texts wait as proposals.
  const whoWeAre = data?.cards.find((c) => c.key === 'who_we_are');
  const autoOpen = !!data && data.empty && editable && !autoClosed && !systemProposalsWait(data) ? whoWeAre?.id ?? null : null;
  const openId = params.get('card') ?? autoOpen;

  const openNotes = data?.notes.filter((n) => n.status === 'open').length ?? 0;
  const due = data?.frame?.derive_due.length ?? 0;

  return (
    <>
      <PageHeader title={t('knowledge.title')} description={t('knowledge.description')} />
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5">
        <AgentWakeLine need="knowledge" waiting={openNotes + due} />
        {!editable && <p className="text-sm text-muted-foreground">{t('knowledge.readOnly')}</p>}
        {knowledge.isLoading && <Loading />}
        {knowledge.isError && !data && (
          <Callout tone="danger">
            <p>{t('knowledge.loadError')}</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => void knowledge.refetch()}>{t('common.retry')}</Button>
          </Callout>
        )}
        {data && (
          <>
            {data.empty && <EmptyCallout data={data} />}
            <NoteComposer reach={data.notes_agent} notes={data.notes} cards={data.cards} editable={editable} />
            <div className="flex flex-wrap gap-3.5">
              <RulesBox rules={data.rules} editable={editable} />
              <GoalsBox goals={data.goals} editable={editable} />
            </div>
            <Cards
              cards={data.cards}
              editable={editable}
              openId={openId}
              onOpen={(id) => {
                if (!id) setAutoClosed(true);
                set('card', id);
              }}
              historyId={params.get('history')}
              onHistory={(id) => set('history', id)}
            />
            <Proposals proposals={data.proposals} cards={data.cards} editable={editable} />
            <Learned />
          </>
        )}
      </div>
    </>
  );
}
