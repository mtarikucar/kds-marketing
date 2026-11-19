import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AccountDetail, SocialAccount } from '@/api/social';
import type { PostsOut } from '@/api/posts';
import { Button, EmptyState } from '@/components/ui';
import { WaitingChips, type WaitChip } from '../content/WaitingStrip';
import { MissingPost, PostRow } from './PostRow';
import { VersionRow } from './VersionRow';
import { WAIT_KINDS, type SocialPlace, type WaitKind } from './location';
import { waitCount, type Timeline as Data, type TimelinePost, type TimelineVersion } from './timeline';

/** How many rows a section shows before "more". */
const PAGE = 10;

type Waiting = { kind: WaitKind; post?: TimelinePost; version?: TimelineVersion };

const TONES: Record<WaitKind, WaitChip['tone']> = { approvals: 'warning', tiktok: 'warning', failed: 'danger', times: 'primary', blocked: 'danger' };

/** The kinds that wait for a person on `data`. */
export const waitingKinds = (data: Data) => WAIT_KINDS.filter((kind) => waitCount(data, kind) > 0);

/**
 * "Sizi bekleyenler"'s counted chip per kind; each one a button that calls `pick` (a filter, or
 * on a phone the way to the posts), plain without `pick`.
 */
export function waitChips(t: TFunction, data: Data, filter: WaitKind | undefined, pick?: (kind: WaitKind) => void): WaitChip[] {
  return WAIT_KINDS.map((kind): WaitChip => ({
    key: kind,
    count: waitCount(data, kind),
    label: t(`socialAccounts.wait.${kind}`, { count: waitCount(data, kind) }),
    tone: TONES[kind],
    onClick: pick && (() => pick(kind)),
    pressed: filter === kind,
  }));
}

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
        {/* An empty section says so in words below; a "0" would say it twice. */}
        {count > 0 && <span className="font-mono text-xs font-normal text-muted-foreground">{count}</span>}
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
 *
 * "Sizi bekleyenler" is said once, as the first section's title line: a counted chip per kind
 * that waits, each a filter when more than one kind waits (one kind alone filters nothing), or
 * a few words when nothing does.
 */
export function Timeline({
  data,
  accounts,
  posts,
  details,
  place,
  go,
  onFilter,
  manage,
  files,
  ready,
  revising,
}: {
  data: Data;
  accounts: SocialAccount[];
  posts?: PostsOut;
  details: Map<string, AccountDetail>;
  place: SocialPlace;
  go: (place: SocialPlace, options?: { replace?: boolean }) => void;
  /** A chip's filter: on, or off when it is the one on. */
  onFilter: (kind: WaitKind) => void;
  manage: boolean;
  files: boolean;
  /** Every read the timeline is made of has answered. */
  ready: boolean;
  /** The contents being revised ("Düzenleniyor"), under what waits and not counted with it. */
  revising?: ReactNode;
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
  // A filter left on (an old `?filter=` link) keeps its chip, to take it off.
  const chips = waitChips(t, data, place.filter, waitingKinds(data).length > 1 || place.filter ? onFilter : undefined);
  const approvals = data.waiting.approvals.length;
  return (
    <div className="min-w-0 space-y-6">
      {ready && place.slot && !known.has(place.slot) && <MissingPost slotId={place.slot} files={files} accounts={accounts} />}
      {ready && place.version && !known.has(place.version) && (
        <p role="status" className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">{t('socialAccounts.missingVersion')}</p>
      )}
      {(ready || waiting.length > 0 || place.filter) && (
        // Until every read answered, "nothing waits" would be a guess; with a filter on, the line
        // under the title says what is shown.
        <WaitingChips chips={chips} quiet={!ready || !!place.filter}>
          {place.filter && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {ready && !waiting.length ? t('socialAccounts.noneOfKind') : t(`socialAccounts.filtered.${place.filter}`)}
              <Button size="sm" variant="ghost" onClick={() => go({ ...place, filter: undefined })}>{t('socialAccounts.showAll')}</Button>
            </p>
          )}
          {waiting.slice(0, waitLimit).map((w) =>
            w.post ? row(w.post) : (
              <VersionRow key={w.version!.version.version_id} item={w.version!} accounts={accounts} posts={posts} details={details}
                expanded={place.version === w.version!.version.version_id} onToggle={() => toggleVersion(w.version!.version.version_id)} files={files} />
            ),
          )}
          {waiting.length > waitLimit && <Button variant="outline" size="sm" onClick={more('waiting', waitLimit)}>{t('socialAccounts.more', { count: waiting.length - waitLimit })}</Button>}
        </WaitingChips>
      )}
      {!place.filter && revising}
      {!place.filter && !nothing && (
        <>
          <Section title={t('socialAccounts.sections.queued')} count={data.queued.length} more={data.queued.length - queuedShown.length} onMore={more('queued', queuedLimit)}>
            {ready && !data.queued.length && (
              <p className="text-sm text-muted-foreground">
                {/* Posts waiting for approval have their time: they come here once approved. */}
                {approvals ? t('socialAccounts.afterApproval', { count: approvals }) : t('socialAccounts.noUpcoming')}
              </p>
            )}
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
