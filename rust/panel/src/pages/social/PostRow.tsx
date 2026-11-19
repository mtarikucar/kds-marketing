import { useState, type ReactNode } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Clock, ExternalLink, Image as ImageIcon, UserRound } from 'lucide-react';
import * as studio from '@/api/studio';
import { materialGet } from '@/api/materials';
import type { SocialAccount } from '@/api/social';
import { Badge, Button, cn } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { inputClass, Reason, StudioError, StudioReadStatus, useStudioKey } from '../StudioShared';
import { areaTime, MiniThumb } from '../content/AreaShared';
import { PlatformFrame } from '../content/PlatformFrame';
import { useMaterialsKey } from '../materials/MaterialsShared';
import { useSocialKey } from './data';
import { placeHref, type SocialPlace } from './location';
import { PostRevision } from './Revision';
import type { PostState, TimelinePost } from './timeline';

const TONE: Record<PostState, 'warning' | 'danger' | 'info' | 'neutral' | 'success'> = {
  approval: 'warning', tiktok: 'warning', failed: 'danger', held: 'danger', processing: 'info', due: 'info', at_provider: 'neutral', by_jeeta: 'neutral', published: 'success',
};
const METRICS = ['reach', 'views', 'engagement'] as const;
/** Still to go out and nobody's to act on: held, due, left with the platform, or Jeeta's to send. */
const QUEUED = new Set<PostState>(['held', 'due', 'at_provider', 'by_jeeta']);

/** A write on a post: it refreshes Studio's reads, the social page's and the pending work. */
export function usePostMutation() {
  const client = useQueryClient();
  const studioKey = useStudioKey();
  const socialKey = useSocialKey();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: studioKey }),
    client.invalidateQueries({ queryKey: socialKey }),
    client.invalidateQueries({ queryKey: ['work'] }),
  ]);
}

/**
 * "Onayla" on the row: the post's account and time on the button, as the content page words it.
 * It approves the revision the pending work read; a newer one is refused as stale and read again.
 */
function ApproveButton({ post, account }: { post: TimelinePost; account?: SocialAccount }) {
  const { t, i18n } = useTranslation();
  const refresh = usePostMutation();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);
  const approve = async () => {
    setState('busy');
    setError(null);
    try {
      const revision = post.slot?.revision ?? (await studio.slotGet(post.slot_id)).slot.revision;
      await studio.approve({ slot: post.slot_id }, revision);
      setState('done');
    } catch (e) {
      setError(e);
      setState('idle');
    }
    await refresh();
  };
  if (state === 'done') return <p role="status" className="text-sm text-success">{t('socialAccounts.approved')}</p>;
  return (
    <>
      <Button size="sm" loading={state === 'busy'} onClick={() => void approve()}>
        <Check aria-hidden="true" className="h-4 w-4" />
        {t('content.bar.approveAt', { account: account?.name ?? t('socialAccounts.unknownAccount'), at: areaTime(post.at, i18n.language) })}
      </Button>
      {!!error && <div className="basis-full"><StudioError error={error} /></div>}
    </>
  );
}

/**
 * Cancelling a post with a reason, asked for at that moment only: one that could not be sent, or
 * (with its own `intro` and `label`) a planned post made of no content.
 */
export function CancelPost({ slotId, revision, intro, label }: { slotId: string; revision: number; intro?: string; label?: string }) {
  const { t } = useTranslation();
  const refresh = usePostMutation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  if (done) return <p role="status" className="text-sm text-muted-foreground">{t('socialAccounts.cancelled')}</p>;
  if (!open) return (
    <>
      <p className="basis-full text-sm text-muted-foreground">{intro ?? t('studio.notResent')}</p>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{label ?? t('studio.cancel')}</Button>
    </>
  );
  return (
    <form
      className="flex basis-full flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !reason.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await studio.slotCancel(slotId, revision, reason.trim());
          setDone(true);
        } catch (err) {
          setError(err);
        }
        setBusy(false);
        await refresh();
      }}
    >
      <label className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1 text-sm">
        <span>{t('studio.reason')}</span>
        <input className={inputClass} name="reason" required maxLength={2000} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Button size="sm" variant="destructive" type="submit" loading={busy} disabled={!reason.trim()}>{t('socialAccounts.cancelConfirm')}</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => { setOpen(false); setReason(''); }}>{t('common.cancel')}</Button>
      {!!error && <div className="basis-full"><StudioError error={error} /></div>}
    </form>
  );
}

/** A failed post's line: what the pending work says, and the cancel when its send failed. */
function FailedActions({ post, manage }: { post: TimelinePost; manage: boolean }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const detail = useQuery({ queryKey: [...key, 'slot', post.slot_id], queryFn: () => studio.slotGet(post.slot_id) });
  const failed = detail.data?.attempts.some((a) => a.state === 'failed' || a.state === 'refused');
  // What the attempt recorded says more than the pending work's category: shown when read.
  const recorded = detail.data?.attempts.filter((a) => a.failure_reason).at(-1);
  return (
    <>
      {recorded
        ? <p className={cn('basis-full text-sm', recorded.state === 'unknown' ? 'text-warning' : 'text-danger')}>{t(recorded.state === 'unknown' ? 'studio.publishUncertain' : 'studio.publishFailed', { reason: recorded.failure_reason })}</p>
        : post.blockers.filter((b) => b.reason.startsWith('publish_')).slice(0, 1).map((b) => <div key={b.reason} className="basis-full"><Reason reason={b.reason} /></div>)}
      {manage && failed && detail.data && <CancelPost slotId={post.slot_id} revision={detail.data.slot.revision} />}
    </>
  );
}

/** A published post's numbers, the platform's own; one it does not give is "—". */
function PostNumbers({ post }: { post: TimelinePost }) {
  const { t, i18n } = useTranslation();
  if (!post.metrics) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {METRICS.map((m) => (
        <div key={m} className="flex items-baseline gap-1">
          <dt className="text-muted-foreground">{t(`socialAccounts.metrics.${m}`)}</dt>
          <dd className="font-medium tabular-nums">{post.metrics![m] == null ? '—' : formatNumber(post.metrics![m]!, i18n.language)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PostLink({ url }: { url: string | null | undefined }) {
  const { t } = useTranslation();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 text-sm text-primary underline">
      {t('content.out.link')}
      <ExternalLink aria-hidden="true" className="h-3 w-3" />
    </a>
  );
}

/**
 * An open post: its full text, its materials and the phone preview the content page shows, and
 * for a send that went wrong what each attempt says. Read from the slot (`studio.slot_get`).
 */
export function PostDetail({ slotId, account, format, materialIds, files }: { slotId: string; account: string; format: string | null; materialIds: string[]; files: boolean }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const materialsKey = useMaterialsKey();
  const detail = useQuery({ queryKey: [...key, 'slot', slotId], queryFn: () => studio.slotGet(slotId) });
  const ids = detail.data?.post?.material_ids ?? materialIds;
  const materials = useQueries({
    queries: ids.map((id) => ({ queryKey: [...materialsKey, 'material', id], queryFn: () => materialGet(id), enabled: files, staleTime: 60_000, retry: false })),
  });
  const piece = detail.data?.piece;
  const shownFormat = detail.data?.post?.format ?? format;
  return (
    <div className="min-w-0 space-y-4">
      <StudioReadStatus query={detail} />
      {detail.data && (
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="min-w-0 space-y-3">
            {piece ? <p className="whitespace-pre-wrap break-words text-sm">{piece.text}</p> : <p className="text-sm text-muted-foreground">{t('socialAccounts.noPiece')}</p>}
            {ids.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('socialAccounts.materials', { count: ids.length })}</p>
                <div className="flex flex-wrap gap-1.5">{ids.map((id) => <MiniThumb key={id} id={id} size="h-14 w-14" files={files} link={false} />)}</div>
              </div>
            )}
            {detail.data.attempts.map((a, i) => a.failure_reason && (
              <p key={i} className={cn('text-sm', a.state === 'unknown' ? 'text-warning' : 'text-danger')}>
                {t(a.state === 'unknown' ? 'studio.publishUncertain' : 'studio.publishFailed', { reason: a.failure_reason })}
              </p>
            ))}
          </div>
          {piece && shownFormat && (
            <PlatformFrame
              version={{ format: shownFormat as never, text: piece.text, tags: [], material_ids: ids }}
              materials={materials.flatMap((m) => (m.data ? [m.data.material] : []))}
              account={account}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One post as one row: its visual, account, format, time, the opening of its text and its state
 * in plain words; what a person does about it on the row itself (approve, finish on TikTok,
 * cancel a failed send), a published one's numbers and link. Opening it shows the whole post.
 */
export function PostRow({
  post,
  account,
  showAccount,
  expanded,
  onToggle,
  manage,
  files,
  place,
}: {
  post: TimelinePost;
  account?: SocialAccount;
  /** More than one account: each row names its own. */
  showAccount: boolean;
  expanded: boolean;
  onToggle: () => void;
  manage: boolean;
  /** The session reads files (`materials.work`): the visuals and the preview's media. */
  files: boolean;
  place: SocialPlace;
}) {
  const { t, i18n } = useTranslation();
  const panel = `post-${post.slot_id}-detail`;
  const cover = post.material_ids[0];
  const format = post.format ? t(`posts.format.${post.format}`, { defaultValue: post.format }) : null;
  const waits = post.state === 'approval' || post.state === 'tiktok' || post.state === 'failed';
  const Icon = post.state === 'failed' || post.state === 'held' ? AlertTriangle : post.state === 'published' ? CheckCircle2 : waits ? UserRound : Clock;
  let actions: ReactNode = null;
  // Instead of approving it, a revision of its content (or, made of none, its cancel).
  if (post.state === 'approval') actions = <>{manage ? <ApproveButton post={post} account={account} /> : <p className="text-sm text-muted-foreground">{t('socialAccounts.approveManagerOnly')}</p>}<PostRevision post={post} approval /></>;
  // TikTok's screen in place of an approval, and the same ways out as an approval's.
  else if (post.state === 'tiktok') actions = <><Button size="sm" asChild><Link to={placeHref({ ...place, tiktok: post.slot_id })}>{t('socialAccounts.finishTiktok')}</Link></Button><PostRevision post={post} approval /></>;
  else if (post.state === 'failed') actions = <FailedActions post={post} manage={manage} />;
  else if (post.state === 'held' && post.blockers.length > 0) actions = <div className="basis-full"><Reason reason={post.blockers[0].reason} /></div>;
  else if (post.state === 'published') actions = <><PostNumbers post={post} /><PostLink url={post.url} /></>;
  return (
    <article
      id={`post-${post.slot_id}`}
      aria-label={post.title || format || t('socialAccounts.post')}
      className={cn('min-w-0 scroll-mt-4 rounded-lg border bg-surface shadow-xs', post.state === 'failed' ? 'border-danger/50' : waits ? 'border-warning/50' : 'border-border')}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panel}
        onClick={onToggle}
        className="grid w-full grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-3 rounded-t-lg px-3 pb-2 pt-3 text-start hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[2.75rem_minmax(0,1fr)_auto_1.25rem] sm:px-4"
      >
        {cover ? <MiniThumb id={cover} size="h-11 w-11" files={files} link={false} /> : <span className="flex h-11 w-11 items-center justify-center rounded bg-surface-muted"><ImageIcon aria-hidden="true" className="h-5 w-5 text-muted-foreground" /></span>}
        <span className="min-w-0">
          <span className={cn('block truncate font-medium', !post.title && 'text-muted-foreground')}>{post.title || t('socialAccounts.noTitle')}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <time dateTime={post.at} className="font-mono">{areaTime(post.at, i18n.language)}</time>
            {showAccount && <span className="min-w-0 break-all">{account?.name ?? t('socialAccounts.unknownAccount')}</span>}
            {format && <span>{format}</span>}
          </span>
        </span>
        <Badge tone={TONE[post.state]} className="max-sm:col-start-2 max-sm:justify-self-start">
          <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {t(`socialAccounts.state.${post.state}`)}
        </Badge>
        <ChevronDown aria-hidden="true" className={cn('hidden h-5 w-5 text-muted-foreground transition-transform sm:block', expanded && 'rotate-180')} />
      </button>
      {actions && <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-3 sm:ps-[4.75rem]">{actions}</div>}
      {expanded && (
        <div id={panel} className="border-t border-border bg-surface-muted/40 px-3 py-4 sm:px-4">
          <PostDetail slotId={post.slot_id} account={account?.name ?? t('socialAccounts.unknownAccount')} format={post.format} materialIds={post.material_ids} files={files} />
          {/* A post still to go asks for its revision in its detail: the quiet rows stay quiet. */}
          {QUEUED.has(post.state) && <PostRevision post={post} approval={false} className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-4" />}
        </div>
      )}
    </article>
  );
}

/**
 * A post an address names that no list shows (taken back, or older than the lists): what its
 * slot says, opened.
 */
export function MissingPost({ slotId, files, accounts }: { slotId: string; files: boolean; accounts: SocialAccount[] }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const detail = useQuery({ queryKey: [...key, 'slot', slotId], queryFn: () => studio.slotGet(slotId), retry: false });
  const state = detail.data?.post?.retired ? 'retired' : detail.data?.slot.state;
  return (
    <article id={`post-${slotId}`} aria-label={t('socialAccounts.missingPost')} className="min-w-0 scroll-mt-4 space-y-3 rounded-lg border border-border bg-surface p-4 shadow-xs">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {t('socialAccounts.missingPost')}
        {state && <Badge>{t(`studio.${state}`)}</Badge>}
      </p>
      {detail.data?.post?.retired && <p className="text-sm text-muted-foreground">{t(`content.out.retirement.${detail.data.post.retired.reason}`, { defaultValue: t('content.out.retirement.other') })}</p>}
      <PostDetail slotId={slotId} account={accounts.find((a) => a.capability_id === detail.data?.slot.capability_id)?.name ?? t('socialAccounts.unknownAccount')} format={null} materialIds={[]} files={files} />
    </article>
  );
}
