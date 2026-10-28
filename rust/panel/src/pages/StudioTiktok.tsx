import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ImageOff } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import * as api from '@/api/studio';
import { isApiError } from '@/api/client';
import { failureText } from '@/lib/delivery';
import { formatDateTime, formatNumber } from '@/lib/format';
import type tr from '@/i18n/tr.json';
import { StudioError, buttonClass, inputClass, useStudioKey, useStudioMutation } from './StudioShared';

// The TikTok posting screen, as TikTok's Content Sharing Guidelines ask for it
// (https://developers.tiktok.com/doc/content-sharing-guidelines, "Required UX Implementation in
// Your App"): the account read fresh when the screen renders, its nickname, a stop when it may
// not post now, the video's length against its limit, an editable caption, a privacy chosen from
// its own options with no default, interactions off unless allowed (greyed out when the creator
// turned them off; comments only on photos), the commercial content disclosure, the declaration
// above the button, a preview with nothing laid over it, and nothing sent before the button is
// pressed. Once posted, the screen says processing takes minutes and shows the post's status.
// Under the account's name: its counters and its latest public videos, when TikTok gave them;
// a published post's own counters read in the slot's detail. The human may instead send the post
// to their TikTok drafts (the Content Posting API's upload): TikTok then notifies them in its
// inbox to finish editing and post it there, so the Direct Post's settings are left to TikTok.

const MUSIC_USAGE = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_CONTENT_POLICY = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

type Refusal = keyof typeof tr.studio.tiktok.refused;
type Counter = keyof typeof tr.studio.tiktok.counter;

/** The account's counters (`user.info.stats`) and a post's (`video.list`), by TikTok's names. */
const ACCOUNT_COUNTERS: Counter[] = ['follower_count', 'following_count', 'likes_count', 'video_count'];
const POST_COUNTERS: Counter[] = ['view_count', 'like_count', 'comment_count', 'share_count'];

/** The counters of `names` TikTok gave in `metrics`, in that order; nothing when it gave none. */
function Counters({
  metrics,
  names,
  label,
}: {
  metrics: Record<string, number>;
  names: Counter[];
  label?: string;
}) {
  const { t, i18n } = useTranslation();
  const given = names.filter((name) => typeof metrics[name] === 'number');
  if (!given.length) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {given.map((name) => (
        <li key={name}>
          {t(`studio.tiktok.counter.${name}`)}: {formatNumber(metrics[name], i18n.language)}
        </li>
      ))}
    </ul>
  );
}

/**
 * A listed post's cover, loaded by the browser straight from TikTok; a neutral placeholder when
 * there is none or it does not load (the list names no post kind, so the placeholder is generic).
 */
function Cover({ url }: { url: string | null }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-16 w-12 shrink-0 rounded object-cover"
      />
    );
  }
  return (
    <span className="flex h-16 w-12 shrink-0 flex-col items-center justify-center gap-1 rounded bg-surface-muted text-center text-[10px] leading-tight text-muted-foreground">
      <ImageOff aria-hidden="true" className="h-4 w-4" />
      {t('studio.tiktok.noCover')}
    </span>
  );
}

/** The account's latest public videos, each linking to its TikTok page. */
function RecentVideos({ posts }: { posts: api.RecentPost[] }) {
  const { t, i18n } = useTranslation();
  if (!posts.length) {
    return <p className="text-xs text-muted-foreground">{t('studio.tiktok.noRecentVideos')}</p>;
  }
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-medium">{t('studio.tiktok.recentVideos')}</h4>
      <ul aria-label={t('studio.tiktok.recentVideos')} className="grid gap-2 sm:grid-cols-2">
        {posts.map((post) => {
          const title = post.title ?? t('studio.tiktok.untitled');
          return (
            <li key={post.id} className="flex min-w-0 gap-2 rounded-md border border-border p-2">
              <Cover url={post.cover_image_url} />
              <div className="min-w-0 space-y-1">
                {post.share_url ? (
                  <a
                    className="block truncate font-medium underline"
                    href={post.share_url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {title}
                  </a>
                ) : (
                  <span className="block truncate font-medium">{title}</span>
                )}
                {post.created_at && (
                  <time dateTime={post.created_at} className="block text-xs text-muted-foreground">
                    {formatDateTime(post.created_at, i18n.language)}
                  </time>
                )}
                <Counters metrics={post.metrics} names={POST_COUNTERS} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What the screen shows of the account under its name, when TikTok gave it. */
function AccountView({ posting }: { posting: api.TiktokPosting }) {
  const { t } = useTranslation();
  return (
    <>
      {posting.account_metrics && (
        <Counters
          metrics={posting.account_metrics}
          names={ACCOUNT_COUNTERS}
          label={t('studio.tiktok.accountCounters')}
        />
      )}
      {posting.recent_posts && <RecentVideos posts={posting.recent_posts} />}
    </>
  );
}

/**
 * A published TikTok post's counters in its slot's detail: read live, else the latest
 * measurement's; nothing when the slot has no post, or the read failed.
 */
export function TiktokPostCounters({ slotId }: { slotId: string }) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const counters = useQuery({
    queryKey: [...key, 'tiktok', 'metrics', slotId],
    queryFn: () => api.tiktokMetrics(slotId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const data = counters.data;
  if (!data?.post) return null;
  if (data.draft) {
    return <p className="text-xs text-muted-foreground">{t('studio.tiktok.sentToDrafts')}</p>;
  }
  if (!data.metrics) {
    return <p className="text-xs text-muted-foreground">{t('studio.tiktok.noCounters')}</p>;
  }
  return (
    <div className="space-y-1">
      <Counters metrics={data.metrics} names={POST_COUNTERS} label={t('studio.tiktok.postCounters')} />
      <p className="text-xs text-muted-foreground">
        {data.source === 'measurement'
          ? t('studio.tiktok.measuredCounters', { time: formatDateTime(data.read_at, i18n.language) })
          : t('studio.tiktok.liveCounters')}
      </p>
    </div>
  );
}

function isPrivacyLevel(level: string): level is api.TiktokPrivacyLevel {
  return (api.TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(level);
}

function privacyLabel(t: TFunction, level: string): string {
  return isPrivacyLevel(level) ? t(`studio.tiktok.privacyLevel.${level}`) : level;
}

/** The refusal reason a TikTok error names (`details.reason`), when the panel has words for it. */
function refusalOf(error: unknown): Refusal | null {
  if (!isApiError(error)) return null;
  const reason = String(error.details.reason ?? '');
  const known: Refusal[] = [
    'tiktok_cannot_post_now',
    'tiktok_privacy_not_chosen',
    'tiktok_privacy_not_offered',
    'tiktok_branded_content_private',
    'tiktok_commercial_unspecified',
    'tiktok_commercial_not_disclosed',
    'tiktok_interaction_disabled',
    'tiktok_photo_interaction',
    'tiktok_video_too_long',
    'tiktok_title_too_long',
    'tiktok_media_unsupported',
    'tiktok_creator_info_unavailable',
    'tiktok_reconnect_for_drafts',
    'tiktok_draft_settings',
  ];
  return known.find((k) => k === reason) ?? null;
}

/** A TikTok refusal in the owner's words, any other error as the Studio shows errors. */
function TiktokError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const refusal = refusalOf(error);
  if (!refusal) return <StudioError error={error} />;
  return (
    <p role="alert" className="rounded-md bg-danger-subtle p-3 text-sm">
      {t(`studio.tiktok.refused.${refusal}`)}
    </p>
  );
}

/** The account the post goes to: its avatar and nickname (and handle), as TikTok names them. */
function Creator({ creator }: { creator: api.TiktokCreator }) {
  const { t } = useTranslation();
  const nickname = creator.nickname ?? creator.username ?? '—';
  return (
    <div className="flex items-center gap-2 text-sm">
      {creator.avatar_url && (
        <img
          src={creator.avatar_url}
          alt=""
          referrerPolicy="no-referrer"
          className="h-8 w-8 rounded-full border border-border object-cover"
        />
      )}
      <p className="font-medium">
        {creator.username && creator.nickname
          ? t('studio.tiktok.postingAsUser', { nickname, username: creator.username })
          : t('studio.tiktok.postingAs', { nickname })}
      </p>
    </div>
  );
}

/** When the slot is sent, in the owner's time zone. */
function when(slot: api.Slot, language: string): string {
  return api.instant(slot.scheduled_at).toLocaleString(language, {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The status line of the slot's latest publish attempt, and the post's link once it is live; a
 * draft's in its own words (sent to the creator's TikTok drafts, never a post here).
 */
function statusOf(
  t: TFunction,
  attempts: api.PublishAttempt[],
  draft = false,
): { text: string; url: string | null; active: boolean } {
  const last = attempts[attempts.length - 1];
  if (!last) return { text: t('studio.tiktok.status.waiting'), url: null, active: false };
  const evidence = typeof last.outcome?.evidence === 'object' ? last.outcome.evidence : null;
  if (last.state === 'succeeded') {
    return draft
      ? { text: t('studio.tiktok.draftStatus.sent'), url: null, active: false }
      : { text: t('studio.tiktok.status.published'), url: evidence?.url ?? null, active: false };
  }
  if (last.state === 'queued' || last.state === 'sending') {
    const text = draft ? t('studio.tiktok.draftStatus.sending') : t('studio.tiktok.status.sending');
    return { text, url: null, active: true };
  }
  if (last.state === 'unknown' && last.outcome?.status === 'observed') {
    const text = draft
      ? t('studio.tiktok.draftStatus.processing')
      : t('studio.tiktok.status.processing');
    return { text, url: null, active: true };
  }
  const reason = last.failure_reason ? failureText(t, last.failure_reason) : t('studio.failed');
  return { text: t('studio.tiktok.status.failed', { reason }), url: null, active: false };
}

/**
 * A TikTok slot posted from its screen: when it goes out, that TikTok takes minutes to process
 * it (or, for a draft, that its inbox notification finishes it), and its status, read again
 * while TikTok is still working on it.
 */
export function TiktokPostStatus({ slot }: { slot: api.Slot }) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  // Whether the choice was a draft: no TikTok call before the slot is sent.
  const sent = useQuery({
    queryKey: [...key, 'tiktok', 'metrics', slot.id],
    queryFn: () => api.tiktokMetrics(slot.id),
  });
  const draft = sent.data?.draft ?? false;
  const detail = useQuery({
    queryKey: [...key, 'slot', slot.id],
    queryFn: () => api.slotGet(slot.id),
    refetchInterval: (query) =>
      query.state.data && statusOf(t, query.state.data.attempts).active ? 15_000 : false,
  });
  const status = detail.data ? statusOf(t, detail.data.attempts, draft) : null;
  const time = when(slot, i18n.language);
  return (
    <div className="space-y-1 rounded-md border border-border bg-surface-muted p-3 text-sm">
      {!detail.data?.attempts.length && (
        <p>{draft ? t('studio.tiktok.approvedDraft', { time }) : t('studio.tiktok.approved', { time })}</p>
      )}
      <p className="text-muted-foreground">
        {draft ? t('studio.tiktok.draftSent') : t('studio.tiktok.processing')}
      </p>
      {status && (
        <p role="status" className="font-medium">
          {status.text}
        </p>
      )}
      {status?.url && (
        <a className="underline" href={status.url} target="_blank" rel="noreferrer noopener">
          {t('studio.tiktok.viewPost')}
        </a>
      )}
      <StudioError error={detail.error} />
    </div>
  );
}

/** The posting screen of a TikTok slot awaiting its human (see the file's head). */
export function TiktokPostingScreen({ slot }: { slot: api.Slot }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const ids = useId();
  // Read fresh whenever the screen renders: TikTok's settings may have changed since.
  const posting = useQuery({
    queryKey: [...key, 'tiktok', slot.id, slot.revision],
    queryFn: () => api.tiktokPosting(slot.id),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const [title, setTitle] = useState<string>();
  const [privacy, setPrivacy] = useState('');
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [brandedContent, setBrandedContent] = useState(false);
  const [length, setLength] = useState<number>();
  const [mode, setMode] = useState<api.TiktokPostMode>('direct_post');
  const data = posting.data;
  const caption = title ?? data?.title ?? '';
  // What is sent is what the screen shows: an interaction greyed out (by a fresher read of the
  // account, or on photos) is off.
  const shown = data?.media.kind === 'video';
  // A draft takes only what TikTok takes for it: a video nothing but the file, photos their
  // caption; the rest is chosen in TikTok.
  const draft = mode === 'draft' && Boolean(data?.drafts_available);
  const choice: api.TiktokPost = draft
    ? {
        mode: 'draft',
        title: shown ? '' : caption,
        privacy_level: '',
        allow_comment: false,
        allow_duet: false,
        allow_stitch: false,
        disclose_commercial: false,
        your_brand: false,
        branded_content: false,
      }
    : {
        mode: 'direct_post',
        title: caption,
        privacy_level: privacy,
        allow_comment: allowComment && !data?.creator.comment_disabled,
        allow_duet: allowDuet && shown && !data?.creator.duet_disabled,
        allow_stitch: allowStitch && shown && !data?.creator.stitch_disabled,
        disclose_commercial: disclose,
        your_brand: disclose && yourBrand,
        branded_content: disclose && brandedContent,
      };
  const post = useStudioMutation(() => api.tiktokPost(slot.id, slot.revision, choice));
  const screenName = t('studio.tiktok.screen');
  if (posting.isPending) {
    return <p className="text-sm text-muted-foreground">{t('studio.tiktok.loading')}</p>;
  }
  if (!data) return <TiktokError error={posting.error} />;
  const { creator } = data;
  if (creator.cannot_post) {
    return (
      <div className="space-y-2 rounded-md border border-border p-3">
        <Creator creator={creator} />
        <AccountView posting={data} />
        <p role="alert" className="text-sm text-danger">
          {t('studio.tiktok.cannotPost')}
        </p>
      </div>
    );
  }
  if (post.isSuccess) {
    return (
      <div className="space-y-1 rounded-md border border-border bg-surface-muted p-3 text-sm">
        <p role="status">{draft ? t('studio.tiktok.draftSent') : t('studio.tiktok.processing')}</p>
      </div>
    );
  }
  const video = data.media.kind === 'video';
  const max = creator.max_video_post_duration_sec;
  const tooLong = video && max !== null && length !== undefined && length > max;
  const unspecified = !draft && disclose && !yourBrand && !brandedContent;
  const privateBranded = brandedContent && privacy === 'SELF_ONLY';
  const fits = caption.length <= data.max_title_units;
  const ready = draft
    ? !tooLong && (video || fits)
    : privacy !== '' && !unspecified && !privateBranded && !tooLong && fits;
  const interaction = (
    name: 'comment' | 'duet' | 'stitch',
    checked: boolean,
    set: (v: boolean) => void,
    off: boolean,
  ) => (
    <div className={`flex flex-wrap items-center gap-2 ${off ? 'text-muted-foreground opacity-60' : ''}`}>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked && !off}
          disabled={off}
          onChange={(e) => set(e.target.checked)}
          aria-describedby={off ? `${ids}-${name}-off` : undefined}
        />
        <span>{t(`studio.tiktok.${name}`)}</span>
      </label>
      {off && (
        <span id={`${ids}-${name}-off`} className="text-xs">
          ({t('studio.tiktok.interactionOff')})
        </span>
      )}
    </div>
  );
  return (
    <form
      aria-label={screenName}
      className="space-y-3 rounded-md border border-primary p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) post.mutate();
      }}
    >
      <h3 className="font-medium">{screenName}</h3>
      <Creator creator={creator} />
      <AccountView posting={data} />
      <div role="radiogroup" aria-labelledby={`${ids}-mode`} className="space-y-1">
        <p id={`${ids}-mode`}>{t('studio.tiktok.mode')}</p>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={!draft}
            onChange={() => setMode('direct_post')}
          />
          <span>{t('studio.tiktok.modeDirect')}</span>
        </label>
        <label className={`flex items-center gap-2 ${data.drafts_available ? '' : 'opacity-60'}`}>
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={draft}
            disabled={!data.drafts_available}
            aria-describedby={data.drafts_available ? undefined : `${ids}-reconnect`}
            onChange={() => setMode('draft')}
          />
          <span>{t('studio.tiktok.modeDraft')}</span>
        </label>
        {!data.drafts_available && (
          <p id={`${ids}-reconnect`} className="text-xs">
            {t('studio.tiktok.reconnectForDrafts')}{' '}
            <Link to="/capabilities" className="underline">
              {t('studio.reconnect')}
            </Link>
          </p>
        )}
        {draft && <p className="text-xs text-muted-foreground">{t('studio.tiktok.draftHelp')}</p>}
      </div>
      <div role="group" aria-label={t('studio.tiktok.preview')} className="flex flex-wrap gap-2">
        {data.previews.map((m, i) =>
          m.mime.startsWith('video/') ? (
            <video
              key={i}
              aria-label={t('studio.tiktok.video')}
              src={m.url}
              controls
              preload="metadata"
              className="max-h-64 max-w-full rounded-md border border-border"
              onLoadedMetadata={(e) => {
                const seconds = e.currentTarget.duration;
                if (Number.isFinite(seconds)) setLength(Math.ceil(seconds));
              }}
            />
          ) : (
            <img
              key={i}
              src={m.url}
              alt={t('studio.tiktok.photo', { n: i + 1 })}
              referrerPolicy="no-referrer"
              className="h-24 w-24 rounded-md border border-border object-cover"
            />
          ),
        )}
      </div>
      {tooLong && (
        <p role="alert" className="text-danger">
          {t('studio.tiktok.tooLong', { length, max })}
        </p>
      )}
      {draft && video ? (
        <p className="text-xs text-muted-foreground">{t('studio.tiktok.draftNoCaption')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-caption`}>{t('studio.tiktok.caption')}</label>
          <textarea
            id={`${ids}-caption`}
            className={inputClass}
            rows={4}
            value={caption}
            maxLength={data.max_title_units}
            aria-describedby={`${ids}-caption-help`}
            onChange={(e) => setTitle(e.target.value)}
          />
          <span id={`${ids}-caption-help`} className="text-xs text-muted-foreground">
            {t('studio.tiktok.captionHelp')}{' '}
            {t('studio.tiktok.captionCount', { count: caption.length, max: data.max_title_units })}
          </span>
        </div>
      )}
      {!draft && (
        <>
          <label className="flex flex-col gap-1">
            <span>{t('studio.tiktok.privacy')}</span>
            <select
              className={inputClass}
              value={privacy}
              required
              onChange={(e) => setPrivacy(e.target.value)}
            >
              <option value="" disabled>
                {t('studio.tiktok.privacyPlaceholder')}
              </option>
              {creator.privacy_level_options.map((level) => {
                const blocked = level === 'SELF_ONLY' && brandedContent;
                return (
                  <option
                    key={level}
                    value={level}
                    disabled={blocked}
                    title={blocked ? t('studio.tiktok.brandedNotPrivate') : undefined}
                  >
                    {privacyLabel(t, level)}
                  </option>
                );
              })}
            </select>
          </label>
          <fieldset className="space-y-1">
            <legend>{t('studio.tiktok.interactions')}</legend>
            {interaction('comment', allowComment, setAllowComment, creator.comment_disabled)}
            {video && interaction('duet', allowDuet, setAllowDuet, creator.duet_disabled)}
            {video && interaction('stitch', allowStitch, setAllowStitch, creator.stitch_disabled)}
          </fieldset>
          <fieldset className="space-y-2">
            <label className="flex items-center gap-2" title={t('studio.tiktok.discloseHelp')}>
              <input
                type="checkbox"
                role="switch"
                checked={disclose}
                onChange={(e) => {
                  setDisclose(e.target.checked);
                  if (!e.target.checked) {
                    setYourBrand(false);
                    setBrandedContent(false);
                  }
                }}
              />
              <span>{t('studio.tiktok.disclose')}</span>
            </label>
            <p className="text-xs text-muted-foreground">{t('studio.tiktok.discloseHelp')}</p>
            {disclose && (
              <div className="space-y-2 ps-6">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={yourBrand}
                    onChange={(e) => setYourBrand(e.target.checked)}
                  />
                  <span>
                    <span className="block">{t('studio.tiktok.yourBrand')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('studio.tiktok.yourBrandHelp')}
                    </span>
                  </span>
                </label>
                <label
                  className={`flex items-start gap-2 ${privacy === 'SELF_ONLY' ? 'opacity-60' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={brandedContent}
                    disabled={privacy === 'SELF_ONLY'}
                    aria-describedby={privacy === 'SELF_ONLY' ? `${ids}-branded-private` : undefined}
                    onChange={(e) => setBrandedContent(e.target.checked)}
                  />
                  <span>
                    <span className="block">{t('studio.tiktok.brandedContent')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('studio.tiktok.brandedContentHelp')}
                    </span>
                  </span>
                </label>
                {privacy === 'SELF_ONLY' && (
                  <p id={`${ids}-branded-private`} className="text-xs">
                    {t('studio.tiktok.brandedNotPrivate')}
                  </p>
                )}
                {(brandedContent || yourBrand) && (
                  <p className="text-xs font-medium">
                    {t(brandedContent ? 'studio.tiktok.paidLabel' : 'studio.tiktok.promotionalLabel')}
                  </p>
                )}
              </div>
            )}
          </fieldset>
        </>
      )}
      <p className="text-xs">
        <Trans
          i18nKey={
            !draft && brandedContent && disclose
              ? 'studio.tiktok.declarationBranded'
              : 'studio.tiktok.declarationMusic'
          }
          // Each link's text is the translation's.
          components={{
            music: (
              <a className="underline" href={MUSIC_USAGE} target="_blank" rel="noreferrer noopener" />
            ),
            branded: (
              <a
                className="underline"
                href={BRANDED_CONTENT_POLICY}
                target="_blank"
                rel="noreferrer noopener"
              />
            ),
          }}
        />
      </p>
      <span className="inline-block" title={unspecified ? t('studio.tiktok.commercialRequired') : undefined}>
        <button className={buttonClass} disabled={!ready || post.isPending}>
          {post.isPending
            ? t('studio.tiktok.posting')
            : draft
              ? t('studio.tiktok.sendDraft')
              : t('studio.tiktok.post')}
        </button>
      </span>
      {unspecified && <p className="text-xs text-danger">{t('studio.tiktok.commercialRequired')}</p>}
      <TiktokError error={post.error} />
    </form>
  );
}
