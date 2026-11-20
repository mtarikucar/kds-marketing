import { vi } from 'vitest';
import type { ChannelRef, PostDetail, PostRow, PostsOut, Wait, WaitCode } from '@/api/postsPage';
import type { NeedWake, WakesOut } from '@/api/types';
import { me } from './fixtures';
import { knowledge } from './knowledge';
import type { FetchRoutes } from './render';

// Paylaşımlar' reads in the shapes of design 2026-11-19 §3.2 (`GET /api/content/posts`), for an
// invented business (Alfa Atölye, a ceramics workshop). No real people, customers or accounts.

const HOUR = 3600_000;
export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
export const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

export const INSTAGRAM: ChannelRef = { capability_id: 'cap-ig', kind: 'instagram', name: 'alfa.atolye', label: 'Instagram' };
export const TIKTOK: ChannelRef = { capability_id: 'cap-tt', kind: 'tiktok', name: 'alfaatolye', label: 'TikTok' };
export const INSTAGRAM_SHOP: ChannelRef = { capability_id: 'cap-ig2', kind: 'instagram', name: 'alfa.magaza', label: 'Instagram · alfa.magaza' };

/** A row with sensible defaults: a scheduled Instagram post of a content, nothing to do. */
export function postRow(id: string, patch: Partial<PostRow> = {}): PostRow {
  const [kind, raw] = id.split(':') as [string, string];
  return {
    id,
    kind: kind === 'slot' ? 'post' : (kind as PostRow['kind']),
    area_id: 'area-1',
    version_id: kind === 'version' ? raw : null,
    slot_id: kind === 'slot' ? raw : null,
    shoot_request_id: kind === 'need' ? raw : null,
    title: `Paylaşım ${raw}`,
    cover: null,
    channel: INSTAGRAM,
    format: 'feed_post',
    media: { images: 1, video_seconds: null },
    category: { olay_id: null, title: 'Genel' },
    publish_at: ahead(26 * HOUR),
    published_at: null,
    url: null,
    status: 'scheduled',
    sub_state: null,
    progress: { index: 6, state: 'current' },
    waits: [],
    actions: {},
    ai_illustration: false,
    siblings: [],
    tiktok_draft: false,
    ...patch,
  };
}

export const wait = (code: WaitCode, facts: Wait['facts'] = {}): Wait => ({ code, since: ago(2 * HOUR), facts });

/** One row of each kind and status, and the waits the owner meets most. */
export const rows: PostRow[] = [
  postRow('slot:s-approve', {
    title: 'Yeni sırlı kupalar fırından çıktı',
    status: 'waiting_you',
    progress: { index: 5, state: 'waiting_person' },
    waits: [wait('approval')],
    actions: {
      approve: { slot_id: 's-approve', expected_revision: 4 },
      redo: { project_id: 'area-1', package_revision: 2 },
      cancel: { kind: 'post', slot_id: 's-approve', expected_revision: 4 },
    },
    cover: { material_id: 'm1', mime: 'image/jpeg', preview_url: '/m1.jpg', preview_expires_at: ahead(HOUR), ai_generated: false },
    siblings: [
      { row_id: 'slot:s-tiktok', channel: TIKTOK, publish_at: ahead(48 * HOUR), status: 'waiting_you' },
      { row_id: 'slot:s-live', channel: INSTAGRAM, publish_at: ago(48 * HOUR), status: 'published' },
    ],
  }),
  postRow('slot:s-tiktok', {
    title: 'Çarkta bir kupanın doğuşu',
    channel: TIKTOK,
    format: 'tiktok_video',
    media: { images: 0, video_seconds: 8 },
    status: 'waiting_you',
    progress: { index: 5, state: 'waiting_person' },
    waits: [wait('posting_screen')],
    actions: { tiktok: { slot_id: 's-tiktok', expected_revision: 2 }, redo: { project_id: 'area-1', package_revision: 2 }, cancel: { kind: 'post', slot_id: 's-tiktok', expected_revision: 2 } },
    ai_illustration: true,
  }),
  postRow('slot:s-failed', {
    title: 'Hafta sonu atölye dersi',
    status: 'failed',
    publish_at: ago(5 * HOUR),
    progress: { index: 6, state: 'problem' },
    waits: [wait('failed', { reason: 'rate_limited', kind: 'instagram' })],
    actions: { redo: { project_id: 'area-2', package_revision: 1 }, acknowledge: { slot_id: 's-failed', expected_revision: 3 } },
    area_id: 'area-2',
  }),
  postRow('content:area-3', {
    title: 'Yılbaşı için kurumsal hediye kupası',
    kind: 'content',
    area_id: 'area-3',
    channel: null,
    format: null,
    media: null,
    publish_at: null,
    status: 'preparing',
    sub_state: { kind: 'claimed', stage: 'metin' },
    progress: { index: 2, state: 'current' },
    actions: { redo: { project_id: 'area-3', package_revision: null }, cancel: { kind: 'content', project_id: 'area-3', expected_revision: 5 } },
  }),
  postRow('version:v-sched', {
    title: 'Kahve köşesine yeni fincan seti',
    area_id: 'area-4',
    status: 'scheduling',
    publish_at: null,
    progress: { index: 5, state: 'current' },
    actions: {
      pick_time: { project_id: 'area-4', version_id: 'v-sched', accounts: ['cap-ig'] },
      cancel: { kind: 'version', project_id: 'area-4', version_id: 'v-sched', package_revision: 1 },
      redo: { project_id: 'area-4', package_revision: 1 },
    },
  }),
  postRow('slot:s-planned', { title: 'Atölyeden bir gün', channel: INSTAGRAM_SHOP, area_id: 'area-5' }),
  postRow('slot:s-live', {
    title: 'Mavi sır serisi',
    status: 'published',
    publish_at: ago(48 * HOUR),
    published_at: ago(48 * HOUR),
    url: 'https://instagram.example/p/1',
    progress: { index: 7, state: 'done' },
  }),
  postRow('need:n-1', {
    title: 'Fırının içinden bir video çek',
    kind: 'need',
    area_id: null,
    channel: null,
    format: null,
    media: null,
    publish_at: null,
    status: 'waiting_you',
    progress: { index: 3, state: 'waiting_person' },
    waits: [wait('need_photo', { request: 'Fırının içinden bir video çek' })],
    actions: { add_files: { kind: 'need', shoot_request_id: 'n-1' }, dismiss: { kind: 'need', shoot_request_id: 'n-1' } },
  }),
];

/** The page's read: `rows` and everything that comes with them. */
export function postsOut(patch: Partial<PostsOut> = {}): PostsOut {
  const list = patch.rows ?? rows;
  const stages: PostsOut['counts']['stages'] = {};
  const keys = ['hazirlik', 'fikir', 'metin', 'gorsel', 'paket', 'onay', 'yayin', 'sonuc'] as const;
  for (const r of list) stages[keys[r.progress.index]] = (stages[keys[r.progress.index]] ?? 0) + 1;
  return {
    rows: list,
    next_cursor: null,
    counts: { all: list.length, you: list.filter((r) => r.waits.length > 0).length, stages },
    days: [],
    days_more: 0,
    composer: { allowed: true, files_allowed: true, stops: [], advice: ['approval', 'posting_screen'], connected: [{ kind: 'instagram', name: 'alfa.atolye' }, { kind: 'tiktok', name: 'alfaatolye' }] },
    knowledge_empty: false,
    brake: null,
    as_of: new Date().toISOString(),
    ...patch,
  };
}

/** `content.post_get` of `row`: its whole text. */
export function detailOf(row: PostRow, patch: Partial<PostDetail> = {}): PostDetail {
  return { row, text: `${row.title}\n\nAtölyemizde elde şekillendirildi.`, materials: row.cover ? [row.cover] : [], redo_note: null, cancelled: null, listed: true, ...patch };
}

const none: NeedWake = { state: 'no_agent' };
export const wakes = (needs: Partial<WakesOut['needs']> = {}, agents: WakesOut['agents'] = []): WakesOut => ({
  agents,
  needs: { content: none, materials: none, social: none, ads: none, research: none, inbox: none, knowledge: none, ...needs },
});

/** The page's answers: `data` as every filter's first page, each row's detail, and the wakes. */
export function postsAnswers(data: PostsOut = postsOut(), extra: FetchRoutes = {}): FetchRoutes {
  const details: FetchRoutes = {};
  for (const r of data.rows) details[`GET /api/content/posts/${encodeURIComponent(r.id)}`] = detailOf(r);
  return {
    'GET /api/auth/me': me,
    'GET /api/content/posts': data,
    'GET /api/agents/wakes': wakes(),
    'GET /api/knowledge': knowledge,
    'GET /api/social/accounts': [],
    ...details,
    ...extra,
  };
}

/** The window as a desk (≥ 1024 px), a tablet or a phone (< 640 px), for `useMedia`. */
export function setViewport(kind: 'desk' | 'tablet' | 'phone') {
  const width = kind === 'desk' ? 1280 : kind === 'tablet' ? 800 : 390;
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
}
