import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ChevronLeft, Settings } from 'lucide-react';
import type { AccountDetail, SocialAccount } from '@/api/social';
import { useSession } from '@/auth/useSession';
import { ModuleStatusLine } from '@/components/ModuleStatusLine';
import { QueryState } from '@/components/QueryState';
import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { Button, cn, EmptyState, IconButton } from '@/components/ui';
import { can } from '@/lib/roles';
import { WaitingChips } from '../content/WaitingStrip';
import { AccountRail } from './AccountRail';
import { AccountHeader } from './AccountHeader';
import { SettingsDialog } from './SettingsDialog';
import { TiktokDialog } from './TiktokDialog';
import { Revising } from './Revision';
import { Timeline, waitChips, waitingKinds } from './TimelineView';
import { useAccountDetails, useAccounts, usePackages, usePending, usePostsKey, usePostsRead } from './data';
import { isHome, legacyTarget, placeHref, useSocialPlace, type WaitKind } from './location';
import { buildTimeline } from './timeline';

function Body({ accounts, manage, files }: { accounts: SocialAccount[]; manage: boolean; files: boolean }) {
  const { t } = useTranslation();
  const [place, go] = useSocialPlace();
  const selected = accounts.find((a) => a.capability_id === place.account);
  // With one account, every account is that one: its numbers and pause show on the whole view.
  const shown = selected ?? (accounts.length === 1 ? accounts[0] : undefined);
  const ids = selected ? [selected.capability_id] : accounts.map((a) => a.capability_id);
  const detailQueries = useAccountDetails(ids, selected ? place.days ?? 30 : 30);
  const pending = usePending(true);
  const posts = usePostsRead(true);
  const postsKey = usePostsKey();
  const packages = usePackages(true);
  const details = useMemo(() => new Map<string, AccountDetail>(detailQueries.flatMap((q) => (q.data ? [[q.data.account.capability_id, q.data]] : []))), [detailQueries]);
  const scope = selected?.capability_id;
  const timeline = useMemo(
    () => buildTimeline({ details: [...details.values()], pending: pending.data, posts: posts.data?.posts, packages: packages.data, scope }),
    [details, pending.data, posts.data, packages.data, scope],
  );
  // The rail's dots: every account's waiting posts, from the pending work and the lists read.
  const everywhere = useMemo(
    () => buildTimeline({ details: [...details.values()], pending: pending.data, posts: posts.data?.posts }),
    [details, pending.data, posts.data],
  );
  const waits = new Map<string, number>();
  for (const p of [...everywhere.waiting.approvals, ...everywhere.waiting.tiktok, ...everywhere.waiting.failed]) waits.set(p.capability_id, (waits.get(p.capability_id) ?? 0) + 1);
  // An old `?slot=` link to a TikTok post to finish opens its posting screen, once.
  const opened = useRef<string | null>(null);
  const tiktokSlot = place.slot && everywhere.waiting.tiktok.some((p) => p.slot_id === place.slot) ? place.slot : null;
  useEffect(() => {
    if (tiktokSlot && !place.tiktok && opened.current !== tiktokSlot) {
      opened.current = tiktokSlot;
      go({ ...place, tiktok: tiktokSlot }, { replace: true });
    }
  }, [tiktokSlot, place, go]);
  const home = isHome(place);
  const detailsDone = detailQueries.every((q) => !q.isLoading);
  // The pending work answers only with an approved strategy: without one, nothing waits there.
  const ready = detailsDone && !pending.isLoading && !posts.isLoading && !packages.isLoading;
  const failedRead = [...detailQueries, packages].find((q) => q.isError);
  const status = {
    isLoading: !detailsDone && details.size === 0,
    isError: !!failedRead && details.size === 0,
    error: failedRead?.error,
    data: details.size ? details : undefined,
    refetch: () => Promise.all([...detailQueries, packages].filter((q) => q.isError).map((q) => q.refetch())),
  };
  const onFilter = (kind: WaitKind) => go({ ...place, filter: place.filter === kind ? undefined : kind, slot: undefined, version: undefined, view: place.account ? undefined : 'all' });
  // The phone's accounts screen says "Sizi bekleyenler" over the rail; a chip leads to the posts,
  // filtered as the timeline's chips filter: only when more than one kind waits.
  const railPick = (kind: WaitKind) => (waitingKinds(timeline).length > 1 ? onFilter(kind) : go({ view: 'all' }));
  const shownDetail = shown ? detailQueries[ids.indexOf(shown.capability_id)] : undefined;
  return (
    <div className="grid min-w-0 gap-5 md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[16.5rem_minmax(0,1fr)]">
      <aside className={cn('min-w-0 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:self-start md:overflow-y-auto', !home && 'max-md:hidden')}>
        <AccountRail accounts={accounts} place={place} waits={waits}
          top={ready && <WaitingChips chips={waitChips(t, timeline, place.filter, railPick)} className="mb-2 border-b border-border px-1 pb-3 md:hidden" />} />
      </aside>
      <div className={cn('min-w-0 space-y-4', home && 'max-md:hidden')}>
        <Link to={placeHref({})} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground md:hidden">
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          {t('socialAccounts.back')}
        </Link>
        {place.account && !selected && <p role="status" className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">{t('socialAccounts.unknownSelected')}</p>}
        {shown && shownDetail && <AccountHeader account={shown} detail={shownDetail} place={place} go={go} manage={manage} posts={posts} postsKey={postsKey} />}
        <QueryState query={status} keepOnError>
          {failedRead && details.size > 0 && (
            <p role="alert" className="flex flex-wrap items-center gap-2 rounded-md bg-danger-subtle px-3 py-2 text-sm">
              {t('socialAccounts.partialRead')}
              <Button size="sm" variant="outline" onClick={() => void status.refetch()}>{t('common.retry')}</Button>
            </p>
          )}
          {details.size > 0 && (
            <Timeline data={timeline} accounts={accounts} posts={posts.data} details={details} place={place} go={go} onFilter={onFilter} manage={manage} files={files} ready={ready}
              revising={<Revising scope={scope} posts={posts.data} />} />
          )}
        </QueryState>
      </div>
    </div>
  );
}

/**
 * Sosyal medya: one page for the connected accounts and their posts (the content page's sibling,
 * design 2026-11-18). The accounts on the left, only what needs a person under "Sizi
 * bekleyenler", every post as one row of one timeline, approvals and times given on the row,
 * the settings behind the gear as sentences.
 */
export function SocialPage() {
  const { t } = useTranslation();
  const session = useSession();
  const location = useLocation();
  const [place, go] = useSocialPlace();
  const allowed = can(session.data, 'social.work');
  const manage = can(session.data, 'social.manage');
  const files = can(session.data, 'materials.work');
  const accounts = useAccounts(allowed);
  const legacy = legacyTarget(location.search, location.hash);
  if (legacy) return <Navigate replace to={legacy} />;
  return (
    <div data-testid="social" className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <WorkspaceHeader
        scene="studio"
        title={t('modulePages.social')}
        actions={allowed && (
          <div className="flex items-center gap-2">
            <IconButton variant="outline" aria-label={t('posts.settings.title')} title={t('posts.settings.title')} onClick={() => go({ ...place, settings: true })}>
              <Settings className="h-4 w-4" />
            </IconButton>
            <Button asChild><Link to="/connect">{t('socialAccounts.connect')}</Link></Button>
          </div>
        )}
      />
      {!allowed ? <p role="alert">{t('studio.forbidden')}</p> : (
        <>
          <ModuleStatusLine module="social" />
          <QueryState query={accounts} keepOnError>
            {accounts.data && (accounts.data.length === 0
              ? <EmptyState title={t('socialAccounts.empty')} description={t('socialAccounts.emptyHelp')} />
              : <Body accounts={accounts.data} manage={manage} files={files} />)}
          </QueryState>
          {place.settings && <SettingsDialog accounts={accounts.data} />}
          {place.tiktok && <TiktokDialog id={place.tiktok} manage={manage} />}
        </>
      )}
    </div>
  );
}
