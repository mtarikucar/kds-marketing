import { useTranslation } from 'react-i18next';
import { ExternalLink, Info } from 'lucide-react';
import { isApiError } from '@/api/client';
import type { BrakeState, PostDetail, PostRow, Sibling } from '@/api/postsPage';
import { RunNowButton } from '@/components/AgentWakeLine';
import { Button, Callout, cn, Skeleton } from '@/components/ui';
import { useNeedWake, useNow } from '@/lib/wake';
import { RowActionBar } from './actions';
import { PostMedia } from './PostMedia';
import { ChannelBadge } from './PostsTable';
import { categoryTitle, channelAndTime, formatWords, platformName, STATUS_TONE, statusLine, statusWord, subStateLine, waitSentence, whenWords } from './words';

const PILL = {
  red: 'bg-danger-subtle text-danger',
  amber: 'bg-warning-subtle text-warning',
  violet: 'bg-primary/10 text-primary',
  grey: 'bg-surface-muted text-muted-foreground',
  green: 'bg-success-subtle text-success',
} as const;

/** "Şimdi çalıştır" for a content whose agent is late (§2.4), when it has a wake address. */
function RunNow() {
  const wake = useNeedWake('content');
  const now = useNow(30_000);
  if (wake?.state !== 'schedule' || !wake.run_now) return null;
  return <RunNowButton run={wake.run_now} now={now} />;
}

/** The panel's skeleton while the first page is read (§2.10 Loading). */
export function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <Skeleton className="aspect-[4/3] w-full rounded-xl" />
      <div className="space-y-2"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-3 w-1/2" /></div>
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/** A `NOT_FOUND` answer of `content.post_get`: no such row in this workspace. */
export const isNotFound = (err: unknown) => isApiError(err) && err.code === 'NOT_FOUND';

/** Whether the row the panel shows is no longer one the page lists (§2.10 "Row gone"). */
export function isGone(detail: PostDetail | undefined, detailError: unknown): boolean {
  return isNotFound(detailError) || !!detail?.cancelled || detail?.listed === false;
}

/** §2.10 "Row gone (cancelled, archived)": said, with `Kapat`. */
export function GonePanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm">{t('postsPage.panel.gone')}</p>
      <Button size="sm" variant="outline" onClick={onClose}>{t('postsPage.panel.close')}</Button>
    </div>
  );
}

/** The row's own read failed (not a `NOT_FOUND`): said, with `Yeniden dene`. */
export function DetailLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Callout tone="danger">
      <p>{t('postsPage.panel.loadError')}</p>
      <Button className="mt-2" size="sm" variant="outline" onClick={onRetry}>{t('common.retry')}</Button>
    </Callout>
  );
}

/** One version of the content the panel shows: its row when read, else what its siblings say of it. */
export interface VersionView {
  id: string;
  row: PostRow | null;
  sibling: Sibling | null;
}

interface BlockContext {
  brake: BrakeState | null;
  onResumeAll: () => void;
  onAccounts: () => void;
  onTiktok: (slotId: string) => void;
  onSelect: (rowId: string) => void;
  onGone?: (rowId: string, gone: boolean) => void;
}

/**
 * One version's block: platform and account, time, state, and what belongs to that state (the
 * wait's sentence, the row's own actions, the live post's link). Another version's head shows
 * that version in the panel instead.
 */
function VersionBlock({ view, current, brake, onResumeAll, onAccounts, onTiktok, onSelect, onGone }: BlockContext & { view: VersionView; current: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const row = view.row;
  const channel = row ? row.channel : view.sibling?.channel ?? null;
  const status = row?.status ?? view.sibling?.status ?? 'scheduled';
  const publishedAt = row?.published_at ?? null;
  const at = publishedAt ?? (row ? row.publish_at : view.sibling?.publish_at ?? null);
  const wait = row?.waits[0];
  const sub = row && !wait ? subStateLine(t, row.sub_state, lang) : null;
  const pill = row ? statusLine(t, row, lang) : statusWord(t, { status, tiktok_draft: false });
  const tone = row?.status === 'published' && row.tiktok_draft ? 'green' : STATUS_TONE[status];
  const head = (
    <>
      <ChannelBadge channel={channel && { ...channel, label: platformName(channel.kind) }} />
      {channel?.name && <span className="min-w-0 truncate text-[13px]">{channel.name}</span>}
      <span data-testid="version-status" className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold', PILL[tone])}>{pill}</span>
      <span className="text-[13px] tabular-nums text-muted-foreground">
        {publishedAt ? t('postsPage.panel.publishedAt', { at: whenWords(t, publishedAt, lang) }) : whenWords(t, at, lang)}
      </span>
    </>
  );
  return (
    <li data-version={view.id} aria-current={current || undefined} className={cn('min-w-0 space-y-2.5 rounded-xl border p-3', current ? 'border-primary bg-primary/5' : 'border-border')}>
      {current ? (
        <div className="flex flex-wrap items-center gap-2">{head}</div>
      ) : (
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-2 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={channelAndTime(t, channel, at, lang)}
          onClick={() => onSelect(view.id)}
        >
          {head}
        </button>
      )}
      {wait && row && (
        <p data-testid="wait-sentence" className="rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2.5 text-sm">{waitSentence(t, wait, row.channel, row.publish_at, lang)}</p>
      )}
      {row?.status === 'paused' && (
        <div className="space-y-2 rounded-lg border border-border bg-surface-muted px-3 py-2.5 text-sm">
          <p>{t('postsPage.brake.paused')}</p>
          {brake?.can_resume && <Button size="sm" variant="outline" onClick={onResumeAll}>{t('postsPage.actions.resume')}</Button>}
        </div>
      )}
      {sub?.late && <p className="text-sm"><RunNow /></p>}
      {row && <RowActionBar row={row} onAccounts={onAccounts} onTiktok={onTiktok} onGone={onGone} />}
      {publishedAt && row?.url && (
        <a className="inline-flex items-center gap-1 text-[13px] text-primary underline underline-offset-4" href={row.url} target="_blank" rel="noreferrer noopener">
          {t('postsPage.panel.openPost')}<ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      )}
    </li>
  );
}

/**
 * The selected row (design 2026-11-19 §2.7), no tabs and no step list: the post itself first and
 * large, its title with the format and category in a line, the AI note, the whole caption with its
 * tags, then one block per version of the same content (this one marked), each with its own
 * state and actions.
 */
export function DetailPanel({
  row,
  detail,
  detailError,
  versions,
  markedGone = false,
  brake,
  onResumeAll,
  onAccounts,
  onTiktok,
  onSelect,
  onClose,
  onRetry,
  onGone,
}: {
  row: PostRow;
  detail: PostDetail | undefined;
  detailError: unknown;
  /** Every version of the row's content, the row among them; absent: the row alone. */
  versions?: VersionView[];
  /** Cancelled from this panel a moment ago, before any read says so. */
  markedGone?: boolean;
  onRetry: () => void;
  onGone?: (rowId: string, gone: boolean) => void;
  brake: BrakeState | null;
  onResumeAll: () => void;
  onAccounts: () => void;
  onTiktok: (slotId: string) => void;
  /** Shows another version of the content in the panel. */
  onSelect: (rowId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (markedGone || isGone(detail, detailError)) return <GonePanel onClose={onClose} />;
  const ai = row.ai_illustration || !!detail?.materials.some((c) => c.ai_generated);
  const before = row.kind === 'content';
  const given = versions?.some((v) => v.id === row.id) ? versions : [{ id: row.id, row, sibling: null }, ...(versions ?? [])];
  const list = given.map((v) => (v.id === row.id ? { ...v, row } : v));
  const facts = [formatWords(t, row), categoryTitle(t, row)].filter(Boolean).join(' · ');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PostMedia row={row} materials={detail?.materials} loading={!detail && detailError == null} />
      <div className="space-y-1">
        <h2 className="line-clamp-2 text-[17px] font-bold leading-snug">{row.title}</h2>
        <p className="text-[13px] text-muted-foreground">{facts}</p>
      </div>
      {ai && (
        <p className="flex items-center gap-2 text-xs text-primary">
          <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {t('postsPage.panel.ai')}
        </p>
      )}

      {detail ? (
        detail.text && (
          <div className="space-y-1">
            {before && <p className="text-xs font-medium text-muted-foreground">{t('postsPage.panel.request')}</p>}
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{detail.text}</p>
          </div>
        )
      ) : detailError != null ? (
        <DetailLoadError onRetry={onRetry} />
      ) : (
        <Skeleton className="h-12 w-full" />
      )}
      {detail?.redo_note && <p className="text-sm text-muted-foreground">{t('postsPage.panel.redoNote', { note: detail.redo_note })}</p>}

      <ul aria-label={t('postsPage.panel.versions')} className="space-y-2.5 border-t border-border pt-3.5">
        {list.map((v) => (
          <VersionBlock
            key={v.id}
            view={v}
            current={v.id === row.id}
            brake={brake}
            onResumeAll={onResumeAll}
            onAccounts={onAccounts}
            onTiktok={onTiktok}
            onSelect={onSelect}
            onGone={onGone}
          />
        ))}
      </ul>
    </div>
  );
}
