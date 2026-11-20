import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AtSign, ChevronLeft, Image as ImageIcon, PauseCircle, Settings } from 'lucide-react';
import type { PostRow, PostsFilter } from '@/api/postsPage';
import { brake as brakeWrite } from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { Button, Callout, cn, IconButton, PageHeader, Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useModules } from '@/lib/modules';
import { can, canAny } from '@/lib/roles';
import { TiktokDialog } from './social/TiktokDialog';
import { AccountsSheet } from './posts/AccountsSheet';
import { AgentLine } from './posts/AgentLine';
import { Composer } from './posts/Composer';
import { DetailPanel, PanelSkeleton } from './posts/DetailPanel';
import { FilesDrawer } from './posts/FilesDrawer';
import { closedPlace, selectedRowId, usePostsPlace, withRow, type PostsPlace } from './posts/location';
import { Chips, PostsTable, TableSkeleton } from './posts/PostsTable';
import { useInvalidatePosts, useMedia, usePostDetail, usePosts } from './posts/queries';
import { SettingsSheet } from './posts/SettingsSheet';
import { SpecialDays } from './posts/SpecialDays';

/** Who may open the page (§2.1): any of the five permissions. */
export const POSTS_PERMISSIONS = ['content.work', 'content.manage', 'social.work', 'social.manage', 'materials.work'] as const;

/**
 * The row the address's `content=` names (§2.11): its `content` row, else its first waiting post,
 * else its next post, else its last published one, among the rows read.
 */
function contentRow(rows: PostRow[], area: string): PostRow | undefined {
  const of = rows.filter((r) => r.area_id === area);
  return of.find((r) => r.kind === 'content')
    ?? of.find((r) => r.waits.length > 0)
    ?? of.filter((r) => !r.published_at && r.publish_at).sort((a, b) => a.publish_at!.localeCompare(b.publish_at!))[0]
    ?? of.filter((r) => r.published_at).sort((a, b) => b.published_at!.localeCompare(a.published_at!))[0]
    ?? of[0];
}

/**
 * Paylaşımlar (`/posts`, design 2026-11-19 §2): one composer, chips, one table whose row is one
 * post, and a panel without tabs or step list beside it; everything else the content and social
 * pages offered is behind Dosyalar, Hesaplar and Ayarlar. The whole place is in the address.
 */
export function PostsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const modules = useModules();
  const [place, go] = usePostsPlace();
  const allowed = canAny(session.data, POSTS_PERMISSIONS);
  const desk = useMedia('(min-width: 1024px)');
  const phone = useMedia('(max-width: 639px)');
  const filter = place.f;
  const posts = usePosts(filter, allowed);
  const refresh = useInvalidatePosts();
  const [created, setCreated] = useState<PostRow | null>(null);
  const pages = posts.data?.pages ?? [];
  const first = pages[0];
  const listed = useMemo(() => pages.flatMap((p) => p.rows), [pages]);
  // The row the composer just made shows first until the read holds it.
  const rows = useMemo(() => (created && !listed.some((r) => r.id === created.id) && !filter ? [created, ...listed] : listed), [created, listed, filter]);

  // Selection: the address's row, resolved among the rows read; else, on a desk, the first row.
  const named = selectedRowId(place);
  const resolved = place.content ? contentRow(rows, place.content) : named ? rows.find((r) => r.id === named) : undefined;
  const fallback = desk && !named ? rows[0] : undefined;
  const detailId = resolved?.id ?? named ?? fallback?.id;
  const detail = usePostDetail(detailId);
  const selected: PostRow | undefined = resolved ?? (named ? detail.data?.row : undefined) ?? fallback;

  // A stage chip whose count dropped to 0 while chosen goes; the filter falls back to Tümü.
  useEffect(() => {
    if (!first || !filter || filter === 'you') return;
    if ((first.counts.stages[filter] ?? 0) === 0) go({ ...place, f: undefined }, { replace: true });
  }, [first, filter, place, go]);

  const resume = useMutation({
    mutationFn: () => brakeWrite(false, 'organic', first!.brake!.revision),
    onSuccess: refresh,
  });

  if (!allowed) {
    return (
      <>
        <PageHeader title={t('postsPage.title')} />
        <p role="alert">{t('postsPage.forbidden')}</p>
      </>
    );
  }

  const materialsWork = can(session.data, 'materials.work');
  const socialAny = canAny(session.data, ['social.work', 'social.manage']);
  const contentModule = modules.data?.modules.find((m) => m.blueprint.id === 'content');
  const contentInstalled = !!contentModule?.installed;
  const brake = first?.brake ?? null;
  const select = (row: { id: string }) => {
    go(withRow(closedPlace(place), row.id));
  };
  const setFilter = (f: PostsFilter | undefined) => go({ f }, { replace: true });
  const openAccounts = () => go({ ...closedPlace(place), accounts: true });
  const header = (
    <div className="flex items-center gap-2">
      {materialsWork && (
        <Button variant="outline" onClick={() => go({ ...closedPlace(place), files: true })}>
          <ImageIcon aria-hidden="true" className="h-4 w-4" />
          <span className="max-sm:sr-only">{t('postsPage.header.files')}</span>
        </Button>
      )}
      {socialAny && (
        <Button variant="outline" onClick={openAccounts}>
          <AtSign aria-hidden="true" className="h-4 w-4" />
          <span className="max-sm:sr-only">{t('postsPage.header.accounts')}</span>
        </Button>
      )}
      <IconButton variant="outline" aria-label={t('postsPage.header.settings')} title={t('postsPage.header.settings')} onClick={() => go({ ...closedPlace(place), settings: true })}>
        <Settings className="h-4 w-4" />
      </IconButton>
    </div>
  );

  const loading = posts.isLoading;
  const noRows = !!first && rows.length === 0;
  let empty: React.ReactNode = null;
  if (noRows) {
    if (filter === 'you') {
      empty = (
        <div className="space-y-2 px-4 py-5 text-sm">
          <p>{t('postsPage.empty.you')}</p>
          <Button size="sm" variant="outline" onClick={() => setFilter(undefined)}>{t('postsPage.empty.showAll')}</Button>
        </div>
      );
    } else if (filter) empty = <p className="px-4 py-5 text-sm text-muted-foreground">{t('postsPage.empty.stage')}</p>;
    else if (first.knowledge_empty) {
      empty = (
        <div className="space-y-2 px-4 py-5 text-sm">
          <p>{t('postsPage.empty.knowledge')}</p>
          <Button size="sm" asChild><Link to="/knowledge">{t('postsPage.actions.toKnowledge')}</Link></Button>
        </div>
      );
    } else empty = <p className="px-4 py-5 text-sm text-muted-foreground">{t('postsPage.empty.plain')}</p>;
  }
  const more = posts.hasNextPage ? (
    <Button variant="outline" className="w-full" loading={posts.isFetchingNextPage} onClick={() => void posts.fetchNextPage()}>
      {t('postsPage.table.more')}
    </Button>
  ) : null;

  const panel = selected ? (
    <DetailPanel
      row={selected}
      detail={detail.data}
      detailError={detail.error}
      brake={brake}
      onResumeAll={() => resume.mutate()}
      onAccounts={openAccounts}
      onTiktok={(slot) => go({ ...withRow(closedPlace(place), `slot:${slot}`), tiktok: slot })}
      onSelect={(id) => select({ id })}
      onClose={() => go(withRow(closedPlace(place), undefined))}
    />
  ) : named && detail.isLoading ? <PanelSkeleton /> : named && detail.isError ? (
    <DetailPanel
      row={{ id: named, kind: 'post', area_id: null, version_id: null, slot_id: null, shoot_request_id: null, title: '', cover: null, channel: null, format: null, media: null, category: { olay_id: null, title: '' }, publish_at: null, published_at: null, url: null, status: 'published', sub_state: null, progress: { index: 7, state: 'done' }, waits: [], actions: {}, ai_illustration: false, siblings: [] }}
      detail={undefined}
      detailError={detail.error}
      brake={brake}
      onResumeAll={() => resume.mutate()}
      onAccounts={openAccounts}
      onTiktok={() => {}}
      onSelect={(id) => select({ id })}
      onClose={() => go(withRow(closedPlace(place), undefined))}
    />
  ) : null;
  // On a desk the panel sits beside the table; below 1024 px it is a sheet over the page (§2.10).
  const sheetOpen = !desk && !!named && !!panel && !place.tiktok;

  return (
    <>
      <PageHeader title={t('postsPage.title')} description={t('postsPage.subtitle')} actions={header} />
      <div className="flex min-w-0 flex-col gap-[18px] [overflow-wrap:anywhere]">
        <AgentLine rows={listed} />
        {brake && (
          <p role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2.5 text-sm text-danger">
            <PauseCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 font-medium">{t('postsPage.brake.line')}</span>
            {brake.can_resume
              ? <Button size="sm" variant="outline" loading={resume.isPending} onClick={() => resume.mutate()}>{t('postsPage.actions.resume')}</Button>
              : <span className="text-foreground">{t('postsPage.brake.other')}</span>}
            {resume.error != null && <span className="basis-full">{errorMessage(t, resume.error)}</span>}
          </p>
        )}
        {first && first.composer.allowed && (
          <Composer
            state={first.composer}
            canResume={!!brake?.can_resume}
            onResume={() => resume.mutate()}
            onAccounts={openAccounts}
            onCreated={(row) => { setCreated(row); go(withRow({}, row.id)); }}
          />
        )}
        {first && !first.composer.allowed && !contentInstalled && can(session.data, 'content.manage') && modules.data && (
          <p className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {t('postsPage.composer.noModule')}
            <Button size="sm" variant="outline" asChild><Link to="/modules/content">{t('postsPage.composer.addModule')}</Link></Button>
          </p>
        )}
        {first && <SpecialDays days={first.days} more={first.days_more} onMore={() => go({ ...closedPlace(place), settings: true, section: 'days' })} />}
        <Chips counts={first?.counts} filter={filter} onFilter={setFilter} loading={loading} />
        {posts.isError && !first ? (
          <Callout tone="danger">
            <p>{t('postsPage.loadError')}</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => void posts.refetch()}>{t('common.retry')}</Button>
          </Callout>
        ) : (
          <div className="flex min-w-0 flex-wrap items-start gap-5">
            <div className="min-w-0 flex-[999_1_32rem]">
              {loading ? <TableSkeleton /> : (
                <PostsTable rows={rows} selectedId={selected?.id} onSelect={select} phone={phone} empty={empty} more={more} />
              )}
            </div>
            {desk && (
              <aside aria-label={t('postsPage.panel.label')} className={cn('min-w-0 max-w-[400px] flex-[1_1_340px] rounded-2xl border border-border bg-surface p-5', !panel && !loading && 'hidden')}>
                {loading ? <PanelSkeleton /> : panel}
              </aside>
            )}
          </div>
        )}
      </div>
      {!desk && (
        <Sheet open={sheetOpen} onOpenChange={(open) => { if (!open) go(withRow(closedPlace(place), undefined)); }}>
          <SheetContent side="right" className={cn('overflow-y-auto', phone ? 'w-full max-w-none' : 'w-full max-w-[420px]')} hideClose={phone} aria-label={t('postsPage.panel.label')}>
            <SheetTitle className="sr-only">{t('postsPage.panel.label')}</SheetTitle>
            <SheetDescription className="sr-only">{selected?.title ?? ''}</SheetDescription>
            {phone && (
              <button type="button" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground" onClick={() => go(withRow(closedPlace(place), undefined))}>
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                {t('postsPage.panel.back')}
              </button>
            )}
            {panel}
          </SheetContent>
        </Sheet>
      )}
      {(place.files || (place.file && !place.settings && !place.accounts)) && materialsWork && <FilesDrawer place={place.files ? place : { ...place, files: true }} go={go} />}
      {place.accounts && socialAny && <AccountsSheet place={place} go={go} />}
      {place.settings && <SettingsSheet place={place} go={go} brake={brake} />}
      {place.tiktok && (
        <TiktokDialog
          id={place.tiktok}
          manage={can(session.data, 'social.manage')}
          onClose={() => { go({ ...place, tiktok: undefined } satisfies PostsPlace, { replace: true }); void refresh(); }}
        />
      )}
    </>
  );
}
