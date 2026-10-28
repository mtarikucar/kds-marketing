import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import * as api from '@/api/studio';
import { isApiError } from '@/api/client';
import { failureText } from '@/lib/delivery';
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

const MUSIC_USAGE = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_CONTENT_POLICY = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

type Refusal = keyof typeof tr.studio.tiktok.refused;

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

/** The status line of the slot's latest publish attempt, and the post's link once it is live. */
function statusOf(
  t: TFunction,
  attempts: api.PublishAttempt[],
): { text: string; url: string | null; active: boolean } {
  const last = attempts[attempts.length - 1];
  if (!last) return { text: t('studio.tiktok.status.waiting'), url: null, active: false };
  const evidence = typeof last.outcome?.evidence === 'object' ? last.outcome.evidence : null;
  if (last.state === 'succeeded') {
    return { text: t('studio.tiktok.status.published'), url: evidence?.url ?? null, active: false };
  }
  if (last.state === 'queued' || last.state === 'sending') {
    return { text: t('studio.tiktok.status.sending'), url: null, active: true };
  }
  if (last.state === 'unknown' && last.outcome?.status === 'observed') {
    return { text: t('studio.tiktok.status.processing'), url: null, active: true };
  }
  const reason = last.failure_reason ? failureText(t, last.failure_reason) : t('studio.failed');
  return { text: t('studio.tiktok.status.failed', { reason }), url: null, active: false };
}

/**
 * A TikTok slot posted from its screen: when it goes out, that TikTok takes minutes to process
 * it, and its status, read again while TikTok is still working on it.
 */
export function TiktokPostStatus({ slot }: { slot: api.Slot }) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const detail = useQuery({
    queryKey: [...key, 'slot', slot.id],
    queryFn: () => api.slotGet(slot.id),
    refetchInterval: (query) =>
      query.state.data && statusOf(t, query.state.data.attempts).active ? 15_000 : false,
  });
  const status = detail.data ? statusOf(t, detail.data.attempts) : null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-surface-muted p-3 text-sm">
      {!detail.data?.attempts.length && (
        <p>{t('studio.tiktok.approved', { time: when(slot, i18n.language) })}</p>
      )}
      <p className="text-muted-foreground">{t('studio.tiktok.processing')}</p>
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
  const data = posting.data;
  const caption = title ?? data?.title ?? '';
  // What is sent is what the screen shows: an interaction greyed out (by a fresher read of the
  // account, or on photos) is off.
  const shown = data?.media.kind === 'video';
  const choice: api.TiktokPost = {
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
        <p role="alert" className="text-sm text-danger">
          {t('studio.tiktok.cannotPost')}
        </p>
      </div>
    );
  }
  if (post.isSuccess) {
    return (
      <div className="space-y-1 rounded-md border border-border bg-surface-muted p-3 text-sm">
        <p role="status">{t('studio.tiktok.processing')}</p>
      </div>
    );
  }
  const video = data.media.kind === 'video';
  const max = creator.max_video_post_duration_sec;
  const tooLong = video && max !== null && length !== undefined && length > max;
  const unspecified = disclose && !yourBrand && !brandedContent;
  const privateBranded = brandedContent && privacy === 'SELF_ONLY';
  const ready =
    privacy !== '' && !unspecified && !privateBranded && !tooLong && caption.length <= data.max_title_units;
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
      <p className="text-xs">
        <Trans
          i18nKey={
            brandedContent && disclose
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
          {post.isPending ? t('studio.tiktok.posting') : t('studio.tiktok.post')}
        </button>
      </span>
      {unspecified && <p className="text-xs text-danger">{t('studio.tiktok.commercialRequired')}</p>}
      <TiktokError error={post.error} />
    </form>
  );
}
