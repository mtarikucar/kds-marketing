import { request, seg } from './client';
import type { StageKey, StageState } from './content';
import type { PostFormat } from './posts';
import type { Rfc3339, Uuid } from './types';

// Paylaşımlar (`/posts`, design 2026-11-19 §2, §3): the one read built for the page
// (`content.posts`, `content.post_get`), the composer's write (`content.post_request`) and the
// four small writes the page needed (`content.files_add`, `content.special_day_skip`,
// `content.version_cancel`, `content.post_dismiss`), with their types, in one file so they are
// easy to hold against the server's DTOs (`jt_app::usecases::content::posts`,
// `jt_panel_http::routes::content`). Every other action of the page calls an existing endpoint
// (§3.8) through its own client.
//
// Written against §3 before the server existed (PR 4); what the spec left open is marked
// "assumed" below, so the contract check against the real DTOs has one place to look.

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** `RowKind` (§2.3): a planned post, a version with no post yet, a content being made, a photo the system needs. */
export type RowKind = 'post' | 'version' | 'content' | 'need';
export const ROW_KINDS: readonly RowKind[] = ['post', 'version', 'content', 'need'];

/** `RowStatus` (§2.4), one per row. */
export type RowStatus =
  | 'failed'
  | 'tiktok_draft'
  | 'waiting_you'
  | 'paused'
  | 'revising'
  | 'preparing'
  | 'scheduling'
  | 'scheduled'
  | 'published';
export const ROW_STATUSES: readonly RowStatus[] = [
  'failed', 'tiktok_draft', 'waiting_you', 'paused', 'revising', 'preparing', 'scheduling', 'scheduled', 'published',
];

/** The eight stages in pipeline order (`content/pipeline.rs` `STAGES`); the filter keys of §2.11. */
export const STAGE_KEYS: readonly StageKey[] = ['hazirlik', 'fikir', 'metin', 'gorsel', 'paket', 'onay', 'yayin', 'sonuc'];

/** `Progress` (§2.5): every dot before `index` is done; `index` is 0..=7. */
export interface Progress {
  index: number;
  /** `todo` never comes for the current dot; `done` with index 7 is a finished row. */
  state: Exclude<StageState, 'todo'>;
}

/** `WaitCode` (§2.6). */
export type WaitCode =
  | 'approval'
  | 'posting_screen'
  | 'capture'
  | 'files_permission'
  | 'files_quality'
  | 'delivery_held'
  | 'check_hold'
  | 'failed'
  | 'tiktok_draft'
  | 'no_account'
  | 'no_account_for_platform'
  | 'account_unavailable'
  | 'account_paused'
  | 'media'
  | 'material_removed'
  | 'knowledge_empty'
  | 'no_agent'
  | 'pick_time'
  | 'need_photo';
export const WAIT_CODES: readonly WaitCode[] = [
  'approval', 'posting_screen', 'capture', 'files_permission', 'files_quality', 'delivery_held', 'check_hold', 'failed',
  'tiktok_draft', 'no_account', 'no_account_for_platform', 'account_unavailable', 'account_paused', 'media',
  'material_removed', 'knowledge_empty', 'no_agent', 'pick_time', 'need_photo',
];

/** What a person's photo shows that needs their permission (§2.6, §3.2.5 `found`). */
export type FoundMark = 'face' | 'name' | 'child' | 'logo' | 'company';
export const FOUND_MARKS: readonly FoundMark[] = ['face', 'name', 'child', 'logo', 'company'];

/** Why a post did not go out (`RedactedPublishError` class, §2.6 "Reasons in words"). */
export type FailReason = 'auth' | 'permission' | 'rate_limited' | 'validation' | 'refused' | 'unreachable' | 'missed_grace';

/**
 * `Wait.facts`: what the sentence needs (§3.2.2 says only "account name, platform kind, request
 * text, finding code, error"). Assumed keys, each present only for the codes that name it:
 * - `account`: the account's name (`account_unavailable`, `account_paused`);
 * - `kind`: the platform's kind key (`failed`, `media`, `no_account_for_platform`);
 * - `request`: the request's sentence (`capture`, `need_photo`);
 * - `found`: what analysis found (`files_permission`; empty or absent: the files were not checked);
 * - `finding`: the first finding's code (`delivery_held`, `check_hold`, `files_quality`);
 * - `reason`: the failure's class (`failed`);
 * - `recovered`: an `auth` / `permission` failure whose account posts again (`failed`).
 */
export interface WaitFacts {
  account?: string | null;
  kind?: string | null;
  request?: string | null;
  found?: FoundMark[] | null;
  finding?: string | null;
  reason?: FailReason | string | null;
  recovered?: boolean | null;
}

/** `Wait` (§3.2.2): one reason the row waits for the owner; the first of a row is the one shown. */
export interface Wait {
  code: WaitCode;
  since: Rfc3339;
  facts: WaitFacts;
}

/**
 * `SubState` (§2.4) of a `preparing` row. Assumed internally tagged by `kind`, as the server's
 * other sum types the panel reads (`Binding`, `Origin`).
 */
export type SubState =
  | { kind: 'claimed'; stage: StageKey }
  | { kind: 'queued'; wakes_now: boolean; next_at: Rfc3339 | null; late: boolean }
  | { kind: 'starts'; at: Rfc3339 }
  | { kind: 'files_analysing' };

/** `Cover`: the row's first material; `preview_url` only for a caller holding `materials.work`. */
export interface Cover {
  material_id: Uuid;
  mime: string;
  preview_url: string | null;
  preview_expires_at: Rfc3339 | null;
  ai_generated: boolean;
}

/** `ChannelRef`: the account a post goes out on; `label` is `{Platform}` or `{Platform} · {name}`. */
export interface ChannelRef {
  capability_id: Uuid;
  kind: string;
  name: string;
  label: string;
}

/** `MediaSummary`: what the materials say of the format (`Video · 8 sn`, `Kaydırmalı · 2 görsel`). */
export interface MediaSummary {
  images: number;
  video_seconds: number | null;
}

/** `Category`: the olay of the row, or Genel (`olay_id` null). */
export interface Category {
  olay_id: Uuid | null;
  title: string;
}

/** `Sibling`: another row of the same content. */
export interface Sibling {
  row_id: string;
  channel: ChannelRef | null;
  publish_at: Rfc3339 | null;
  status: RowStatus;
}

export interface SlotRef {
  slot_id: Uuid;
  expected_revision: number;
}
export interface RedoRef {
  project_id: Uuid;
  /** `null` before any package. */
  package_revision: number | null;
}
/** `CancelRef` (§2.7.2): tagged by `kind`, as the spec reads it (`actions.cancel.kind`). */
export type CancelRef =
  | { kind: 'post'; slot_id: Uuid; expected_revision: number }
  | { kind: 'version'; project_id: Uuid; version_id: Uuid; package_revision: number }
  | { kind: 'content'; project_id: Uuid; expected_revision: number };
export interface PickRef {
  project_id: Uuid;
  version_id: Uuid;
  accounts: Uuid[];
}
export interface AreaRef {
  project_id: Uuid;
  expected_revision: number;
}
export interface MaterialRef {
  material_id: Uuid;
  expected_revision: number;
}
/** `FilesTarget` (§3.7.1); assumed tagged by `kind`. */
export type FilesTarget =
  | { kind: 'capture'; project_id: Uuid; request_id: Uuid }
  | { kind: 'need'; shoot_request_id: Uuid }
  | { kind: 'special_day'; key: string; year: number };
/**
 * `DismissRef`, "capture request or need" (§3.2.2). Assumed tagged by `kind`; a capture request
 * carries the area's revision `studio.project_request_update` needs.
 */
export type DismissRef =
  | { kind: 'capture'; project_id: Uuid; request_id: Uuid; expected_revision: number }
  | { kind: 'need'; shoot_request_id: Uuid };
export interface AccountRef {
  capability_id: Uuid;
  expected_revision: number;
}

/** `RowActions` (§3.2.2–§3.2.3): only what this caller may do now. Absent fields read as none. */
export interface RowActions {
  approve?: SlotRef | null;
  tiktok?: SlotRef | null;
  redo?: RedoRef | null;
  cancel?: CancelRef | null;
  pick_time?: PickRef | null;
  release_check?: SlotRef | null;
  accept_held?: AreaRef | null;
  /**
   * The files a `files_permission` wait names, with their revisions. Assumed to list the files of
   * a `files_quality` wait too (for `Yine de kullan`), as the spec gives that action no ref.
   */
  permit_files?: MaterialRef[];
  add_files?: FilesTarget | null;
  dismiss?: DismissRef | null;
  resume_account?: AccountRef | null;
  reconnect?: Uuid | null;
  acknowledge?: SlotRef | null;
  connect?: boolean;
}

/** `PostRow` (§3.2.2): one row of the table. */
export interface PostRow {
  /** `slot:{uuid}` | `version:{uuid}` | `content:{uuid}` | `need:{uuid}`. */
  id: string;
  kind: RowKind;
  area_id: Uuid | null;
  version_id: Uuid | null;
  slot_id: Uuid | null;
  shoot_request_id: Uuid | null;
  /** At most 80 characters. */
  title: string;
  cover: Cover | null;
  channel: ChannelRef | null;
  format: PostFormat | null;
  media: MediaSummary | null;
  category: Category;
  publish_at: Rfc3339 | null;
  published_at: Rfc3339 | null;
  url: string | null;
  status: RowStatus;
  sub_state: SubState | null;
  progress: Progress;
  waits: Wait[];
  actions: RowActions;
  ai_illustration: boolean;
  siblings: Sibling[];
  /**
   * Assumed: a TikTok post sent to the creator's drafts (§2.4 `tiktok_draft`), kept true once it
   * reads `published` so the pill says `TikTok'a gönderildi` rather than `Yayında`.
   */
  tiktok_draft?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The page's read
// ---------------------------------------------------------------------------------------------

/** `PostCounts`: over every row, whatever the filter and the page. */
export interface PostCounts {
  all: number;
  you: number;
  stages: Partial<Record<StageKey, number>>;
}

/** `SpecialDayLine.files.state` (§2.7.5). */
export type DayFilesState = 'none' | 'analysing' | 'needs_permission' | 'unchecked' | 'quality';

/** `SpecialDayLine` (§3.2.5): a near special day with no usable photo yet. */
export interface SpecialDayLine {
  key: string;
  year: number;
  name: string;
  window_start: string;
  window_end: string;
  prepares_from: string;
  phase: 'ahead' | 'preparing' | 'open';
  shoot_request_id: Uuid | null;
  can_add: boolean;
  can_skip: boolean;
  files: { state: DayFilesState; material_ids: Uuid[]; found: FoundMark[] };
}

/** The composer's stops (§2.8): said before sending, never blocking it (D20). */
export type ComposerStopCode = 'knowledge_empty' | 'braked' | 'no_account' | 'no_content_agent' | 'agent_sleeps' | 'agent_late';
export const COMPOSER_STOP_CODES: readonly ComposerStopCode[] = ['knowledge_empty', 'braked', 'no_account', 'no_content_agent', 'agent_sleeps', 'agent_late'];
/** Assumed: `agent_sleeps` and `agent_late` carry the next expected check-in as `at`. */
export interface ComposerStop {
  code: ComposerStopCode;
  at?: Rfc3339 | null;
}
export type ComposerAdvice = 'approval' | 'posting_screen' | 'video_only';

/** `ComposerState` (§3.2.5). */
export interface ComposerState {
  /** The content module is installed and the caller holds `content.manage` in person. */
  allowed: boolean;
  /** The caller may attach files (`materials.work`). */
  files_allowed: boolean;
  stops: ComposerStop[];
  advice: ComposerAdvice[];
  /** The postable accounts, for the client-side check of a platform named in the text. */
  connected: { kind: string; name: string }[];
}

/** `BrakeState`: the organic brake is on; the control revision `studio.brake` needs. */
export interface BrakeState {
  revision: number;
  can_resume: boolean;
}

/** `PostsOut` (§3.2.2): `GET /api/content/posts`. */
export interface PostsOut {
  rows: PostRow[];
  next_cursor: string | null;
  counts: PostCounts;
  /** At most three. */
  days: SpecialDayLine[];
  days_more: number;
  composer: ComposerState;
  knowledge_empty: boolean;
  brake: BrakeState | null;
  as_of: Rfc3339;
}

/** `filter`: `you`, or a stage key; absent, every row. */
export type PostsFilter = 'you' | StageKey;

/** `PostDetail` (§3.3): `GET /api/content/posts/{row_id}`. */
export interface PostDetail {
  row: PostRow;
  /** The whole caption; before delivery, the content's brief. */
  text: string;
  materials: Cover[];
  redo_note: string | null;
  cancelled: { by_name: string; at: Rfc3339; reason: string } | null;
  /**
   * Assumed (PR 4): `false` when no list holds the row any more (an archived content's, a
   * cancelled version's, a retired post's), so the panel says it is gone (§2.10); `actions` is
   * then empty. Absent counts as listed.
   */
  listed?: boolean;
}

/** `PostRequestOut` (§3.4.1); assumed `stops` are the composer's stop shape. */
export interface PostRequestOut {
  row: PostRow;
  stops: ComposerStop[];
}

/** Assumed: `content.files_add` answers the row it changed, or the day line. */
export interface FilesAddOut {
  row?: PostRow | null;
  day?: SpecialDayLine | null;
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

const root = '/api/content';

/** `content.posts`: one page (50 unless `limit`), in the order of §3.2.6. */
export const postsRead = (q: { filter?: PostsFilter; cursor?: string | null; limit?: number } = {}) =>
  request<PostsOut>('GET', `${root}/posts`, { query: { filter: q.filter, cursor: q.cursor ?? undefined, limit: q.limit } });

/** `content.post_get`: one row even when no list holds it; `version:{id}` and `content:{id}` too. */
export const postGet = (rowId: string) => request<PostDetail>('GET', `${root}/posts/${seg(rowId)}`);

/** `content.post_request`: "Ne paylaşalım?". `file_ids` from `studio.file_upload`, 0..=10. */
export const postRequest = (body: { request_key: string; text: string; file_ids: Uuid[] }) =>
  request<PostRequestOut>('POST', `${root}/post-requests`, { body });

/** `content.files_add`: photos for a capture, a need or a special day (1..=10). */
export const filesAdd = (body: { request_key: string; target: FilesTarget; file_ids: Uuid[] }) =>
  request<FilesAddOut>('POST', `${root}/files`, { body });

/** `content.special_day_skip`: "Bu yıl geç". Assumed to take an empty body. */
export const specialDaySkip = (key: string, year: number) =>
  request<unknown>('POST', `${root}/special-days/${seg(key)}/${year}/skip`, { body: {} });

/** `content.version_cancel`: a version with no planned post yet is never planned. */
export const versionCancel = (projectId: Uuid, versionId: Uuid, body: { package_revision: number; reason: string }) =>
  request<unknown>('POST', `${root}/areas/${seg(projectId)}/versions/${seg(versionId)}/cancel`, { body });

/** `content.post_dismiss`: `Bırak` on a failed post, `Tamamladım` on a TikTok draft. */
export const postDismiss = (slotId: Uuid, expected_revision: number) =>
  request<unknown>('POST', `${root}/posts/${seg(slotId)}/dismiss`, { body: { expected_revision } });

// ---------------------------------------------------------------------------------------------
// Helpers on the shapes
// ---------------------------------------------------------------------------------------------

/** A row's id from its kind and the id it names (`slot:…`, `version:…`, `content:…`, `need:…`). */
export function rowId(kind: 'slot' | 'version' | 'content' | 'need', id: string): string {
  return `${kind}:${id}`;
}

/** The stage key a row stands under: its progress index (a finished row is `sonuc`). */
export function stageOf(row: Pick<PostRow, 'progress'>): StageKey {
  return STAGE_KEYS[Math.min(7, Math.max(0, row.progress.index))];
}
