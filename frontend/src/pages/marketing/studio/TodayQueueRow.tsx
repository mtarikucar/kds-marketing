import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import i18n from 'i18next';
import {
  AlertTriangle,
  CalendarClock,
  ImageOff,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import {
  hasFailedTarget,
  postThumbnail,
  type SocialAccount,
  type SocialPost,
} from '../../../features/marketing/api/socialPosts.service';
import { NETWORK_META, TARGET_STATUS_TONE } from '../social/networks';
import type { SocialNetwork } from '../social/socialSchemas';

/**
 * TodayQueueRow — one thing that is supposed to go out today.
 *
 * The rail's whole value is that a row tells the truth about itself, and the
 * shapes it has to tell the truth about are not symmetrical:
 *
 *   • A POST row is a real `SocialPost` with per-network targets. Its status is
 *     NOT `post.status` (see `rowSignal`), and the targets are the only place a
 *     half-published post is visible at all.
 *   • A CAMPAIGN_ITEM row is a slot a campaign has planned and not yet
 *     materialised into a post. It has no targets, no media and no mutations —
 *     it exists here so a planned day does not read as an empty one.
 *   • A POST row the CALENDAR knows about but the post list did not return —
 *     a REP, whose token cannot read the MANAGER-only planner endpoint. Same
 *     slot, but with target-level truth genuinely unavailable, which the badge
 *     has to admit rather than paper over.
 *
 * Kept in its own file because the panel above it is already carrying five
 * mutations and a composer; a 400-line row inlined there buries both.
 */

// ── the row model ────────────────────────────────────────────────────────────

export type QueueRowKind = 'POST' | 'CAMPAIGN_ITEM';

export interface QueueRow {
  /** Post id for a POST row, campaign-item id for a slot. Unique per rail. */
  id: string;
  kind: QueueRowKind;
  /** ISO instant this row is scheduled for. The rail sorts ascending on it. */
  at: string;
  title: string;
  /**
   * The real post, when we could read it. `null` for a CAMPAIGN_ITEM and for a
   * calendar row whose post the caller's role is not allowed to fetch — those
   * two cases are told apart by `kind`, never by this field alone.
   */
  post: SocialPost | null;
  /**
   * The status string the CALENDAR carried. For a CAMPAIGN_ITEM this is the
   * item's own lifecycle (PLANNED / NEEDS_APPROVAL / …); for a post row it is a
   * copy of `post.status` and is the only status a REP ever sees.
   */
  calendarStatus: string | null;
}

/**
 * What the row is actually saying, as opposed to what `post.status` claims.
 *
 * `publishDuePost` marks a post PUBLISHED the moment ONE target succeeds, so a
 * three-network post where Instagram and TikTok both threw still reads
 * `status: 'PUBLISHED'` with a `publishedAt` timestamp. Badging that row green
 * is the single most damaging lie this rail could tell — the operator believes
 * the post is out on three networks, and it is out on one. `hasFailedTarget`
 * is therefore checked BEFORE the status is mapped, not after, and it wins.
 *
 * `PUBLISHED_UNVERIFIED` is the other half of the same honesty. A REP gets the
 * calendar's copy of `post.status` and no targets at all, so "PUBLISHED" is a
 * claim we cannot check. It is rendered as a fact we were told rather than a
 * fact we verified, which is why it does not get the success tone.
 */
export type RowSignal =
  | 'SLOT'
  | 'DRAFT'
  | 'PLANNED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'PUBLISHED_UNVERIFIED'
  | 'PARTIAL'
  | 'FAILED'
  | 'UNKNOWN';

export function rowSignal(row: QueueRow): RowSignal {
  if (row.kind === 'CAMPAIGN_ITEM') return 'SLOT';

  const post = row.post;
  if (!post) {
    // No targets in hand. Say what we were told, and mark the one value we
    // cannot stand behind.
    switch (row.calendarStatus) {
      case 'DRAFT':
        return 'DRAFT';
      case 'SCHEDULED':
        return 'PLANNED';
      case 'PUBLISHING':
        return 'PUBLISHING';
      case 'PUBLISHED':
        return 'PUBLISHED_UNVERIFIED';
      case 'FAILED':
        return 'FAILED';
      default:
        return 'UNKNOWN';
    }
  }

  // A post the backend gave up on. Checked first: a FAILED post with zero
  // targets attempted has nothing for hasFailedTarget to find.
  if (post.status === 'FAILED') return 'FAILED';
  // Then the half-published case, which outranks whatever `status` says.
  if (hasFailedTarget(post)) return 'PARTIAL';

  switch (post.status) {
    case 'DRAFT':
      return 'DRAFT';
    case 'SCHEDULED':
      return 'PLANNED';
    case 'PUBLISHING':
      return 'PUBLISHING';
    case 'PUBLISHED':
      return 'PUBLISHED';
    default:
      return 'UNKNOWN';
  }
}

/** Signals that mean "a human needs to look at this". Drives the header count. */
export const isBrokenSignal = (s: RowSignal) => s === 'FAILED' || s === 'PARTIAL';

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const SIGNAL_TONE: Record<RowSignal, BadgeTone> = {
  SLOT: 'primary',
  DRAFT: 'neutral',
  PLANNED: 'info',
  PUBLISHING: 'warning',
  PUBLISHED: 'success',
  // Deliberately NOT success — see `rowSignal`. We were told it published; we
  // could not read the per-account result, so the row does not celebrate.
  PUBLISHED_UNVERIFIED: 'neutral',
  PARTIAL: 'danger',
  FAILED: 'danger',
  UNKNOWN: 'neutral',
};

/**
 * The time, in the WORKSPACE's zone.
 *
 * The window that fetched these rows is the workspace's calendar day (see
 * todayBounds.ts), so printing the instants in the browser's zone would let the
 * list contain a row whose printed hour sits outside the day the header claims.
 * Locale still comes from i18next rather than the OS, matching utils/format.ts.
 */
export function zonedTime(zone: string, at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    // h23 rather than hour12:false: some engines render midnight as "24:00"
    // under the latter, which reads as tomorrow on a list that is about today.
    hourCycle: 'h23',
    timeZone: zone,
  };
  try {
    return new Intl.DateTimeFormat(i18n.language || 'tr', opts).format(d);
  } catch {
    // An unknown zone must not blank the whole rail — drop the zone, keep the time.
    return new Intl.DateTimeFormat(i18n.language || 'tr', { ...opts, timeZone: undefined }).format(d);
  }
}

/** `Date` → the `YYYY-MM-DDTHH:mm` a native datetime-local input expects. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Tint for a thumbnail placeholder, keyed by the network's own badge tone so a
 * post with no usable image is still recognisably an Instagram post at a glance.
 * Semantic tokens only — the fixed `primary-500`-style ramp is a suite-wide
 * failure here (see test/designSystemGuard.test.ts).
 */
const TONE_TINT: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-muted-foreground',
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  info: 'bg-info-subtle text-info',
};

/**
 * The backend knows networks this map does not — TWITTER/PINTEREST/GMB arrived
 * before the frontend meta did once already, and a bare `NETWORK_META[n].label`
 * throws on the first row rather than degrading. Every read goes through here.
 */
const networkMeta = (network: string) =>
  NETWORK_META[network as SocialNetwork] ?? {
    label: network,
    icon: CalendarClock,
    tone: 'neutral' as BadgeTone,
  };

/**
 * How long a post has to sit in PUBLISHING, untouched, before this rail is
 * willing to call the run dead and offer to reset it.
 *
 * The number is not ours: it mirrors `PUBLISHING_STUCK_MS` in
 * social-planner.service.ts, which is the line the endpoint itself draws. A
 * smaller value here would hand the operator a menu item guaranteed to 400; a
 * larger one would leave a recoverable post looking permanent for longer than
 * the backend requires. Thirty minutes is deliberately generous — a
 * multi-network video upload really can hold the publish request open for
 * minutes, and resetting a run that is merely slow would re-attach targets
 * underneath a job that is still writing to them.
 */
const PUBLISHING_STUCK_MS = 30 * 60_000;

// ── props ────────────────────────────────────────────────────────────────────

export interface TodayQueueRowProps {
  row: QueueRow;
  /** The workspace's IANA zone — what the printed time is in. */
  zone: string;
  /** Connected accounts, for target display names. May be empty (REP / failed read). */
  accounts: SocialAccount[];
  /** MANAGER or above: the planner endpoints are MANAGER-only, top to bottom. */
  canAct: boolean;
  /** ANY mutation is in flight for THIS row — never the shared `isPending`. */
  busy: boolean;
  /** Specifically the synchronous publish-now, which needs its own warning line. */
  publishing: boolean;
  /** `Date.now()` as of the panel's last minute tick — decides past vs upcoming. */
  now: number;
  onPublishNow: (post: SocialPost) => void;
  onReschedule: (post: SocialPost, iso: string) => void;
  onUnschedule: (post: SocialPost) => void;
  onEdit: (post: SocialPost) => void;
  onDelete: (post: SocialPost) => void;
}

/**
 * Per-target failure text for the chip tooltip. Credit exhaustion arrives as
 * `AI_CREDITS_EXHAUSTED: Monthly AI credit limit reached (100)…` — a raw error
 * code in English — so it is the one case translated rather than echoed.
 */
function useTargetErrorLabel() {
  const { t } = useTranslation('marketing');
  return (network: string, error?: string | null): string | undefined => {
    if (!error) return undefined;
    return error.includes('AI_CREDITS_EXHAUSTED')
      ? `${network}: ${t('credits.exhausted.short', 'Out of AI credits')}`
      : `${network}: ${error}`;
  };
}

export function TodayQueueRow({
  row,
  zone,
  accounts,
  canAct,
  busy,
  publishing,
  now,
  onPublishNow,
  onReschedule,
  onUnschedule,
  onEdit,
  onDelete,
}: TodayQueueRowProps) {
  const { t } = useTranslation('marketing');
  const targetErrorLabel = useTargetErrorLabel();
  const [thumbBroken, setThumbBroken] = useState(false);
  const [whenOpen, setWhenOpen] = useState(false);
  const [when, setWhen] = useState('');

  const post = row.post;
  const signal = rowSignal(row);
  const at = new Date(row.at).getTime();
  /**
   * Rows whose hour has passed are drawn recessively rather than hidden or
   * moved to a second list. Hiding them loses the morning's evidence; a second
   * list doubles the headers on a column that is already narrow. This is
   * TimelinePanel's `data-weight` idiom, and — as there — ONE expression feeds
   * both the attribute and the class list, so a row cannot report that it is
   * recessive while being drawn at full weight.
   */
  const weight: 'recessive' | 'normal' = Number.isFinite(at) && at < now ? 'recessive' : 'normal';

  const thumb = post ? postThumbnail(post) : null;
  const targets = post?.targets ?? [];
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? null;

  // publish-now is DRAFT/SCHEDULED-only on the backend (`Cannot publish a post
  // in status: …`), so offering it on a PUBLISHED or PUBLISHING row would be an
  // affordance that can only ever 400.
  const canPublishNow = !!post && (post.status === 'DRAFT' || post.status === 'SCHEDULED');
  /**
   * A publish run that died — the worker crashed, or the container was replaced
   * mid-deploy — leaves the post in PUBLISHING forever, and PUBLISHING is a
   * status nothing else on this screen will touch: it cannot be published, it
   * cannot be moved, it cannot be edited. Without this the operator's only exit
   * is deleting a post that may already be live on one of its networks.
   *
   * `unschedulePost` was widened for exactly this case and takes it after
   * `PUBLISHING_STUCK_MS` of no writes, so the row offers it on the same
   * condition and calls it what it is rather than "Taslağa al" — pulling a post
   * back from a dead run is a repair, not a change of plan.
   */
  const stuckPublishing =
    !!post && post.status === 'PUBLISHING' && now - Date.parse(post.updatedAt) >= PUBLISHING_STUCK_MS;
  // unschedule accepts SCHEDULED and FAILED (the backend lane widened it for
  // exactly this rail), plus a PUBLISHING post that has been stuck 30 minutes.
  const canUnschedule =
    !!post && (post.status === 'SCHEDULED' || post.status === 'FAILED' || stuckPublishing);
  const canReschedule = !!post && (post.status === 'SCHEDULED' || post.status === 'DRAFT');
  /**
   * Edit is three calls — unschedule, patch, schedule — and the first two have
   * the narrowest doors on the controller: `unschedulePost` refuses anything it
   * will not pull back to draft, and `PATCH` refuses anything that is not
   * already one. On a PUBLISHED or a live PUBLISHING row "Düzenle" could
   * therefore only ever 400, which is the same affordance-that-cannot-work the
   * publish gate above exists to prevent — and it was the one action on this row
   * with no status gate at all.
   *
   * A stuck run is deliberately not offered the edit either, even though the
   * backend would now allow the unschedule. Its way back is the reset, which
   * lands the post in drafts — where editing is an ordinary thing to do and the
   * operator can see what the dead run left behind before changing it.
   */
  const canEdit =
    !!post && (post.status === 'DRAFT' || post.status === 'SCHEDULED' || post.status === 'FAILED');
  const hasMenu = canAct && !!post;

  const onWhenOpenChange = (open: boolean) => {
    // Seed on the way IN rather than from a `useEffect` on `post`: the rail
    // refetches after every mutation, so an effect would reset a half-typed
    // time under the operator's cursor each time a sibling row published.
    if (open) setWhen(toLocalInput(post?.scheduledAt ?? row.at));
    setWhenOpen(open);
  };

  const submitWhen = () => {
    if (!post || !when) return;
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) return;
    setWhenOpen(false);
    onReschedule(post, d.toISOString());
  };

  return (
    <li
      data-testid={`tq-row-${row.id}`}
      data-kind={row.kind}
      data-signal={signal}
      data-weight={weight}
      data-busy={busy ? 'true' : 'false'}
      className={
        weight === 'recessive'
          ? 'flex gap-3 py-2.5 opacity-60'
          : 'flex gap-3 py-2.5'
      }
    >
      <span className="w-11 shrink-0 pt-0.5 text-caption tabular-nums text-muted-foreground">
        {zonedTime(zone, row.at)}
      </span>

      {/* THUMBNAIL. `postThumbnail` already returns null once R2 has purged the
          media (options.mediaDeletedAt), but a live URL can still 404 for its
          own reasons — a CDN miss, a revoked bucket — and a bare <img> answers
          that with the browser's broken-image glyph. `onError` demotes it to
          the same network-tinted placeholder, so "no picture" always looks
          deliberate instead of looking like the row itself is broken. */}
      <ThumbBox
        url={thumb && !thumbBroken ? thumb : null}
        network={targets[0]?.network ?? null}
        onError={() => setThumbBroken(true)}
        alt={row.title}
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground" title={row.title}>
          {row.title || t('studio.today.untitled', 'Başlıksız gönderi')}
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          <StatusBadge signal={signal} at={row.at} zone={zone} />

          {/* PER-TARGET CHIPS. The status badge above is a summary and a summary
              cannot say WHICH network failed — the operator's next action
              (reconnect Instagram? retry TikTok?) depends entirely on that. */}
          {targets.map((tg) => {
            const meta = networkMeta(tg.network);
            const name = accountName(tg.socialAccountId);
            return (
              <Badge
                key={tg.id}
                size="sm"
                tone={TARGET_STATUS_TONE[tg.status] ?? 'neutral'}
                data-testid={`tq-target-${tg.id}`}
                data-status={tg.status}
                // The failure reason is the whole point of the chip being
                // separate; it goes in the title so the row stays one line.
                // The one reason we can name properly is named properly: a
                // credits failure arrives as the raw backend code, which is
                // neither Turkish nor actionable.
                title={targetErrorLabel(meta.label, tg.error) ?? meta.label}
              >
                <meta.icon className="h-3 w-3" aria-hidden="true" />
                <span className="max-w-[9rem] truncate">{name ?? meta.label}</span>
                {tg.status === 'FAILED' && (
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                )}
              </Badge>
            );
          })}

          {/* A campaign slot has no post yet, so there is nothing here to
              publish, edit or delete. What there IS is the campaign that
              planned it.

              The list route, NOT `/social-campaigns/:id`, and the distinction
              is worth the two lines it costs. `UnifiedCalendarService` builds a
              CAMPAIGN_ITEM row from `SocialCampaignItem`, so `item.id` is an
              ITEM id — while `/social-campaigns/:id` resolves a CAMPAIGN
              through `GET /social-campaigns/:id`. Passing one to the other
              404s, on every campaign row, every day. The calendar carries no
              `socialCampaignId`, and resolving it would mean listing every
              campaign and then its items — several requests to decorate one
              link. So the row goes to the campaigns surface, which is one click
              from the right campaign and is never broken. */}
          {row.kind === 'CAMPAIGN_ITEM' && (
            <Link
              to="/social-campaigns"
              data-testid={`tq-campaign-link-${row.id}`}
              className="text-caption text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t('studio.today.openCampaign', 'Kampanyayı aç')}
            </Link>
          )}
        </div>

        {/* The publish endpoint holds the request open while every network
            upload runs for real. Without this line a multi-target video looks
            like a hung button for two minutes and gets clicked again. */}
        {publishing && (
          <p role="status" className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
            <Spinner className="h-3 w-3" />
            {t('studio.today.publishSlow', 'Yayınlanıyor — bu bir dakika sürebilir, sayfayı kapatma.')}
          </p>
        )}

        {/* A FAILED post is not retried by a button on this rail, and saying
            otherwise would be the second lie this panel refuses to tell: the
            only route back is DRAFT, and from there the composer. */}
        {signal === 'FAILED' && canAct && (
          <p className="mt-1 text-caption text-muted-foreground">
            {t(
              'studio.today.failedHint',
              'Yeniden denemek için taslağa al — bu gönderiyi tekrar göndermez, taslaklara geri koyar.',
            )}
          </p>
        )}
      </div>

      {hasMenu && (
        <div className="flex shrink-0 items-start gap-1">
          {busy && <Spinner className="mt-1.5 h-4 w-4 text-muted-foreground" />}

          {/* RESCHEDULE gets its own trigger rather than a slot in the menu,
              for two reasons. It needs a FORM, and a Radix menu closes on the
              first click inside it. And a popover opened FROM a menu item loses
              a fight it cannot win: the menu restores focus to its trigger as
              it closes, the already-open popover reads that as a focus-outside,
              and dismisses itself before the operator can type. Moving the time
              is also the most common thing anyone does to a queued post, so it
              has earned a button of its own. */}
          {canReschedule && (
          <Popover open={whenOpen} onOpenChange={onWhenOpenChange}>
            <PopoverTrigger asChild>
              <IconButton
                size="sm"
                aria-label={t('studio.today.changeTime', 'Zamanı değiştir')}
                data-testid={`tq-when-${row.id}`}
                disabled={busy}
              >
                <CalendarClock className="h-4 w-4" />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-2">
              <p className="text-caption font-medium text-foreground">
                {t('studio.today.newTime', 'Yeni zaman')}
              </p>
              <Input
                type="datetime-local"
                aria-label={t('studio.today.newTime', 'Yeni zaman')}
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
              <p className="text-micro text-muted-foreground">
                {t(
                  'studio.today.newTimeHint',
                  'Bu alan cihazının saatini kullanır; kaydedince listede işletmenin saatiyle görünür.',
                )}
              </p>
              <Button size="sm" className="w-full" disabled={!when || busy} onClick={submitWhen}>
                {t('studio.today.saveTime', 'Zamanı kaydet')}
              </Button>
            </PopoverContent>
          </Popover>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                aria-label={t('studio.today.rowActions', 'Satır işlemleri')}
                data-testid={`tq-actions-${row.id}`}
                disabled={busy}
              >
                <MoreHorizontal className="h-4 w-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canPublishNow && (
                <DropdownMenuItem
                  data-testid={`tq-publish-${row.id}`}
                  onSelect={() => post && onPublishNow(post)}
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                  {t('studio.today.publishNow', 'Şimdi yayınla')}
                </DropdownMenuItem>
              )}
              {canEdit && (
                <DropdownMenuItem
                  data-testid={`tq-edit-${row.id}`}
                  onSelect={() => post && onEdit(post)}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  {t('studio.today.edit', 'Düzenle')}
                </DropdownMenuItem>
              )}
              {canUnschedule && (
                <DropdownMenuItem
                  data-testid={`tq-unschedule-${row.id}`}
                  onSelect={() => post && onUnschedule(post)}
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" />
                  {stuckPublishing
                    ? t('studio.today.resetStuck', 'Sıkışan gönderiyi sıfırla')
                    : t('studio.today.toDraft', 'Taslağa al')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid={`tq-delete-${row.id}`}
                className="text-danger"
                onSelect={() => post && onDelete(post)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t('studio.today.delete', 'Sil')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

/** The thumbnail, or the network-tinted stand-in for one. */
function ThumbBox({
  url,
  network,
  alt,
  onError,
}: {
  url: string | null;
  network: string | null;
  alt: string;
  onError: () => void;
}) {
  const meta = networkMeta(network ?? '');
  if (url) {
    return (
      <img
        src={url}
        alt={alt}
        loading="lazy"
        onError={onError}
        className="h-10 w-10 shrink-0 rounded-md border border-border object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border ${TONE_TINT[meta.tone]}`}
    >
      {network ? <meta.icon className="h-4 w-4" /> : <ImageOff className="h-4 w-4" />}
    </span>
  );
}

/**
 * The row's one-word verdict.
 *
 * The SCHEDULED wording is deliberate and is the second correctness rule of
 * this rail. A scheduled post is an INTENT, not a queue position: the publish
 * job can have been cancelled, or have exhausted its retries, with the row
 * still reading SCHEDULED forever. "09:00'da yayınlanacak" is a promise the UI
 * has no standing to make, so the badge says the post was PLANNED for 09:00 and
 * leaves the promise to the thing that can actually keep it.
 */
function StatusBadge({ signal, at, zone }: { signal: RowSignal; at: string; zone: string }) {
  const { t } = useTranslation('marketing');
  const time = zonedTime(zone, at);

  const label: Record<RowSignal, string> = {
    SLOT: t('studio.today.sig.slot', 'Kampanya içeriği — gönderi henüz oluşturulmadı'),
    DRAFT: t('studio.today.sig.draft', 'Taslak'),
    PLANNED: t('studio.today.sig.planned', '{{time}} için planlandı', { time }),
    PUBLISHING: t('studio.today.sig.publishing', 'Yayınlanıyor'),
    PUBLISHED: t('studio.today.sig.published', 'Yayınlandı'),
    PUBLISHED_UNVERIFIED: t('studio.today.sig.publishedUnverified', 'Yayınlandı (hesap durumu okunamadı)'),
    PARTIAL: t('studio.today.sig.partial', 'Bazı hesaplarda başarısız'),
    FAILED: t('studio.today.sig.failed', 'Başarısız'),
    UNKNOWN: t('studio.today.sig.unknown', 'Durum bilinmiyor'),
  };

  return (
    <Badge size="sm" tone={SIGNAL_TONE[signal]} data-testid="tq-signal" data-signal={signal}>
      {isBrokenSignal(signal) && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
      {label[signal]}
    </Badge>
  );
}
