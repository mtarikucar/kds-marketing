import type { TFunction } from 'i18next';
import type { StageKey } from '@/api/content';
import { POST_FORMATS, type PostFormat } from '@/api/posts';
import {
  FOUND_MARKS,
  type ChannelRef,
  type FoundMark,
  type PostRow,
  type RowStatus,
  type SubState,
  type Wait,
  type WaitCode,
} from '@/api/postsPage';
import { wakeTime } from '@/lib/wake';
import { findingText } from '../materials/MaterialsShared';

// The page's words (design 2026-11-19 §2.2–§2.7): every sentence is built here from the server's
// codes and facts, so the table, the cards, the panel and the owner-word test read one source.

export type Tone = 'red' | 'amber' | 'violet' | 'grey' | 'green';

/** The pill's tone of each status (§2.4). */
export const STATUS_TONE: Record<RowStatus, Tone> = {
  failed: 'red',
  tiktok_draft: 'amber',
  waiting_you: 'amber',
  paused: 'grey',
  revising: 'violet',
  preparing: 'violet',
  scheduling: 'violet',
  scheduled: 'violet',
  published: 'green',
};

/** The pill's word: a TikTok draft that is done says it was sent, not that it is live. */
export function statusWord(t: TFunction, row: Pick<PostRow, 'status' | 'tiktok_draft'>): string {
  if (row.status === 'published' && row.tiktok_draft) return t('postsPage.status.tiktokSent');
  return t(`postsPage.status.${row.status}`);
}

/** A stage's label (D7: stage 5 is `Uyarlama`). */
export const stageLabel = (t: TFunction, key: StageKey) => t(`postsPage.stages.${key}`);

/** The platforms' own names (brands: the same in every language), by capability kind. */
const PLATFORMS: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook_page: 'Facebook',
  x: 'X',
  linkedin_page: 'LinkedIn',
  linkedin_member: 'LinkedIn',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  google_business: 'Google',
};

/** The platform's name of a capability kind (`TikTok`, `Instagram`, …). */
export const platformName = (kind: string | null | undefined) => (kind ? PLATFORMS[kind] ?? kind : '');

/** The Kanal badge's text: the server's label (`{Platform} · {hesap}` when two share a platform). */
export const channelLabel = (t: TFunction, channel: ChannelRef | null | undefined) =>
  channel ? channel.label || platformName(channel.kind) : '';

const isFormat = (f: unknown): f is PostFormat => typeof f === 'string' && (POST_FORMATS as readonly string[]).includes(f);

/**
 * The format with what its materials say (§2.2): `Video · 8 sn`, `Kaydırmalı · 2 görsel`,
 * `Gönderi · tek görsel`; `short` drops the inner dot for the table's sub-line (`Video 8 sn`).
 */
export function formatWords(t: TFunction, row: Pick<PostRow, 'format' | 'media'>, short = false): string {
  if (!isFormat(row.format)) return '';
  const name = t(`postsPage.format.${row.format}`);
  const media = row.media;
  if (media?.video_seconds != null) return t(short ? 'postsPage.format.secondsShort' : 'postsPage.format.seconds', { format: name, n: media.video_seconds });
  if (media && media.images > 0) return t(short ? 'postsPage.format.imagesShort' : 'postsPage.format.images', { format: name, count: media.images });
  return name;
}

/** The table's sub-line: `{Kategori} · {Biçim}`. */
export function subLine(t: TFunction, row: PostRow): string {
  const format = formatWords(t, row, true);
  return [categoryTitle(t, row), format].filter(Boolean).join(' · ');
}

/** The olay's title, or `Genel`. */
export const categoryTitle = (t: TFunction, row: Pick<PostRow, 'category'>) => row.category.title || t('postsPage.panel.genel');

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A publish time as the table says it: `Bugün 09:30`, `Yarın 15:00`, `Cmt 21 Kas 19:00`; `—` with none. */
export function whenWords(t: TFunction, iso: string | null | undefined, language: string, now = new Date()): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const locale = language.startsWith('tr') ? 'tr-TR' : 'en-GB';
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(at, now)) return t('postsPage.time.today', { time });
  if (sameDay(at, tomorrow)) return t('postsPage.time.tomorrow', { time });
  // `Cmt 21 Kas 19:00`: the weekday first whatever the locale's own order.
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const day = [part('weekday'), part('day'), part('month'), part('year')].filter(Boolean).join(' ');
  return `${day} ${time}`;
}

/** A calendar day (`YYYY-MM-DD`) as `24 Kas`. */
export function dayWords(day: string, language: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return new Intl.DateTimeFormat(language.startsWith('tr') ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(at);
}

/** What analysis found in a photo, joined (`yüz, isim`); unknown marks are left out. */
export function foundWords(t: TFunction, found: readonly string[] | null | undefined): string {
  return (found ?? [])
    .filter((f): f is FoundMark => (FOUND_MARKS as readonly string[]).includes(f))
    .map((f) => t(`postsPage.found.${f}`))
    .join(', ');
}

/** `{neden}` of a failed post (§2.6). */
export function failReason(t: TFunction, reason: string | null | undefined): string {
  switch (reason) {
    case 'auth':
    case 'permission':
    case 'rate_limited':
    case 'missed_grace':
      return t(`postsPage.reasons.${reason}`);
    case 'validation':
    case 'refused':
      return t('postsPage.reasons.refused');
    default:
      return t('postsPage.reasons.other');
  }
}

/** A failed post whose cause is the platform not taking what it got: the content must change. */
export const failNeedsRedo = (wait: Wait) => wait.facts.reason === 'validation' || wait.facts.reason === 'refused';

/** The status line of a wait in the panel (§2.6 "Status line"). */
export const waitStatus = (t: TFunction, code: WaitCode) => t(`postsPage.waits.${code}.status`);

/** The wait's sentence (§2.6), filled from its facts. */
export function waitSentence(t: TFunction, wait: Wait, channel: ChannelRef | null): string {
  const f = wait.facts ?? {};
  const platform = platformName(f.kind ?? channel?.kind);
  switch (wait.code) {
    case 'capture':
    case 'need_photo':
      return t(`postsPage.waits.${wait.code}.sentence`, { request: f.request ?? '' });
    case 'files_permission': {
      const found = foundWords(t, f.found);
      return found ? t('postsPage.waits.files_permission.sentence', { found }) : t('postsPage.waits.files_permission.unchecked');
    }
    case 'files_quality':
      // The finding of a quality wait is the file's quality tag, not a check's finding code.
      return f.finding === 'needs_crop' || f.finding === 'unusable'
        ? t('postsPage.waits.files_quality.sentence', { reason: t(`postsPage.waits.files_quality.${f.finding}`) })
        : t('postsPage.waits.files_quality.plain');
    case 'delivery_held':
    case 'check_hold':
      return f.finding
        ? t(`postsPage.waits.${wait.code}.sentence`, { reason: lowerFirst(findingText(t, f.finding)) })
        : t(`postsPage.waits.${wait.code}.plain`);
    case 'failed':
      if (f.recovered && (f.reason === 'auth' || f.reason === 'permission')) return t('postsPage.waits.failed.recovered', { channel: platform });
      return t('postsPage.waits.failed.sentence', { channel: platform, reason: failReason(t, f.reason) });
    case 'no_account_for_platform':
    case 'media':
      return t(`postsPage.waits.${wait.code}.sentence`, { platform });
    case 'account_unavailable':
    case 'account_paused':
      return t(`postsPage.waits.${wait.code}.sentence`, { account: f.account ?? channel?.name ?? '' });
    default:
      return t(`postsPage.waits.${wait.code}.sentence`);
  }
}

/** The first letter in lower case, for a finding's sentence inside another one ("…: metin …"). */
function lowerFirst(text: string): string {
  const trimmed = text.replace(/\.\s*$/, '');
  return trimmed.charAt(0).toLocaleLowerCase('tr-TR') + trimmed.slice(1);
}

/** The panel's line of a `preparing` row (§2.4 sub-states); `late` lines carry `Şimdi çalıştır`. */
export function subStateLine(t: TFunction, sub: SubState | null, language: string): { text: string; late: boolean } | null {
  if (!sub) return null;
  switch (sub.kind) {
    case 'claimed':
      return { text: t('postsPage.sub.claimed', { stage: stageLabel(t, sub.stage) }), late: false };
    case 'queued': {
      const at = sub.next_at ? wakeTime(sub.next_at, language) : null;
      if (sub.wakes_now) return { text: t('postsPage.sub.queuedNow'), late: false };
      if (sub.late && at) return { text: t('postsPage.sub.queuedLate', { at }), late: true };
      return { text: at ? t('postsPage.sub.queuedNext', { at }) : t('postsPage.sub.queuedNextUnknown'), late: false };
    }
    case 'starts':
      return { text: t('postsPage.sub.starts', { date: dayWords(sub.at.slice(0, 10), language) }), late: false };
    case 'files_analysing':
      return { text: t('postsPage.sub.files_analysing'), late: false };
  }
}

/** The panel's status line: the first wait's own line, else the sub-state's, else the pill. */
export function statusLine(t: TFunction, row: PostRow, language: string): string {
  const first = row.waits[0];
  if (first) return waitStatus(t, first.code);
  return subStateLine(t, row.sub_state, language)?.text ?? statusWord(t, row);
}

/** `{Kanal} · {zaman}` of a row or a sibling, for the consequence lines and the panel's head. */
export function channelAndTime(t: TFunction, channel: ChannelRef | null, at: string | null, language: string): string {
  const name = channelLabel(t, channel) || t('postsPage.table.agentPicks');
  return at ? `${name} · ${whenWords(t, at, language)}` : name;
}
