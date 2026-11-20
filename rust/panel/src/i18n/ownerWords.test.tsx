import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { KnowledgeOut } from '@/api/knowledge';
import type { NeedWake } from '@/api/types';
import { me } from '@/test/fixtures';
import { CARD_PRODUCTS, emptyKnowledge, knowledge } from '@/test/knowledge';
import { mockFetch, renderAt, type FetchRoutes } from '@/test/render';
import { COMPOSER_STOP_CODES, ROW_STATUSES, type PostRow, type Wait, type WaitCode } from '@/api/postsPage';
import { FINDING_CODES } from '@/pages/materials/MaterialsShared';
import { INSTAGRAM, TIKTOK, postRow, postsAnswers, postsOut, setViewport, wait } from '@/test/postsPage';

// The owner reads no internal word (design 2026-11-19 §1.2 G6, §8.5): the pages are mounted over
// fixtures that hold every kind of thing they can show, and their visible text (Turkish) is
// checked, so reused keys and the server's codes are covered too, not only one namespace.
// Paylaşımlar joins this test with its own page (§7.4, PR 5).

/** Internal words, at the start of a word ("kolay" is not "olay"). */
const INTERNAL = /(?<!\p{L})(olay|paket|sürüm|durak|hipotez|strateji|icp|kadans|materyal|taslak)/u;
/** TikTok's own word for its drafts is the one "taslak" the owner reads. */
const TIKTOK_DRAFTS = /tiktok'ta taslak|tiktok'taki taslaklarına/gu;
/** The pages speak to the owner as "sen": no "siz" form. */
const SIZ = /onayınız|(?<!\p{L})(seçin|ekleyin)(?!\p{L})/u;

/** Everything the owner can read now: the page, open dialogs and menus, placeholders and labels. */
function visibleText(): string {
  // A modal dialog hides the page from the accessibility tree, not from the owner's eyes.
  const main = document.getElementById('main-content');
  if (!main) throw new Error('the page is not drawn');
  const roots = [main, ...screen.queryAllByRole('dialog'), ...screen.queryAllByRole('menu')];
  const texts = roots.flatMap((root) => [
    root.textContent ?? '',
    ...Array.from(root.querySelectorAll('[placeholder], [aria-label], [title]')).flatMap((el) =>
      ['placeholder', 'aria-label', 'title'].map((a) => el.getAttribute(a) ?? ''),
    ),
  ]);
  return texts.join('\n').toLocaleLowerCase('tr');
}

/** The internal words and "siz" forms in `text`, each with a little of what surrounds it. */
function offences(text: string): string[] {
  const cleaned = text.replace(TIKTOK_DRAFTS, '');
  const found: string[] = [];
  for (const pattern of [INTERNAL, SIZ]) {
    const global = new RegExp(pattern.source, 'gu');
    for (const m of cleaned.matchAll(global)) found.push(cleaned.slice(Math.max(0, m.index - 30), m.index + 30));
  }
  return found;
}

const none: NeedWake = { state: 'no_agent' };
const late: NeedWake = {
  state: 'schedule',
  next_expected_at: new Date(Date.now() - 3600_000).toISOString(),
  interval_minutes: 60,
  has_address: false,
  failed_at: null,
  run_now: null,
};

function answers(data: KnowledgeOut): FetchRoutes {
  return {
    'GET /api/auth/me': me,
    'GET /api/knowledge': data,
    'GET /api/agents/wakes': { agents: [], needs: { content: none, materials: none, social: none, ads: none, research: none, inbox: none, knowledge: late } },
    'GET /api/studio/overview': {
      hypotheses: [{ id: 'h1', title: 'Atölyeden kısa videolar', segment_key: 'genel' }],
      learned: { arms: [{ arm: { id: 'a1', key: { hypothesis_id: 'h1', lane: 'organic', channel: 'instagram', content_type: 'reel' } }, evidence: [{ id: 'm1', status: 'measured', raw_metrics: {} }] }], hypotheses: [{ hypothesis_id: 'h1', derived_confidence: 0.3 }] },
    },
    [`GET /api/knowledge/cards/${CARD_PRODUCTS}/history`]: {
      revisions: (['note', 'proposal', 'owner', 'backfill', 'resync', 'system'] as const).map((cause, i) => ({
        id: `rev-${i}`, subject: 'card', card_id: CARD_PRODUCTS, revision: 6 - i, kb_revision: 9 - i,
        content: { title: 'Ürünler ve fiyat', body: `Metin ${i}`, attachments: [], archived: i === 5 }, cause, source_id: null,
        at: '2026-11-18T09:00:00Z', by: cause === 'owner' || cause === 'proposal' ? { kind: 'human', user_id: me.user_id } : { kind: 'system', component: 'knowledge' },
      })),
      next_before: null,
    },
  };
}

describe('the owner’s words on Bilgi bankası', () => {
  it('holds no internal word or "siz" form, with every note outcome, proposal kind, rule line, dialog and agent stop', async () => {
    const user = userEvent.setup();
    const stops: KnowledgeOut['notes_agent'][] = [
      { state: 'none', next_at: null },
      { state: 'asleep', next_at: '2026-11-21T09:00:00Z' },
      { state: 'late', next_at: '2026-11-19T09:00:00Z' },
    ];
    const seen: string[] = [];
    for (const notes_agent of stops) {
      mockFetch(answers({ ...knowledge, notes_agent, frame: { number: 2, derive_due: ['posting'] } }));
      const { unmount } = renderAt(`/knowledge?card=${CARD_PRODUCTS}`);
      await screen.findByRole('heading', { level: 1, name: tr.knowledge.title });
      await screen.findByRole('region', { name: tr.knowledge.learned.title });
      seen.push(visibleText());
      unmount();
    }

    mockFetch(answers(knowledge));
    renderAt(`/knowledge?card=${CARD_PRODUCTS}&history=${CARD_PRODUCTS}`);
    const history = await screen.findByRole('dialog', { name: tr.knowledge.history.title });
    await within(history).findAllByRole('button', { name: tr.knowledge.history.restore });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: tr.knowledge.rules.editLabel }));
    await screen.findByRole('dialog', { name: tr.knowledge.rules.title });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: tr.knowledge.goals.editLabel }));
    await screen.findByRole('dialog', { name: tr.knowledge.goals.title });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(within(screen.getByRole('region', { name: tr.knowledge.composer.label })).getByRole('button', { name: tr.knowledge.composer.attach }));
    await screen.findByRole('menu');
    seen.push(visibleText());

    expect(seen.flatMap(offences)).toEqual([]);
  }, 30_000);

  it('holds none on an empty knowledge base either, with or without the texts waiting as proposals', async () => {
    const seen: string[] = [];
    for (const data of [
      emptyKnowledge,
      { ...emptyKnowledge, proposals: [{ ...knowledge.proposals[0], proposed_by: { kind: 'system' as const, component: 'knowledge_backfill' }, reason: 'Daha önce yazılmıştı ama uygulanmamıştı.' }] },
    ]) {
      mockFetch(answers(data));
      const { unmount } = renderAt('/knowledge');
      await screen.findByRole('region', { name: tr.knowledge.rules.title });
      seen.push(visibleText());
      unmount();
    }
    expect(seen.flatMap(offences)).toEqual([]);
  });

  it('catches an internal word, a "siz" form, and lets TikTok’s drafts and "kolay" through', () => {
    expect(offences("bu olay için · onayınızı bekliyor")).toHaveLength(2);
    expect(offences("tiktok'ta taslak · kolay · tiktok'taki taslaklarına gönderildi")).toEqual([]);
  });
});

// --- Paylaşımlar (PR 5) ------------------------------------------------------------------------

/** Every wait code with the facts its sentence names, and the actions that draw its buttons. */
const WAITS: [WaitCode, Wait['facts']][] = [
  ['approval', {}],
  ['posting_screen', {}],
  ['capture', { request: 'Kupanın altını göster' }],
  ['files_permission', { found: ['face', 'name', 'child', 'logo', 'company'] }],
  ['files_quality', { finding: 'quality' }],
  ['delivery_held', { finding: 'names_other_olay' }],
  ['check_hold', { finding: 'date_outside_olay' }],
  ['failed', { reason: 'auth', kind: 'instagram' }],
  ['tiktok_draft', {}],
  ['no_account', {}],
  ['no_account_for_platform', { kind: 'tiktok' }],
  ['account_unavailable', { account: 'alfa.atolye' }],
  ['account_paused', { account: 'alfa.atolye' }],
  ['media', { kind: 'tiktok' }],
  ['material_removed', {}],
  ['knowledge_empty', {}],
  ['no_agent', {}],
  ['pick_time', {}],
  ['need_photo', { request: 'Fırının içinden bir video çek' }],
];
const allActions: PostRow['actions'] = {
  approve: { slot_id: 'x', expected_revision: 1 },
  tiktok: { slot_id: 'x', expected_revision: 1 },
  redo: { project_id: 'area-1', package_revision: 1 },
  cancel: { kind: 'post', slot_id: 'x', expected_revision: 1 },
  pick_time: { project_id: 'area-1', version_id: 'v', accounts: ['cap-ig'] },
  release_check: { slot_id: 'x', expected_revision: 1 },
  accept_held: { project_id: 'area-1', expected_revision: 1 },
  permit_files: [{ material_id: 'm1', expected_revision: 1 }],
  add_files: { kind: 'need', shoot_request_id: 'n' },
  dismiss: { kind: 'need', shoot_request_id: 'n' },
  resume_account: { capability_id: 'cap-ig', expected_revision: 1 },
  reconnect: 'cap-ig',
  acknowledge: { slot_id: 'x', expected_revision: 1 },
  connect: true,
};
const subStates: PostRow['sub_state'][] = [
  { kind: 'claimed', stage: 'paket' },
  { kind: 'queued', wakes_now: true, next_at: null, late: false },
  { kind: 'queued', wakes_now: false, next_at: new Date(Date.now() + 3600_000).toISOString(), late: false },
  { kind: 'queued', wakes_now: false, next_at: new Date(Date.now() - 3600_000).toISOString(), late: true },
  { kind: 'starts', at: new Date(Date.now() + 5 * 86_400_000).toISOString() },
  { kind: 'files_analysing' },
];
/** One row per wait code, per finding code, per status, per sub-state and per kind. */
function everyRow(): PostRow[] {
  const out: PostRow[] = [];
  WAITS.forEach(([code, facts], i) => out.push(postRow(`slot:w${i}`, { title: `Bekleyen ${i + 1}`, status: code === 'failed' ? 'failed' : code === 'tiktok_draft' ? 'tiktok_draft' : 'waiting_you', waits: [wait(code, facts)], actions: allActions, ai_illustration: true })));
  FINDING_CODES.forEach((code, i) => out.push(postRow(`slot:f${i}`, { title: `Kontrol ${i + 1}`, status: 'waiting_you', waits: [wait('check_hold', { finding: code })], actions: { redo: allActions.redo } })));
  ROW_STATUSES.forEach((status, i) => out.push(postRow(`slot:s${i}`, { title: `Durum ${i + 1}`, status, tiktok_draft: status === 'published' && i % 2 === 0 })));
  subStates.forEach((sub, i) => out.push(postRow(`content:c${i}`, { title: `Hazırlanan ${i + 1}`, kind: 'content', status: 'preparing', sub_state: sub, channel: null, publish_at: null })));
  out.push(postRow('version:v1', { title: 'Zamanı gelen', status: 'scheduling', actions: { pick_time: allActions.pick_time, cancel: { kind: 'version', project_id: 'area-1', version_id: 'v1', package_revision: 1 } } }));
  out.push(postRow('need:n1', { title: 'İstenen fotoğraf', kind: 'need', status: 'waiting_you', waits: [wait('need_photo', { request: 'Raftaki kupaları çek' })], actions: { add_files: allActions.add_files, dismiss: allActions.dismiss } }));
  out.push(postRow('slot:sib', { title: 'Kardeşli', siblings: [{ row_id: 'slot:s1', channel: TIKTOK, publish_at: null, status: 'scheduled' }, { row_id: 'slot:s2', channel: INSTAGRAM, publish_at: null, status: 'published' }], actions: allActions }));
  return out;
}
const day = (state: 'none' | 'analysing' | 'needs_permission' | 'unchecked' | 'quality', i: number) => ({
  key: `gun_${i}`, year: 2026, name: `Özel gün ${i}`, window_start: '2026-12-01', window_end: '2026-12-01', prepares_from: '2026-11-20',
  phase: 'preparing' as const, shoot_request_id: null, can_add: true, can_skip: true, files: { state, material_ids: ['m1'], found: ['face' as const] },
});

describe('the owner’s words on Paylaşımlar', () => {
  it('holds no internal word or "siz" form, with every row, wait, finding, stop, special day and drawer', async () => {
    const user = userEvent.setup();
    setViewport('desk');
    const list = everyRow();
    const stops = COMPOSER_STOP_CODES.map((code) => ({ code, at: new Date(Date.now() + 3600_000).toISOString() }));
    const data = postsOut({
      rows: list,
      days: [day('none', 1), day('analysing', 2), day('needs_permission', 3)],
      days_more: 2,
      brake: { revision: 3, can_resume: true },
      composer: { allowed: true, files_allowed: true, stops, advice: ['approval', 'posting_screen', 'video_only'], connected: [{ kind: 'instagram', name: 'alfa.atolye' }] },
    });
    const seen: string[] = [];
    const material = { id: 'm1', workspace_id: 'w', file_id: 'f1', mime: 'image/jpeg', title: 'Raf', origin: { kind: 'real' }, binding: { kind: 'genel' }, freed: null, share: null, tags: { labels: [], product_groups: [], doors: [], content_types: [], quality: 'publishable', depicts: [] }, tags_reviewed_by: null, people: [], captured_at: null, created_by: { kind: 'human', user_id: 'u' }, revision: 1, created_at: '2026-11-19T09:00:00Z', erased_at: null };
    const intelligence = { status: 'failed', description: '', group_name: null, date_source: 'unknown', attempts: 1, analyzed_revision: null, last_error_code: null, analyzed_at: null, updated_at: '2026-11-19T09:00:00Z', manual_fields: [] };
    mockFetch(postsAnswers(data, {
      'GET /api/content/tree': { olays: [{ olay: { id: 'o1', title: 'Pazar', status: 'proposed', kind: 'workshop', starts_on: '2026-12-01', ends_on: '2026-12-02', revision: 1 }, files: 0, areas: 0, published: 0, waits: [] }], genel: { files: 0, areas: 0, published: 0, waits: [] }, upcoming: [], analysis_queue: 2, areas: 0, waiting: { olay_confirmations: 1, shoot_requests: 0, content_approvals: 0, content_times: 0, problem_contents: 0 } },
      'GET /api/content/analysis-queue': { items: (['waiting', 'analysing', 'needs_filing', 'failed'] as const).map((stage, i) => ({ material: { ...material, id: `q${i}`, binding: { kind: 'unfiled' } }, intelligence, unfiled: true, stage })) },
      'GET /api/studio/materials': [material],
      'GET /api/studio/materials/m1': { material, used_in: [] },
      'GET /api/social/accounts': [{ capability_id: 'cap-ig', name: 'alfa.atolye', kind: 'instagram', status: 'unreachable', paused: true, requires_human_approval: true, stops: [{ code: 'reconnect', blocking: true, action: 'reconnect' }, { code: 'paused', blocking: true, action: 'resume' }, { code: 'braked', blocking: true }, { code: 'knowledge_empty', blocking: true, action: 'open_knowledge' }, { code: 'approval', blocking: false }, { code: 'lead', blocking: false, format: 'reel', hours: 48 }], latest: null, next: null }, { capability_id: 'cap-tt', name: 'alfaatolye', kind: 'tiktok', status: 'verified', paused: false, requires_human_approval: true, stops: [{ code: 'posting_screen', blocking: false }, { code: 'only_format', blocking: false }], latest: null, next: null }],
      'GET /api/studio/posts': { posts: [], settings: { tz: 'Europe/Istanbul', revision: 2, paused_capability_ids: ['cap-ig'], provider_scheduling: false, policy: { lead_minutes: { story: 120, feed_post: 1440, carousel: 1440, reel: 2880, tiktok_video: 2880 }, grace_minutes: { story: 60, feed_post: 360, carousel: 360, reel: 360, tiktok_video: 360 }, feed_cap: { per_day: 2, spacing_minutes: 180 }, story_cap: { per_day: 25, spacing_minutes: 10 }, tiktok_video_cap: { per_day: 3, spacing_minutes: 0 }, quiet_start_hour: 0, quiet_end_hour: 8, floor_days: 4, debounce_minutes: 30, horizon_days: 30 } } },
      'GET /api/studio/calendar': { year: 2026, entries: [{ key: 'ogretmenler_gunu', year: 2026, name: 'Öğretmenler Günü', kind: 'special_day', window_start: null, window_end: null, lead_days: null, enabled: true }], rows: [], policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: false } },
    }));
    const { router } = renderAt('/posts');
    await screen.findByRole('heading', { level: 1, name: tr.postsPage.title });
    const t = await screen.findByRole('region', { name: tr.postsPage.table.label });
    await within(t).findByText(list[0].title);
    const input = screen.getByLabelText(tr.postsPage.composer.label);
    await user.click(input);
    await user.type(input, 'sadece TikTok ve LinkedIn');
    seen.push(visibleText());
    const p = screen.getByRole('complementary', { name: tr.postsPage.panel.label });
    for (const row of list) {
      await user.click(within(t).getByText(row.title).closest('button')!);
      await within(p).findByRole('heading', { name: row.title });
      seen.push(visibleText());
    }
    // The dialogs of a row.
    await user.click(within(t).getByText('Kardeşli').closest('button')!);
    await user.click(await within(p).findByRole('button', { name: tr.postsPage.actions.redo }));
    await screen.findByRole('dialog', { name: tr.postsPage.redo.title });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    await user.click(within(p).getByRole('button', { name: tr.postsPage.actions.cancel }));
    await screen.findByRole('dialog', { name: tr.postsPage.cancel.title });
    seen.push(visibleText());
    await user.keyboard('{Escape}');
    // The three drawers.
    // Each drawer once what it reads has come: a text only its answer draws.
    const drawers: [string, string, string][] = [
      ['?files=1', tr.postsPage.files.title, 'Raf'],
      ['?files=1&queue=1', tr.postsPage.files.title, tr.postsPage.files.state.needs_filing],
      ['?files=1&file=m1', tr.postsPage.files.file, tr.materials.editor.bindTo],
      ['?accounts=1&account=cap-ig', tr.postsPage.accounts.title, tr.postsPage.accounts.numbers],
      ['?settings=1', tr.postsPage.settings.title, 'Öğretmenler Günü'],
    ];
    for (const [place, name, probe] of drawers) {
      await router.navigate(`/posts${place}`);
      const drawer = await screen.findByRole('dialog', { name }, { timeout: 10_000 });
      await within(drawer).findAllByText(probe, { exact: false }, { timeout: 10_000 });
      seen.push(visibleText());
    }
    // What was read holds the panel's waits, the findings and each drawer.
    const all = seen.join('\n');
    for (const text of [tr.postsPage.waits.approval.sentence, tr.materials.finding.names_other_olay.slice(1), tr.postsPage.files.addCategory, tr.postsPage.accounts.numbers, tr.materials.policy.title, tr.postsPage.composer.stops.braked]) {
      expect(all).toContain(text.toLocaleLowerCase('tr'));
    }
    expect(seen.flatMap(offences)).toEqual([]);
  }, 120_000);
});
