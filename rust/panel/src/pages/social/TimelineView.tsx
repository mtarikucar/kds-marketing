import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountDetail, SocialAccount } from '@/api/social';
import type { PostsOut } from '@/api/posts';
import { Button, EmptyState } from '@/components/ui';
import { MissingPost, PostRow } from './PostRow';
import { VersionRow } from './VersionRow';
import type { SocialPlace, WaitKind } from './location';
import type { Timeline as Data, TimelinePost, TimelineVersion } from './timeline';

/** How many rows a section shows before "more". */
const PAGE = 10;

type Waiting = { kind: WaitKind; post?: TimelinePost; version?: TimelineVersion };

/** The local day of `at`, as a key and as words ("Bugün", "Yarın", else the date). */
function dayOf(at: string, lang: string, words: { today: string; tomorrow: string }): { key: string; label: string } {
  const d = new Date(at);
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (key === `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`) return { key, label: words.today };
  if (key === `${tomorrow.getFullYear()}-${tomorrow.getMonth()}-${tomorrow.getDate()}`) return { key, label: words.tomorrow };
  return { key, label: d.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' }) };
}

function Section({ title, count, children, more, onMore }: { title: string; count: number; children: ReactNode; more: number; onMore: () => void }) {
  const { t } = useTranslation();
  return (
    <section aria-label={title} className="min-w-0 space-y-3">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold">
        {title}
        <span className="font-mono text-xs font-normal text-muted-foreground">{count}</span>
      </h2>
      {children}
      {more > 0 && <Button variant="outline" size="sm" onClick={onMore}>{t('socialAccounts.more', { count: more })}</Button>}
    </section>
  );
}

/**
 * One timeline of posts, for every account or the selected one: what waits for a person, then
 * "Sırada" (soonest first, by day), then "Yayınlananlar" (newest first). Each section shows ten
 * rows and more on request; a row an address names is always among those shown.
 */
export function Timeline({
  data,
  accounts,
  posts,
  details,
  place,
  go,
  manage,
  files,
  ready,
}: {
  data: Data;
  accounts: SocialAccount[];
  posts?: PostsOut;
  details: Map<string, AccountDetail>;
  place: SocialPlace;
  go: (place: SocialPlace, options?: { replace?: boolean }) => void;
  manage: boolean;
  files: boolean;
  /** Every read the timeline is made of has answered. */
  ready: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [limits, setLimits] = useState<Record<string, number>>({});
  const account = (id: string) => accounts.find((a) => a.capability_id === id);
  const showAccount = accounts.length > 1 && !place.account;
  const waiting: Waiting[] = [
    ...data.waiting.approvals.map((post) => ({ kind: 'approvals' as const, post })),
    ...data.waiting.tiktok.map((post) => ({ kind: 'tiktok' as const, post })),
    ...data.waiting.failed.map((post) => ({ kind: 'failed' as const, post })),
    ...data.waiting.times.map((version) => ({ kind: 'times' as const, version })),
    ...data.waiting.blocked.map((version) => ({ kind: 'blocked' as const, version })),
  ].filter((w) => !place.filter || w.kind === place.filter);
  const target = place.slot ?? place.version;
  const idOf = (w: Waiting) => w.post?.slot_id ?? w.version!.version.version_id;
  // A section shows the row its address names, however far down it is.
  const limit = (name: string, ids: string[]) => Math.max(limits[name] ?? PAGE, target ? ids.indexOf(target) + 1 : 0);
  const more = (name: string, shown: number) => () => setLimits((l) => ({ ...l, [name]: shown + PAGE * 2 }));
  const toggleSlot = (id: string) => (place.slot === id ? go({ ...place, slot: undefined }, { replace: true }) : go({ ...place, slot: id, version: undefined }));
  const toggleVersion = (id: string) => (place.version === id ? go({ ...place, version: undefined }, { replace: true }) : go({ ...place, version: id, slot: undefined }));
  const row = (post: TimelinePost) => (
    <PostRow key={post.slot_id} post={post} account={account(post.capability_id)} showAccount={showAccount} expanded={place.slot === post.slot_id} onToggle={() => toggleSlot(post.slot_id)} manage={manage} files={files} place={place} />
  );

  const waitLimit = limit('waiting', waiting.map(idOf));
  const queuedLimit = limit('queued', data.queued.map((p) => p.slot_id));
  const publishedLimit = limit('published', data.published.map((p) => p.slot_id));
  const known = new Set([...waiting.map(idOf), ...data.queued.map((p) => p.slot_id), ...data.published.map((p) => p.slot_id)]);

  // Land on the row an address names, once it is drawn.
  const landed = useRef<string | null>(null);
  useEffect(() => {
    if (!target || landed.current === target) return;
    const element = document.getElementById(place.slot ? `post-${target}` : `version-${target}`);
    if (element) {
      landed.current = target;
      element.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }
  });

  const queuedShown = data.queued.slice(0, queuedLimit);
  const days: { key: string; label: string; posts: TimelinePost[] }[] = [];
  for (const post of queuedShown) {
    const day = dayOf(post.at, i18n.language, { today: t('socialAccounts.today'), tomorrow: t('socialAccounts.tomorrow') });
    const last = days.at(-1);
    if (last?.key === day.key) last.posts.push(post);
    else days.push({ ...day, posts: [post] });
  }
  const nothing = ready && !waiting.length && !data.queued.length && !data.published.length;
  return (
    <div className="min-w-0 space-y-6">
      {ready && place.slot && !known.has(place.slot) && <MissingPost slotId={place.slot} files={files} accounts={accounts} />}
      {ready && place.version && !known.has(place.version) && (
        <p role="status" className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">{t('socialAccounts.missingVersion')}</p>
      )}
      {place.filter && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {t(`socialAccounts.filtered.${place.filter}`)}
          <Button size="sm" variant="ghost" onClick={() => go({ ...place, filter: undefined })}>{t('socialAccounts.showAll')}</Button>
        </p>
      )}
      {waiting.length > 0 && (
        <Section title={t('content.waiting.title')} count={waiting.length} more={waiting.length - waitLimit} onMore={more('waiting', waitLimit)}>
          {waiting.slice(0, waitLimit).map((w) =>
            w.post ? row(w.post) : (
              <VersionRow key={w.version!.version.version_id} item={w.version!} accounts={accounts} posts={posts} details={details}
                expanded={place.version === w.version!.version.version_id} onToggle={() => toggleVersion(w.version!.version.version_id)} files={files} />
            ),
          )}
        </Section>
      )}
      {place.filter && ready && !waiting.length && <p className="text-sm text-muted-foreground">{t('socialAccounts.noneOfKind')}</p>}
      {!place.filter && !nothing && (
        <>
          <Section title={t('socialAccounts.sections.queued')} count={data.queued.length} more={data.queued.length - queuedShown.length} onMore={more('queued', queuedLimit)}>
            {ready && !data.queued.length && <p className="text-sm text-muted-foreground">{t('socialAccounts.noUpcoming')}</p>}
            {days.map((day) => (
              <div key={day.key} className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{day.label}</h3>
                {day.posts.map(row)}
              </div>
            ))}
          </Section>
          <Section title={t('socialAccounts.sections.published')} count={data.published.length} more={data.published.length - publishedLimit} onMore={more('published', publishedLimit)}>
            {ready && !data.published.length && <p className="text-sm text-muted-foreground">{t('socialAccounts.noRecent')}</p>}
            {data.published.slice(0, publishedLimit).map(row)}
          </Section>
        </>
      )}
      {nothing && !place.filter && <EmptyState title={t('socialAccounts.noPosts')} description={t('socialAccounts.noPostsHelp')} />}
    </div>
  );
}
