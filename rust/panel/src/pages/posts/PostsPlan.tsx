import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as p from '@/api/posts';
import { Badge } from '@/components/ui';
import { MaterialsError, cardClass, formatRange, tapClass } from '../materials/MaterialsShared';
import { isLive, useChannelName, usePosts, usePostsKey } from './PostsShared';

/** One open post request: why Studio asks, what it lists, the best format, its last day. */
function RequestRow({ request, tz }: { request: p.PostRequest; tz: string }) {
  const { t, i18n } = useTranslation();
  const channel = useChannelName();
  const best = request.best_formats[0];
  const expires = new Date(Date.parse(request.created_at) + p.REQUEST_DAYS * 86400_000).toISOString();
  const { window_start: start, window_end: end } = request.hints;
  return (
    <li className="space-y-1 rounded-md border border-border p-3" data-testid={`request-${request.id}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span>{t(`posts.trigger.${request.trigger}`)}</span>
        <Badge>{t('posts.materials', { count: request.material_ids.length })}</Badge>
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {best && <span>{t('posts.requests.best', { format: t(`posts.format.${best.format}`) })}</span>}
        {request.capability_id && (
          <span>{t('posts.requests.oneChannel', { channel: channel(request.capability_id) })}</span>
        )}
        {start && end && (
          <span>{t('posts.requests.window', { range: formatRange(start, end, i18n.language) })}</span>
        )}
        <span>{t('posts.requests.expires', { at: p.formatAt(expires, i18n.language, tz) })}</span>
      </p>
    </li>
  );
}

/** One planned post: format, channel, time, where its preparation stands. */
function PostRow({
  out,
  tz,
  onOpenSlot,
}: {
  out: p.PostOut;
  tz: string;
  onOpenSlot: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const channel = useChannelName();
  const { post, slot } = out;
  const state = slot.state === 'ready' ? 'ready' : out.pending ? 'preparing' : 'waiting';
  const tone = state === 'ready' ? 'success' : state === 'preparing' ? 'warning' : 'neutral';
  const at = (when: string) => p.formatAt(when, i18n.language, tz);
  return (
    <li className="space-y-2 rounded-md border border-border p-3" data-testid={`post-${post.slot_id}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span>{t(`posts.format.${post.format}`)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="break-all">{channel(post.capability_id)}</span>
        <Badge tone={tone}>{t(`posts.plan.state.${state}`)}</Badge>
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{t('posts.plan.publishAt', { at: at(post.publish_at) })}</span>
        {state === 'waiting' && <span>{t('posts.plan.prepFrom', { at: at(post.prep_start_at) })}</span>}
        {state !== 'waiting' && (
          <span>{t('posts.plan.graceUntil', { at: at(post.grace_until) })}</span>
        )}
        <span>{t(`posts.plan.subject.${post.subject.kind}`)}</span>
        <span>{t('posts.materials', { count: post.material_ids.length })}</span>
      </p>
      <button type="button" className={tapClass} onClick={() => onOpenSlot(post.slot_id)}>
        {t('posts.plan.open')}
      </button>
    </li>
  );
}

/**
 * Plan: the requests waiting for the agent (it answers them over MCP; nobody approves a post) and
 * the posts planned from them, by publish time, in the posting policy's time zone.
 */
export function PostsPlan({ onOpenSlot }: { onOpenSlot: (id: string) => void }) {
  const { t } = useTranslation();
  const key = usePostsKey();
  const posts = usePosts();
  const requests = useQuery({
    queryKey: [...key, 'requests', 'open'],
    queryFn: () => p.postRequests('open'),
  });
  const tz = posts.data?.settings.tz ?? 'Europe/Istanbul';
  const live = (posts.data?.posts ?? [])
    .filter(isLive)
    .sort((a, b) => Date.parse(a.post.publish_at) - Date.parse(b.post.publish_at));
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="posts-plan">
      <section className={cardClass} aria-labelledby="posts-requests">
        <h3 id="posts-requests" className="font-semibold">
          {t('posts.requests.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('posts.requests.help')}</p>
        <MaterialsError error={requests.error} />
        {requests.data && requests.data.length === 0 && (
          <p className="text-sm">{t('posts.requests.empty')}</p>
        )}
        <ul className="space-y-2">
          {(requests.data ?? []).map((r) => (
            <RequestRow key={r.id} request={r} tz={tz} />
          ))}
        </ul>
      </section>
      <section className={cardClass} aria-labelledby="posts-planned">
        <h3 id="posts-planned" className="font-semibold">
          {t('posts.plan.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('posts.plan.tz', { tz })}</p>
        <MaterialsError error={posts.error} />
        {posts.data && live.length === 0 && <p className="text-sm">{t('posts.plan.empty')}</p>}
        <ul className="space-y-2">
          {live.map((out) => (
            <PostRow key={out.post.slot_id} out={out} tz={tz} onOpenSlot={onOpenSlot} />
          ))}
        </ul>
      </section>
    </div>
  );
}

