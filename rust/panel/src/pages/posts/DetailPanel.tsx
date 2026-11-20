import { useTranslation } from 'react-i18next';
import { ExternalLink, Info } from 'lucide-react';
import { isApiError } from '@/api/client';
import type { BrakeState, PostDetail, PostRow } from '@/api/postsPage';
import { RunNowButton } from '@/components/AgentWakeLine';
import { Button, Callout, cn, Skeleton } from '@/components/ui';
import { useNeedWake, useNow } from '@/lib/wake';
import { RowActionBar } from './actions';
import { Thumb } from './PostsTable';
import { categoryTitle, channelAndTime, formatWords, platformName, STATUS_TONE, statusLine, subStateLine, waitSentence, whenWords } from './words';

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
      <div className="flex gap-3.5"><Skeleton className="h-[92px] w-[92px] rounded-xl" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-4/5" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-5 w-24 rounded-full" /></div></div>
      <Skeleton className="h-9 w-full" />
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

/**
 * The selected row (design 2026-11-19 §2.7), no tabs and no step list: the picture beside the
 * title, `{Kanal} · {zaman}` and the status; the wait's sentence; the actions; the text; the
 * details; the AI note; the content's other posts.
 */
export function DetailPanel({
  row,
  detail,
  detailError,
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
  /** Cancelled from this panel a moment ago, before any read says so. */
  markedGone?: boolean;
  onRetry: () => void;
  onGone?: (rowId: string, gone: boolean) => void;
  brake: BrakeState | null;
  onResumeAll: () => void;
  onAccounts: () => void;
  onTiktok: (slotId: string) => void;
  onSelect: (rowId: string) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (markedGone || isGone(detail, detailError)) return <GonePanel onClose={onClose} />;
  const wait = row.waits[0];
  const at = row.published_at ?? row.publish_at;
  const sub = !wait ? subStateLine(t, row.sub_state, lang) : null;
  const ai = row.ai_illustration || !!detail?.materials.some((c) => c.ai_generated);
  const before = row.kind === 'content';
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex items-center gap-3.5">
        <Thumb cover={row.cover} format={row.format} seconds={row.media?.video_seconds} size="h-[92px] w-[92px]" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="line-clamp-2 text-[17px] font-bold leading-snug">{row.title}</h2>
          <p className="text-[13px] text-muted-foreground">{channelAndTime(t, row.channel, at, lang)}</p>
          <p><span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold', PILL[STATUS_TONE[row.status]])}>{statusLine(t, row, lang)}</span></p>
        </div>
      </div>

      {wait && (
        <p data-testid="wait-sentence" className="rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2.5 text-sm">{waitSentence(t, wait, row.channel)}</p>
      )}
      {row.status === 'paused' && (
        <div className="space-y-2 rounded-lg border border-border bg-surface-muted px-3 py-2.5 text-sm">
          <p>{t('postsPage.brake.paused')}</p>
          {brake?.can_resume && <Button size="sm" variant="outline" onClick={onResumeAll}>{t('postsPage.actions.resume')}</Button>}
        </div>
      )}
      {sub?.late && <p className="text-sm"><RunNow /></p>}

      <RowActionBar row={row} onAccounts={onAccounts} onTiktok={onTiktok} onGone={onGone} />

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

      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-2.5 border-t border-border pt-3.5 text-[13px]">
        <dt className="text-muted-foreground">{t('postsPage.panel.channel')}</dt>
        <dd>{row.channel ? `${platformName(row.channel.kind)} · ${row.channel.name}` : '—'}</dd>
        <dt className="text-muted-foreground">{t('postsPage.panel.date')}</dt>
        <dd className="flex flex-wrap gap-x-2">
          {row.published_at
            ? <span>{t('postsPage.panel.publishedAt', { at: whenWords(t, row.published_at, lang) })}</span>
            : <span>{whenWords(t, row.publish_at, lang)}</span>}
          {row.published_at && row.url && (
            <a className="inline-flex items-center gap-1 text-primary underline underline-offset-4" href={row.url} target="_blank" rel="noreferrer noopener">
              {t('postsPage.panel.openPost')}<ExternalLink aria-hidden="true" className="h-3 w-3" />
            </a>
          )}
        </dd>
        <dt className="text-muted-foreground">{t('postsPage.panel.format')}</dt>
        <dd>{formatWords(t, row) || '—'}</dd>
        <dt className="text-muted-foreground">{t('postsPage.panel.category')}</dt>
        <dd>{categoryTitle(t, row)}</dd>
      </dl>

      {ai && (
        <p className="flex items-center gap-2.5 rounded-xl bg-primary/10 p-3 text-xs text-primary">
          <Info aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('postsPage.panel.ai')}
        </p>
      )}

      {row.siblings.length > 0 && (
        <p className="text-[13px]">
          <span className="text-muted-foreground">{t('postsPage.panel.same')} </span>
          {row.siblings.map((s, i) => (
            <span key={s.row_id}>
              {i > 0 && ', '}
              <button type="button" className="text-primary underline underline-offset-4" onClick={() => onSelect(s.row_id)}>
                {channelAndTime(t, s.channel, s.publish_at, lang)}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
