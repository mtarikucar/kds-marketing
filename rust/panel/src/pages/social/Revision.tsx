import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { isApiError } from '@/api/client';
import { areaRedo, contentAreas } from '@/api/content';
import type { PostsOut } from '@/api/posts';
import * as studio from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { Button, cn } from '@/components/ui';
import { can, canAny } from '@/lib/roles';
import { inputClass, StudioError, useStudioKey } from '../StudioShared';
import { areaTime } from '../content/AreaShared';
import { placeHref as contentHref } from '../content/location';
import { useSocialKey } from './data';
import { CancelPost, usePostMutation } from './PostRow';
import type { TimelinePost } from './timeline';

/** The longest note `content.area_redo` takes (`MAX_GOAL_CHARS`). */
const MAX_NOTE = 2000;

/** The post's slot as `studio.slot_get` answers it, under the key the row's detail reads. */
function useSlotDetail(slotId: string, enabled: boolean) {
  const key = useStudioKey();
  return useQuery({ queryKey: [...key, 'slot', slotId], queryFn: () => studio.slotGet(slotId), enabled });
}

/** "Instagram hesabı · Gönderi · 20 Kas 10:00": one post of the content, as the sentence names it. */
function postName(t: TFunction, lang: string, p: studio.ContentPost) {
  return t('socialRevision.postName', {
    account: p.account_name ?? t('socialAccounts.unknownAccount'),
    format: t(`posts.format.${p.format}`, { defaultValue: p.format }),
    at: areaTime(p.scheduled_at, lang),
  });
}

/**
 * What a redo of `content` does, asked from post `slotId`, from what the server says of each of
 * its posts: this one leaves the calendar, so do the others a redo takes back (named, since the
 * redo is the whole content's), the published ones stay, and the agent makes it again; the new
 * version comes back for approval when this post waited for one, else it is given a time again.
 */
export function consequence(t: TFunction, lang: string, slotId: string, content: studio.SlotContent, approval: boolean): string {
  const others = content.posts.filter((p) => p.slot_id !== slotId && p.withdrawn_by_redo);
  const published = content.posts.filter((p) => p.published);
  const list = (posts: studio.ContentPost[]) => posts.map((p) => postName(t, lang, p)).join('; ');
  return [
    t('socialRevision.leaves'),
    others.length > 0 && t('socialRevision.othersLeave', { count: others.length, list: list(others) }),
    published.length > 0 && t('socialRevision.publishedStays', { count: published.length, list: list(published) }),
    t(approval ? 'socialRevision.remakeApproval' : 'socialRevision.remakeQueue'),
  ].filter(Boolean).join(' ');
}

/** The redo's refusals in words: a newer package, a platform that did not let the post go. */
function RedoError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  if (isApiError(error) && error.code === 'CONFLICT') {
    const unconfirmed = error.details.reason === 'withdraw_unconfirmed';
    return <p role="alert" className="basis-full rounded-md bg-danger-subtle px-3 py-2 text-sm">{t(unconfirmed ? 'socialRevision.unconfirmed' : 'socialRevision.stale')}</p>;
  }
  return <div className="basis-full"><StudioError error={error} /></div>;
}

/**
 * "Düzenleme iste" on a post of a content: one note, inline, with what it does said above the
 * send. The redo is the content's (`content.area_redo`, `content.manage`, in person) and names the
 * package the person saw; a newer one is refused and read again.
 */
function RedoForm({ post, content, approval }: { post: TimelinePost; content: studio.SlotContent; approval: boolean }) {
  const { t, i18n } = useTranslation();
  const refresh = usePostMutation();
  const client = useQueryClient();
  const key = useStudioKey();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const id = `revision-${post.slot_id}`;
  if (done) return <p role="status" className="basis-full text-sm text-muted-foreground">{t('socialRevision.sent')}</p>;
  if (!open) return (
    <Button size="sm" variant="outline" onClick={() => { setOpen(true); setError(null); }}>
      <RotateCcw aria-hidden="true" className="h-4 w-4" />
      {t('socialRevision.request')}
    </Button>
  );
  return (
    <form
      aria-label={t('socialRevision.request')}
      className="flex basis-full flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !note.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await areaRedo(content.project_id, { package_revision: content.package_revision, note: note.trim() });
          setDone(true);
          await refresh();
        } catch (err) {
          setError(err);
          // A newer package (or a post the platform kept): read the post and its content again.
          if (isApiError(err) && err.code === 'CONFLICT') await client.invalidateQueries({ queryKey: [...key, 'slot', post.slot_id] });
        }
        setBusy(false);
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">{t('socialRevision.note')}</label>
      <textarea id={id} className={cn(inputClass, 'min-h-20')} name="note" required maxLength={MAX_NOTE} autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="text-sm text-muted-foreground">{consequence(t, i18n.language, post.slot_id, content, approval)}</p>
      <RedoError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" loading={busy} disabled={!note.trim()}>{t('socialRevision.send')}</Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { setOpen(false); setNote(''); setError(null); }}>{t('socialRevision.dismiss')}</Button>
      </div>
    </form>
  );
}

/**
 * What a person may do instead of letting a planned post go as it is: ask for a revision of the
 * content it was made of, or, for a post made of no content (an agent proposed it directly), cancel
 * it with a reason (`studio.slot_cancel`). Only what the session may do shows, and only once the
 * post's slot says which applies; a session that does not read the production line cannot tell a
 * post of no content from one of a content, so it is offered neither.
 */
export function PostRevision({ post, approval, className }: { post: TimelinePost; approval: boolean; className?: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const redo = can(session.data, 'content.manage');
  const readsContent = canAny(session.data, ['content.work', 'content.manage']);
  const cancel = readsContent && can(session.data, 'social.manage');
  const detail = useSlotDetail(post.slot_id, redo || cancel);
  const data = detail.data;
  if (!data) return null;
  const content = data.content;
  let body = null;
  if (content?.current) {
    // The redo takes this post back only while it is still to go: one being sent stays.
    if (redo && content.posts.some((p) => p.slot_id === post.slot_id && p.withdrawn_by_redo)) body = <RedoForm post={post} content={content} approval={approval} />;
  } else if (cancel && (data.slot.state === 'planned' || data.slot.state === 'ready')) {
    body = <CancelPost slotId={post.slot_id} revision={data.slot.revision} intro={t('socialRevision.noContent')} label={t('socialRevision.cancel')} />;
  }
  if (!body) return null;
  return className ? <div className={className}>{body}</div> : body;
}

/**
 * "Düzenleniyor": the contents a person asked to revise that had a post here, until the agent's
 * next delivery answers the note (the area's `redo` is gone). Not something that waits for the
 * person, so not counted with what does. Read from the production line, so only for a session
 * that reads it; on one account's view, only those that had a post on it.
 */
export function Revising({ scope, posts }: { scope?: string; posts?: PostsOut }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const reads = canAny(session.data, ['content.work', 'content.manage']);
  const key = useSocialKey();
  const areas = useQuery({ queryKey: [...key, 'revising'], queryFn: () => contentAreas({ scope: 'open' }), enabled: reads, refetchInterval: 60_000 });
  if (!reads || !areas.data) return null;
  const account = new Map((posts?.posts ?? []).map((p) => [p.post.slot_id, p.post.capability_id]));
  const rows = areas.data.areas.filter((r) => {
    const withdrawn = r.area.redo?.withdrawn ?? [];
    return withdrawn.length > 0 && (!scope || withdrawn.some((id) => account.get(id) === scope));
  });
  if (!rows.length) return null;
  const title = t('socialRevision.group');
  return (
    <section aria-label={title} className="min-w-0 space-y-2">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold text-muted-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{t('socialRevision.groupHelp')}</p>
      <ul className="space-y-2">
        {rows.map(({ area }) => (
          <li key={area.id} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5 sm:px-4">
            <RotateCcw aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-[1_1_14rem] space-y-0.5 text-sm">
              <p className="truncate font-medium">{area.title || area.brief}</p>
              <p className="break-words text-muted-foreground">{t('socialRevision.asked', { note: area.redo!.note })}</p>
              <p className="text-xs text-muted-foreground"><time dateTime={area.redo!.at}>{t('socialRevision.askedAt', { at: areaTime(area.redo!.at, i18n.language) })}</time></p>
            </div>
            <Button size="sm" variant="ghost" asChild><Link to={contentHref({ content: area.id })}>{t('socialRevision.open')}</Link></Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
