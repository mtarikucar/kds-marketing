import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { PostRow, PostsOut } from '@/api/postsPage';
import type { MeOut, Permission } from '@/api/types';
import { me } from '@/test/fixtures';
import { emptyKnowledge } from '@/test/knowledge';
import { delayed, mockFetch, renderAt, withStatus, type FetchCall, type FetchRoutes } from '@/test/render';
import {
  ahead,
  ago,
  detailOf,
  INSTAGRAM,
  INSTAGRAM_SHOP,
  postRow,
  postsAnswers,
  postsOut,
  rows,
  setViewport,
  TIKTOK,
  wait,
  wakes,
} from '@/test/postsPage';

// Paylaşımlar (design 2026-11-19 §2, §8.3): rows of every kind and status, the chips, the panel,
// every wait's sentence and action, the dialogs, the brake, the composer, the special days, every
// state of §2.10 and the permission variants — all over mocked answers of the §3 read.

const P = tr.postsPage;
const table = () => screen.findByRole('region', { name: P.table.label });
const panel = () => screen.findByRole('complementary', { name: P.panel.label });
const rowButton = async (title: string) => (await within(await table()).findByText(title)).closest('button')!;
const sent = (calls: FetchCall[], method: string, path: string) => calls.find((c) => c.method === method && c.path === path);
const withPermissions = (permissions: Permission[], role = 'owner'): MeOut => ({
  ...me,
  memberships: [{ ...me.memberships[0], role_key: role, permissions }],
});

/** The page at `path` on a desk, with `data` as the read and `extra` answers. */
function open(path = '/posts', data: PostsOut = postsOut(), extra: FetchRoutes = {}) {
  setViewport('desk');
  const calls = mockFetch(postsAnswers(data, extra));
  const view = renderAt(path);
  return { calls, ...view };
}

describe('the table', () => {
  it('shows one row per post with its picture, first line, channel, dots, status and time', async () => {
    open();
    const t = await table();
    for (const r of rows) expect(within(t).getByText(r.title)).toBeInTheDocument();
    const approve = await rowButton('Yeni sırlı kupalar fırından çıktı');
    expect(within(approve).getByText(P.status.waiting_you)).toBeInTheDocument();
    expect(within(approve).getByText('Genel · Gönderi tek görsel')).toBeInTheDocument();
    expect(within(approve).getByRole('img', { name: 'Süreç: 8 adımın 5 tanesi bitti' })).toBeInTheDocument();
    const tiktok = await rowButton('Çarkta bir kupanın doğuşu');
    expect(within(tiktok).getByText('TikTok')).toBeInTheDocument();
    expect(within(tiktok).getByText('Genel · Video 8 sn')).toBeInTheDocument();
    expect(within(await rowButton('Hafta sonu atölye dersi')).getByText(P.status.failed)).toBeInTheDocument();
    expect(within(await rowButton('Yılbaşı için kurumsal hediye kupası')).getByText(P.status.preparing)).toBeInTheDocument();
    expect(within(await rowButton('Kahve köşesine yeni fincan seti')).getByText(P.status.scheduling)).toBeInTheDocument();
    expect(within(await rowButton('Mavi sır serisi')).getByText(P.status.published)).toBeInTheDocument();
    expect(within(await rowButton('Mavi sır serisi')).getByRole('img', { name: 'Süreç: 8 adımın 8 tanesi bitti' })).toBeInTheDocument();
    // Two accounts on one platform: the badge names the account.
    expect(within(await rowButton('Atölyeden bir gün')).getByText('Instagram · alfa.magaza')).toBeInTheDocument();
    // No account chosen yet: a dash that says the agent will choose.
    expect(within(await rowButton('Yılbaşı için kurumsal hediye kupası')).getByTitle(P.table.agentPicks)).toHaveTextContent('—');
  });

  it('says every status with its own word, a sent TikTok draft as sent', async () => {
    const all = (['failed', 'tiktok_draft', 'waiting_you', 'paused', 'revising', 'preparing', 'scheduling', 'scheduled', 'published'] as const)
      .map((status, i) => postRow(`slot:s${i}`, { title: `Satır ${status}`, status }));
    all.push(postRow('slot:sent', { title: 'Gönderilen taslak', status: 'published', tiktok_draft: true, channel: TIKTOK, progress: { index: 7, state: 'done' } }));
    open('/posts', postsOut({ rows: all }));
    for (const status of ['failed', 'tiktok_draft', 'waiting_you', 'paused', 'revising', 'preparing', 'scheduling', 'scheduled', 'published'] as const) {
      expect(within(await rowButton(`Satır ${status}`)).getByText(P.status[status])).toBeInTheDocument();
    }
    expect(within(await rowButton('Gönderilen taslak')).getByText(P.status.tiktokSent)).toBeInTheDocument();
  });

  it('selects the first row with none in the address, and writes a clicked row into it', async () => {
    const user = userEvent.setup();
    const { router } = open();
    const p = await panel();
    expect(await within(p).findByRole('heading', { name: 'Yeni sırlı kupalar fırından çıktı' })).toBeInTheDocument();
    expect((await rowButton('Yeni sırlı kupalar fırından çıktı'))).toHaveAttribute('aria-pressed', 'true');
    await user.click(await rowButton('Mavi sır serisi'));
    await waitFor(() => expect(router.state.location.search).toBe('?slot=s-live'));
    expect(router.state.historyAction).toBe('PUSH');
    expect(await within(p).findByRole('heading', { name: 'Mavi sır serisi' })).toBeInTheDocument();
    expect(await rowButton('Mavi sır serisi')).toHaveAttribute('aria-pressed', 'true');
  });

  it('pages on with the cursor, the counts staying the server’s', async () => {
    const user = userEvent.setup();
    const firstPage = postsOut({ next_cursor: 'c2', counts: { all: 60, you: 3, stages: { onay: 2, yayin: 58 } } });
    const second = postsOut({ rows: [postRow('slot:late', { title: 'Sonraki sayfadan' })], next_cursor: null, counts: firstPage.counts });
    const { calls } = open('/posts', firstPage, { 'GET /api/content/posts?cursor=c2': second });
    expect(await within(await screen.findByRole('group', { name: P.chips.label })).findByRole('button', { name: /Tümü\s*60/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: P.table.more }));
    expect(await within(await table()).findByText('Sonraki sayfadan')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/content/posts' && c.search === '?cursor=c2')).toBe(true);
    expect(screen.queryByRole('button', { name: P.table.more })).not.toBeInTheDocument();
  });
});

describe('the chips', () => {
  it('offers Tümü, Seni bekleyen and only the stages that hold rows, with the server’s counts', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts', postsOut({ counts: { all: 12, you: 4, stages: { metin: 1, onay: 5, sonuc: 6 } } }));
    const chips = await screen.findByRole('group', { name: P.chips.label });
    await within(chips).findByRole('button', { name: /Tümü/ });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['Tümü12', 'Seni bekleyen4', 'Metin1', 'Onay5', 'Sonuç6']);
    await user.click(within(chips).getByRole('button', { name: /Onay/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?f=onay'));
    expect(router.state.historyAction).toBe('REPLACE');
    await user.click(within(chips).getByRole('button', { name: /Seni bekleyen/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?f=you'));
  });

  it('falls back to Tümü when the chosen stage has nothing left', async () => {
    const { router } = open('/posts?f=gorsel', postsOut({ counts: { all: 3, you: 1, stages: { onay: 3 } } }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('asks the server for the filter', async () => {
    const { calls } = open('/posts?f=you');
    await table();
    expect(calls.find((c) => c.path === '/api/content/posts')?.search).toBe('?filter=you');
  });
});

describe('the panel', () => {
  it('shows the picture, title, channel and time, status, the text, the details and the AI note; no tabs, no steps', async () => {
    open('/posts?slot=s-tiktok');
    const p = await panel();
    expect(await within(p).findByRole('heading', { name: 'Çarkta bir kupanın doğuşu' })).toBeInTheDocument();
    expect(within(p).getByText(P.waits.posting_screen.status)).toBeInTheDocument();
    // It says what is asked (his approval on TikTok's screen) and when it then goes out by itself.
    expect(within(p).getByTestId('wait-sentence')).toHaveTextContent(/^Bu paylaşımı TikTok ekranında onaylaman gerekiyor\. Onaylarsan kendiliğinden paylaşılır: .+ \d\d:\d\d\.$/);
    expect(await within(p).findByText(/Atölyemizde elde şekillendirildi/)).toBeInTheDocument();
    expect(within(p).getByText('TikTok · alfaatolye')).toBeInTheDocument();
    expect(within(p).getByText('Video · 8 sn')).toBeInTheDocument();
    expect(within(p).getByText('Genel')).toBeInTheDocument();
    expect(within(p).getByText(P.panel.ai)).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(within(p).queryByText(P.stages.hazirlik)).not.toBeInTheDocument();
  });

  it('labels the owner’s request before delivery and gives the sub-state', async () => {
    open('/posts?content=area-3');
    const p = await panel();
    expect(await within(p).findByText(P.panel.request)).toBeInTheDocument();
    expect(within(p).getByText('Ajan üzerinde çalışıyor · Metin')).toBeInTheDocument();
  });

  it('lists the other posts of the content and selects one', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts?slot=s-approve');
    const p = await panel();
    const same = await within(p).findByText(P.panel.same);
    const links = within(same.parentElement!).getAllByRole('button');
    expect(links.map((b) => b.textContent)).toEqual([expect.stringMatching(/^TikTok · /), expect.stringMatching(/^Instagram · /)]);
    await user.click(links[0]);
    await waitFor(() => expect(router.state.location.search).toBe('?slot=s-tiktok'));
  });

  it('shows a published post’s time and link', async () => {
    open('/posts?slot=s-live');
    const p = await panel();
    expect(await within(p).findByText(/^Yayınlandı · /)).toBeInTheDocument();
    expect(within(p).getByRole('link', { name: P.panel.openPost })).toHaveAttribute('href', 'https://instagram.example/p/1');
  });

  it('reads a row the page does not hold', async () => {
    const user = userEvent.setup();
    const elsewhere = postRow('slot:old', { title: 'Geçen ayın paylaşımı', status: 'published', published_at: ago(800 * 3600_000) });
    const { router } = open('/posts?slot=old', postsOut(), { 'GET /api/content/posts/slot%3Aold': detailOf(elsewhere) });
    expect(await within(await panel()).findByRole('heading', { name: 'Geçen ayın paylaşımı' })).toBeInTheDocument();
    expect(within(await table()).queryByText('Geçen ayın paylaşımı')).not.toBeInTheDocument();
    await user.click(await rowButton('Mavi sır serisi'));
    await waitFor(() => expect(router.state.location.search).toBe('?slot=s-live'));
  });

  it('says when the row is gone, and closes it', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts?slot=gone', postsOut(), { 'GET /api/content/posts/slot%3Agone': withStatus(404, { code: 'NOT_FOUND', message: 'no', details: {} }) });
    const p = await panel();
    expect(await within(p).findByText(P.panel.gone)).toBeInTheDocument();
    await user.click(within(p).getByRole('button', { name: P.panel.close }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('says a named row it could not read, never a made-up one, and reads it again', async () => {
    const user = userEvent.setup();
    const path = '/api/content/posts/slot%3Abroken';
    const { calls } = open('/posts?slot=broken', postsOut(), { [`GET ${path}`]: withStatus(500, { code: 'INTERNAL', message: 'down', details: {} }) });
    const p = await panel();
    expect(await within(p).findByText(P.panel.loadError)).toBeInTheDocument();
    expect(within(p).queryByText(P.status.published)).not.toBeInTheDocument();
    expect(within(p).queryByRole('heading')).not.toBeInTheDocument();
    const before = calls.filter((c) => c.path === path).length;
    await user.click(within(p).getByRole('button', { name: tr.common.retry }));
    await waitFor(() => expect(calls.filter((c) => c.path === path).length).toBeGreaterThan(before));
  });

  it('says a listed row whose text could not be read', async () => {
    open('/posts?slot=s-live', postsOut(), { 'GET /api/content/posts/slot%3As-live': withStatus(500, { code: 'INTERNAL', message: 'down', details: {} }) });
    const p = await panel();
    expect(await within(p).findByRole('heading', { name: 'Mavi sır serisi' })).toBeInTheDocument();
    expect(await within(p).findByText(P.panel.loadError)).toBeInTheDocument();
    expect(within(p).getByRole('button', { name: tr.common.retry })).toBeInTheDocument();
  });

  it('says a row no list holds any more is gone', async () => {
    const archived = postRow('content:area-old', { title: 'Eski içerik', kind: 'content', area_id: 'area-old', status: 'preparing' });
    open('/posts?content=area-old', postsOut(), { 'GET /api/content/posts/content%3Aarea-old': detailOf(archived, { listed: false }) });
    expect(await within(await panel()).findByText(P.panel.gone)).toBeInTheDocument();
  });
});

/** A row with the wait `code` and the actions that wait offers. */
function waiting(code: Parameters<typeof wait>[0], facts: Parameters<typeof wait>[1], actions: PostRow['actions'], patch: Partial<PostRow> = {}) {
  return postRow('slot:w1', { title: 'Bekleyen satır', status: 'waiting_you', waits: [wait(code, facts)], actions, ...patch });
}

describe('every wait, its sentence and its action', () => {
  const W = P.waits;
  it.each([
    ['approval', waiting('approval', {}, { approve: { slot_id: 'w1', expected_revision: 7 } }), W.approval.sentence, P.actions.approve, ['POST', '/api/studio/approvals', { target: { slot: 'w1' }, expected_revision: 7 }]],
    ['tiktok_draft', waiting('tiktok_draft', {}, { acknowledge: { slot_id: 'w1', expected_revision: 3 } }, { status: 'tiktok_draft', channel: TIKTOK }), W.tiktok_draft.sentence, P.actions.done, ['POST', '/api/content/posts/w1/dismiss', { expected_revision: 3 }]],
    ['account_paused', waiting('account_paused', { account: 'alfa.atolye' }, { resume_account: { capability_id: 'cap-ig', expected_revision: 9 } }), 'alfa.atolye hesabında paylaşım durduruldu.', P.actions.resume, ['POST', '/api/social/accounts/cap-ig/pause', { paused: false, expected_revision: 9 }]],
    ['files_permission', waiting('files_permission', { found: ['face', 'child'] }, { permit_files: [{ material_id: 'm7', expected_revision: 2 }] }), 'Dosyanda yüz, çocuk görünüyor; paylaşılması için izin ver.', P.actions.permit, ['PUT', '/api/studio/materials/m7/permission', undefined]],
    ['files_quality', waiting('files_quality', { finding: 'needs_crop', material_ids: ['m8'] }, { permit_files: [{ material_id: 'm8', expected_revision: 5 }] }), 'Ajan bu dosyayı paylaşmaya uygun bulmadı: kırpılması gerekiyor.', P.actions.useAnyway, ['PATCH', '/api/studio/materials/m8/tags', undefined]],
    ['need_photo dismissed', waiting('need_photo', { request: 'Raftaki kupaları çek' }, { dismiss: { kind: 'need', shoot_request_id: 'n9' } }, { kind: 'need' }), 'Raftaki kupaları çek', P.actions.notNeeded, ['POST', '/api/studio/shoot-requests/n9/resolve', { status: 'dismissed' }]],
    ['capture dismissed', waiting('capture', { request: 'Kupanın altını göster' }, { dismiss: { kind: 'capture', project_id: 'area-1', request_id: 'r1', expected_revision: 6 } }, { kind: 'content' }), 'Ajan bunun için bir fotoğraf ya da video istiyor: “Kupanın altını göster”', P.actions.notNeeded, ['PATCH', '/api/studio/projects/area-1/requests/r1', { expected_revision: 6, status: 'dismissed' }]],
    ['delivery_held accepted', waiting('delivery_held', { finding: 'names_other_olay' }, { redo: { project_id: 'area-1', package_revision: 1 }, accept_held: { project_id: 'area-1', expected_revision: 4 } }, { kind: 'content' }), /^Ajan bunu üç kez hazırladı ama kontrolden geçemedi: /, P.actions.acceptHeld, ['POST', '/api/content/areas/area-1/delivery/accept', { expected_revision: 4 }]],
  ] as const)('%s', async (_, row, sentence, action, [method, path, body]) => {
    const user = userEvent.setup();
    const { calls } = open('/posts?slot=w1', postsOut({ rows: [row] }), {
      [`${method} ${path}`]: {},
      'GET /api/studio/materials/m7': { material: { id: 'm7', revision: 2, share: null } },
    });
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(sentence);
    await user.click(within(p).getByRole('button', { name: action }));
    await waitFor(() => expect(sent(calls, method, path)).toBeDefined());
    if (body) expect(sent(calls, method, path)!.body).toEqual(body);
  });

  it('gives permission and quality at each file’s own revision', async () => {
    const user = userEvent.setup();
    const row = waiting('files_permission', { found: [] }, { permit_files: [{ material_id: 'm1', expected_revision: 2 }, { material_id: 'm2', expected_revision: 8 }] }, { kind: 'content' });
    const { calls } = open('/posts?slot=w1', postsOut({ rows: [row] }), { 'PUT /api/studio/materials/m1/permission': {}, 'PUT /api/studio/materials/m2/permission': {} });
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(P.waits.files_permission.unchecked);
    await user.click(within(p).getByRole('button', { name: P.actions.permit }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
      ['/api/studio/materials/m1/permission', { expected_revision: 2, permission: 'shareable' }],
      ['/api/studio/materials/m2/permission', { expected_revision: 8, permission: 'shareable' }],
    ]));
  });

  it('permits only the files of the wait shown, not those of its quality wait', async () => {
    const user = userEvent.setup();
    const row = postRow('content:area-7', {
      kind: 'content', area_id: 'area-7', status: 'waiting_you',
      waits: [wait('files_permission', { found: ['face'], material_ids: ['m1'] }), wait('files_quality', { finding: 'unusable', material_ids: ['m2'] })],
      actions: { permit_files: [{ material_id: 'm1', expected_revision: 2 }, { material_id: 'm2', expected_revision: 8 }] },
    });
    const { calls } = open('/posts?content=area-7', postsOut({ rows: [row] }), { 'PUT /api/studio/materials/m1/permission': {} });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.permit }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual(['/api/studio/materials/m1/permission']));
  });

  it('goes on without the file at the content’s revision the read gave', async () => {
    const user = userEvent.setup();
    const row = waiting('files_permission', { found: ['logo'], material_ids: ['m3'] }, {
      permit_files: [{ material_id: 'm3', expected_revision: 1 }],
      cancel: { kind: 'content', project_id: 'area-9', expected_revision: 12 },
    }, { kind: 'content', area_id: 'area-9' });
    const { calls } = open('/posts?slot=w1', postsOut({ rows: [row] }), { 'POST /api/studio/projects/area-9/materials': {} });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.withoutFile }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/studio/projects/area-9/materials')?.body).toEqual({ expected_revision: 12, add: [], remove: ['m3'] }));
    expect(sent(calls, 'GET', '/api/studio/projects/area-9')).toBeUndefined();
  });

  it('goes on without the file at the content’s revision read now', async () => {
    const user = userEvent.setup();
    const row = waiting('files_permission', { found: ['logo'] }, { permit_files: [{ material_id: 'm3', expected_revision: 1 }] }, { kind: 'content', area_id: 'area-9' });
    const { calls } = open('/posts?slot=w1', postsOut({ rows: [row] }), {
      'GET /api/studio/projects/area-9': { project: { id: 'area-9', revision: 11 }, materials: [], productions: [], publications: [] },
      'POST /api/studio/projects/area-9/materials': {},
    });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.withoutFile }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/studio/projects/area-9/materials')?.body).toEqual({ expected_revision: 11, add: [], remove: ['m3'] }));
  });

  it.each([
    ['no_account', P.waits.no_account.sentence],
    ['no_account_for_platform', 'TikTok hesabın bağlı değil.'],
  ] as const)('%s opens Hesaplar', async (code, sentence) => {
    const user = userEvent.setup();
    const row = waiting(code, { kind: 'tiktok' }, { connect: true, redo: { project_id: 'area-1', package_revision: 1 } });
    const { router } = open('/posts?slot=w1', postsOut({ rows: [row] }));
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(sentence);
    await user.click(within(p).getByRole('button', { name: P.actions.connect }));
    await waitFor(() => expect(router.state.location.search).toBe('?slot=w1&accounts=1'));
    expect(await screen.findByRole('dialog', { name: P.accounts.title })).toBeInTheDocument();
  });

  it.each([
    ['account_unavailable', waiting('account_unavailable', { account: 'alfa.atolye' }, { reconnect: 'cap-ig' }), 'alfa.atolye bağlantısı şu an çalışmıyor.', P.actions.reconnect, '/connect?capability=cap-ig'],
    ['knowledge_empty', waiting('knowledge_empty', {}, {}), P.waits.knowledge_empty.sentence, P.actions.toKnowledge, '/knowledge'],
    ['no_agent', waiting('no_agent', {}, {}), P.waits.no_agent.sentence, P.actions.connectAgent, '/agents'],
  ] as const)('%s links to where it is fixed', async (_, row, sentence, label, href) => {
    open('/posts?slot=w1', postsOut({ rows: [row] }));
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(sentence);
    expect(within(p).getByRole('link', { name: label })).toHaveAttribute('href', href);
  });

  it.each([
    ['media', waiting('media', { kind: 'tiktok' }, { redo: { project_id: 'area-1', package_revision: 3 } }), 'TikTok bu dosyayı bu biçimde almıyor (örneğin TikTok yalnızca video alır).'],
    ['material_removed', waiting('material_removed', {}, { redo: { project_id: 'area-1', package_revision: 3 } }), P.waits.material_removed.sentence],
    ['check_hold', waiting('check_hold', { finding: 'date_outside_olay' }, { redo: { project_id: 'area-1', package_revision: 3 } }), /^Paylaşım saatinde bir kontrol durdurdu: /],
  ] as const)('%s asks for changes', async (_, row, sentence) => {
    const user = userEvent.setup();
    const { calls } = open('/posts?slot=w1', postsOut({ rows: [row] }), { 'POST /api/content/areas/area-1/redo': {} });
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(sentence);
    await user.click(within(p).getByRole('button', { name: P.actions.redo }));
    const dialog = await screen.findByRole('dialog', { name: P.redo.title });
    await user.type(within(dialog).getByPlaceholderText(P.redo.placeholder), 'Daha kısa olsun');
    await user.click(within(dialog).getByRole('button', { name: P.redo.send }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/areas/area-1/redo')?.body).toEqual({ package_revision: 3, note: 'Daha kısa olsun' }));
    expect(await screen.findByText(P.panel.sentToAgent)).toBeInTheDocument();
  });

  it('releases a caption hold with the digest the slot shows', async () => {
    const user = userEvent.setup();
    const row = waiting('check_hold', { finding: 'archive_year_missing' }, { release_check: { slot_id: 'w1', expected_revision: 4 }, redo: { project_id: 'area-1', package_revision: 3 } });
    const { calls } = open('/posts?slot=w1', postsOut({ rows: [row] }), {
      'GET /api/studio/slots/w1': { slot: { id: 'w1', revision: 4 }, material_check: { revision: 1, findings: [], digest: 'd'.repeat(64), released: false, hard: [], holds: true } },
      'POST /api/studio/slots/w1/material-check/release': {},
    });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.release }));
    await user.click(await screen.findByRole('button', { name: tr.materials.hold.releaseConfirm }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/studio/slots/w1/material-check/release')?.body).toEqual({ expected_revision: 4, digest: 'd'.repeat(64) }));
  });

  it('a TikTok post approved on its screen is planned: no TikTok wait, no button', async () => {
    const approved = postRow('slot:s-tiktok', {
      title: 'Çarkta bir kupanın doğuşu',
      channel: TIKTOK,
      status: 'scheduled',
      waits: [],
      actions: { cancel: { kind: 'post', slot_id: 's-tiktok', expected_revision: 3 } },
    });
    open('/posts?slot=s-tiktok', postsOut({ rows: [approved] }));
    const p = await panel();
    expect(await within(p).findByText(P.status.scheduled)).toBeInTheDocument();
    expect(within(p).queryByTestId('wait-sentence')).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: P.actions.tiktok })).not.toBeInTheDocument();
  });

  it('opens the TikTok screen over the page', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts?slot=s-tiktok', postsOut(), { 'GET /api/studio/pending': { slots: [], approvals: [], budget_moves: [], blockers: [], paid_alerts: [] } });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.tiktok }));
    await waitFor(() => expect(router.state.location.search).toBe('?slot=s-tiktok&tiktok=s-tiktok'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('adds a photo to a need and to a capture', async () => {
    const user = userEvent.setup();
    const need = waiting('need_photo', { request: 'Fırının içinden bir video çek' }, { add_files: { kind: 'need', shoot_request_id: 'n-1' } }, { kind: 'need' });
    const { calls } = open('/posts?slot=w1', postsOut({ rows: [need] }), { 'POST /api/studio/files': { id: 'file-1' }, 'POST /api/content/files': {} });
    await within(await panel()).findByRole('button', { name: P.actions.addPhoto });
    const input = screen.getByTestId(`pick-${P.actions.addPhoto}`);
    await user.upload(input, new File(['x'], 'firin.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/files')?.body).toEqual({ request_key: expect.any(String), target: { kind: 'need', shoot_request_id: 'n-1' }, file_ids: ['file-1'] }));
  });

  it('picks a time for a version no agent schedules', async () => {
    const user = userEvent.setup();
    const row = postRow('version:v9', { title: 'Zamanı bekleyen', status: 'waiting_you', waits: [wait('pick_time')], actions: { pick_time: { project_id: 'area-1', version_id: 'v9', accounts: ['cap-ig'] } } });
    const { calls } = open('/posts?version=v9', postsOut({ rows: [row] }), {
      'GET /api/social/accounts': [{ capability_id: 'cap-ig', name: 'alfa.atolye', kind: 'instagram', status: 'verified', paused: false, requires_human_approval: false, latest: null, next: null }],
      'POST /api/social/versions/schedule': {},
    });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.pickTime }));
    const field = await screen.findByLabelText(tr.socialAccounts.scheduleAt);
    fireEvent.change(field, { target: { value: '2030-01-02T10:00' } });
    await user.click(screen.getByRole('button', { name: tr.socialAccounts.schedule }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/social/versions/schedule')?.body).toMatchObject({ project_id: 'area-1', version_id: 'v9', capability_id: 'cap-ig' }));
  });
});

describe('a post that did not go out', () => {
  it.each([
    ['auth', { reconnect: 'cap-ig' }, 'Instagram bu paylaşımı almadı: bağlantının izni bitti.', 'link', P.actions.reconnect],
    ['validation', {}, 'Instagram bu paylaşımı almadı: platform içeriği kabul etmedi.', 'button', P.actions.redo],
    ['rate_limited', {}, 'Instagram bu paylaşımı almadı: platform geçici olarak almadı.', 'button', P.actions.retry],
    ['missed_grace', {}, 'Instagram bu paylaşımı almadı: zamanı geçti.', 'button', P.actions.retry],
  ] as const)('acts by its reason (%s) and can be let go', async (reason, more, sentence, role, label) => {
    const row = postRow('slot:f1', { title: 'Gitmeyen', status: 'failed', waits: [wait('failed', { reason, kind: 'instagram' })], actions: { redo: { project_id: 'area-1', package_revision: 2 }, acknowledge: { slot_id: 'f1', expected_revision: 6 }, ...more } });
    const user = userEvent.setup();
    const { calls } = open('/posts?slot=f1', postsOut({ rows: [row] }), { 'POST /api/content/posts/f1/dismiss': {} });
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(sentence);
    expect(within(p).getByRole(role, { name: label })).toBeInTheDocument();
    await user.click(within(p).getByRole('button', { name: P.actions.dismiss }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/posts/f1/dismiss')?.body).toEqual({ expected_revision: 6 }));
  });

  it('leaves an account that still cannot post to a manager, offering no retry', async () => {
    const row = postRow('slot:f4', { title: 'Gitmeyen', status: 'failed', waits: [wait('failed', { reason: 'permission', kind: 'instagram' })], actions: { redo: { project_id: 'area-1', package_revision: 2 }, acknowledge: { slot_id: 'f4', expected_revision: 1 } } });
    open('/posts?slot=f4', postsOut({ rows: [row] }));
    const p = await panel();
    expect(await within(p).findByText(P.panel.managerReconnect)).toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: P.actions.retry })).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: P.actions.redo })).not.toBeInTheDocument();
    expect(within(p).getByRole('button', { name: P.actions.dismiss })).toBeInTheDocument();
  });

  it('says TikTok has not audited the app, offers no reconnect and prepares it again', async () => {
    const row = postRow('slot:f5', { title: 'Gitmeyen', status: 'failed', waits: [wait('failed', { reason: 'app_not_audited', kind: 'tiktok', recovered: false, drafts: true })], actions: { redo: { project_id: 'area-1', package_revision: 2 }, acknowledge: { slot_id: 'f5', expected_revision: 1 } } });
    open('/posts?slot=f5', postsOut({ rows: [row] }));
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(
      "TikTok bu paylaşımı almadı: Jeeta'nın TikTok uygulaması henüz denetlenmediği için herkese açık hesaba doğrudan paylaşım yapılamıyor; yeniden hazırlatıp TikTok'a taslak olarak göndermeyi dene.",
    );
    expect(within(p).queryByText(/bağlantı yenilendi/)).not.toBeInTheDocument();
    expect(within(p).queryByRole('link', { name: P.actions.reconnect })).not.toBeInTheDocument();
    expect(within(p).queryByText(P.panel.managerReconnect)).not.toBeInTheDocument();
    expect(within(p).getByRole('button', { name: P.actions.retry })).toBeInTheDocument();
  });

  it('asks to reconnect TikTok first when the connection has no draft grant', async () => {
    const row = postRow('slot:f6', { title: 'Gitmeyen', status: 'failed', waits: [wait('failed', { reason: 'app_not_audited', kind: 'tiktok', recovered: false, drafts: false })], actions: { redo: { project_id: 'area-1', package_revision: 2 }, reconnect: 'cap-tt' } });
    open('/posts?slot=f6', postsOut({ rows: [row] }));
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent(
      "TikTok bu paylaşımı almadı: Jeeta'nın TikTok uygulaması henüz denetlenmediği için herkese açık hesaba doğrudan paylaşım yapılamıyor; taslak izni için önce TikTok'u yeniden bağla, sonra yeniden hazırlatıp taslak olarak göndermeyi dene.",
    );
    expect(within(p).getByRole('link', { name: P.actions.reconnect })).toHaveAttribute('href', '/connect?capability=cap-tt');
  });

  it('says a renewed connection and offers to prepare it again', async () => {
    const row = postRow('slot:f2', { title: 'Gitmeyen', status: 'failed', waits: [wait('failed', { reason: 'auth', kind: 'instagram', recovered: true })], actions: { redo: { project_id: 'area-1', package_revision: 2 } } });
    open('/posts?slot=f2', postsOut({ rows: [row] }));
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toHaveTextContent('Instagram bu paylaşımı almadı: bağlantı yenilendi, yeniden hazırlatabilirsin.');
    expect(within(p).getByRole('button', { name: P.actions.retry })).toBeInTheDocument();
  });

  it('prefills “Tekrar hazırlat” and says which other posts are taken back', async () => {
    const user = userEvent.setup();
    const row = postRow('slot:f3', {
      title: 'Gitmeyen', status: 'failed', waits: [wait('failed', { reason: 'rate_limited', kind: 'instagram' })],
      actions: { redo: { project_id: 'area-1', package_revision: 2 } },
      siblings: [{ row_id: 'slot:x', channel: TIKTOK, publish_at: ahead(30 * 3600_000), status: 'scheduled' }, { row_id: 'slot:y', channel: INSTAGRAM, publish_at: ago(3600_000), status: 'published' }],
    });
    const { calls } = open('/posts?slot=f3', postsOut({ rows: [row] }), { 'POST /api/content/areas/area-1/redo': {} });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.retry }));
    const dialog = await screen.findByRole('dialog', { name: P.redo.title });
    expect(within(dialog).getByPlaceholderText(P.redo.placeholder)).toHaveValue(P.redo.retryText);
    expect(within(dialog).getByText(/^Bu içerikten 1 paylaşım daha var \(TikTok · .+\); o da yeniden hazırlanır\.$/)).toBeInTheDocument();
    expect(within(dialog).getByText(P.redo.published)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: P.redo.send }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/areas/area-1/redo')?.body).toEqual({ package_revision: 2, note: P.redo.retryText }));
  });
});

describe('İptal', () => {
  it('cancels a post with the default reason', async () => {
    const user = userEvent.setup();
    const { calls } = open('/posts?slot=s-approve', postsOut(), { 'POST /api/studio/slots/s-approve/cancel': {} });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.cancel }));
    const dialog = await screen.findByRole('dialog', { name: P.cancel.title });
    expect(within(dialog).getByText(/paylaşımı çıkmayacak\. Aynı içerikten diğer paylaşımlar yerinde kalır\.$/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: P.cancel.confirm }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/studio/slots/s-approve/cancel')?.body).toEqual({ expected_revision: 4, reason: P.cancel.defaultReason }));
  });

  it('cancels a version with the owner’s reason', async () => {
    const user = userEvent.setup();
    const { calls } = open('/posts?version=v-sched', postsOut(), { 'POST /api/content/areas/area-4/versions/v-sched/cancel': {} });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.cancel }));
    const dialog = await screen.findByRole('dialog', { name: P.cancel.title });
    expect(within(dialog).getByText(P.cancel.version)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(P.cancel.reason), 'Stokta yok');
    await user.click(within(dialog).getByRole('button', { name: P.cancel.confirm }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/areas/area-4/versions/v-sched/cancel')?.body).toEqual({ package_revision: 1, reason: 'Stokta yok' }));
    expect(await within(await panel()).findByText(P.panel.gone)).toBeInTheDocument();
  });

  it('archives a content and takes it back with Geri al', async () => {
    const user = userEvent.setup();
    const { calls } = open('/posts?content=area-3', postsOut(), { 'PATCH /api/studio/projects/area-3': { id: 'area-3', revision: 6 } });
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.cancel }));
    const dialog = await screen.findByRole('dialog', { name: P.cancel.title });
    expect(within(dialog).getByText(P.cancel.content)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: P.cancel.confirm }));
    await waitFor(() => expect(sent(calls, 'PATCH', '/api/studio/projects/area-3')?.body).toEqual({ expected_revision: 5, archived: true }));
    const p = await panel();
    expect(await within(p).findByText(P.panel.gone)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: P.panel.undo }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ expected_revision: 6, archived: false }));
    expect(await within(p).findByRole('heading', { name: 'Yılbaşı için kurumsal hediye kupası' })).toBeInTheDocument();
    expect(within(p).queryByText(P.panel.gone)).not.toBeInTheDocument();
  });

  it('says a failed Geri al in the owner’s words', async () => {
    const user = userEvent.setup();
    let n = 0;
    setViewport('desk');
    const answers = postsAnswers(postsOut());
    Object.defineProperty(answers, 'PATCH /api/studio/projects/area-3', {
      enumerable: true,
      get: () => { n += 1; return n === 1 ? { id: 'area-3', revision: 6 } : withStatus(409, { code: 'CONFLICT', message: 'stale', details: {} }); },
    });
    mockFetch(answers);
    renderAt('/posts?content=area-3');
    await user.click(await within(await panel()).findByRole('button', { name: P.actions.cancel }));
    await user.click(within(await screen.findByRole('dialog', { name: P.cancel.title })).getByRole('button', { name: P.cancel.confirm }));
    await user.click(await screen.findByRole('button', { name: P.panel.undo }));
    expect(await screen.findByText(P.panel.changed)).toBeInTheDocument();
  });
});

describe('the brake', () => {
  it('says it once, shows unsent rows stopped and resumes posting', async () => {
    const user = userEvent.setup();
    const stopped = postRow('slot:p1', { title: 'Bekleyen gönderi', status: 'paused' });
    const { calls } = open('/posts?slot=p1', postsOut({ rows: [stopped], brake: { revision: 12, can_resume: true }, composer: { ...postsOut().composer, stops: [{ code: 'braked', at: null }] } }), { 'POST /api/studio/brake': { revision: 13, brake_engaged: false, lanes: {} } });
    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(P.brake.line);
    expect(within(await rowButton('Bekleyen gönderi')).getByText(P.status.paused)).toBeInTheDocument();
    expect(await within(await panel()).findByText(P.brake.paused)).toBeInTheDocument();
    expect(screen.getByText(P.composer.stops.braked)).toBeInTheDocument();
    await user.click(within(line).getByRole('button', { name: P.actions.resume }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/studio/brake')?.body).toEqual({ engaged: false, lane: 'organic', expected_revision: 12 }));
  });

  it('tells who cannot resume that a manager does', async () => {
    open('/posts', postsOut({ brake: { revision: 12, can_resume: false } }));
    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(P.brake.other);
    expect(within(line).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the composer', () => {
  it('says every stop, advice only on focus, and a named platform that is not connected', async () => {
    const user = userEvent.setup();
    const stops = (['knowledge_empty', 'no_account', 'no_content_agent', 'agent_sleeps', 'agent_late'] as const).map((code) => ({ code, at: ahead(3600_000) }));
    open('/posts', postsOut({ composer: { ...postsOut().composer, stops } }));
    const region = await screen.findByRole('region', { name: P.composer.region });
    // The stops are the read's: said once it has answered.
    expect(await within(region).findByText(P.composer.stops.knowledge_empty)).toBeInTheDocument();
    expect(within(region).getByText(P.composer.stops.no_account)).toBeInTheDocument();
    expect(within(region).getByText(P.composer.stops.no_content_agent)).toBeInTheDocument();
    expect(within(region).getByText(/^Ajanın çağrı adresi yok; bir sonraki çalışmasında \(.+\) başlar\.$/)).toBeInTheDocument();
    expect(within(region).getByText(/^Ajan .+ bekleniyordu, gecikti\.$/)).toBeInTheDocument();
    expect(within(region).queryByText(/Onayına gelir/)).not.toBeInTheDocument();
    const input = within(region).getByLabelText(P.composer.label);
    await user.click(input);
    expect(within(region).getByText('Onayına gelir · TikTok\'ta her paylaşımı sen onaylarsın')).toBeInTheDocument();
    await user.type(input, 'Yeni kupalar, sadece LinkedIn ve instada');
    expect(within(region).getByText('LinkedIn hesabın bağlı değil; bu istek oraya çıkamaz.')).toBeInTheDocument();
    expect(within(region).queryByText(/^Instagram hesabın/)).not.toBeInTheDocument();
    // Sending stays possible whatever the stops say (D20).
    expect(within(region).getByRole('button', { name: P.composer.send })).toBeEnabled();
  });

  it('uploads the files one by one, then asks for the post; the new row comes first and selected', async () => {
    const user = userEvent.setup();
    const created = postRow('content:area-new', { title: 'Anneler günü için kupa', kind: 'content', area_id: 'area-new', status: 'preparing', sub_state: { kind: 'queued', wakes_now: true, next_at: null, late: false }, progress: { index: 0, state: 'current' }, channel: null, publish_at: null });
    let n = 0;
    let requested = false;
    setViewport('desk');
    const answers = postsAnswers(postsOut(), {
      'GET /api/content/posts/content%3Aarea-new': detailOf(created),
    });
    // Read on every call: each upload gets its own file id; the read holds the row once asked.
    Object.defineProperty(answers, 'POST /api/studio/files', { enumerable: true, get: () => { n += 1; return { id: `file-${n}` }; } });
    Object.defineProperty(answers, 'POST /api/content/post-requests', { enumerable: true, get: () => { requested = true; return { row: created, stops: [] }; } });
    Object.defineProperty(answers, 'GET /api/content/posts', { enumerable: true, get: () => postsOut({ rows: requested ? [created, ...rows] : rows }) });
    const calls = mockFetch(answers);
    const { router } = renderAt('/posts');
    const region = await screen.findByRole('region', { name: P.composer.region });
    await user.upload(screen.getByTestId('composer-file-input'), [new File(['a'], 'kupa1.jpg', { type: 'image/jpeg' }), new File(['b'], 'kupa2.png', { type: 'image/png' })]);
    expect(within(region).getByText('kupa1.jpg')).toBeInTheDocument();
    await user.type(within(region).getByLabelText(P.composer.label), 'Anneler günü için kupa{Enter}');
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/post-requests')).toBeDefined());
    expect(calls.filter((c) => c.path === '/api/studio/files')).toHaveLength(2);
    expect(sent(calls, 'POST', '/api/content/post-requests')!.body).toEqual({ request_key: expect.any(String), text: 'Anneler günü için kupa', file_ids: ['file-1', 'file-2'] });
    expect(await screen.findByText(P.composer.sent)).toBeInTheDocument();
    expect(screen.getByText(P.composer.wakesNow)).toBeInTheDocument();
    expect(within(region).getByLabelText(P.composer.label)).toHaveValue('');
    await waitFor(() => expect(router.state.location.search).toBe('?content=area-new'));
    const t = await table();
    expect(within(t).getAllByRole('button')[0]).toHaveTextContent('Anneler günü için kupa');
    // Once the read holds it, it is the read's row: shown once.
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/content/posts').length).toBeGreaterThan(1));
    await waitFor(() => expect(within(t).getAllByText('Anneler günü için kupa')).toHaveLength(1));
  });

  it('drops the new row once a later read no longer holds it', async () => {
    const user = userEvent.setup();
    const created = postRow('content:area-gone', { title: 'Bir günlük istek', kind: 'content', area_id: 'area-gone', status: 'preparing', progress: { index: 0, state: 'current' }, channel: null, publish_at: null });
    const { calls } = open('/posts', postsOut(), {
      'POST /api/content/post-requests': { row: created, stops: [] },
      'GET /api/content/posts/content%3Aarea-gone': detailOf(created),
    });
    const region = await screen.findByRole('region', { name: P.composer.region });
    await user.type(within(region).getByLabelText(P.composer.label), 'Bir günlük istek{Enter}');
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/post-requests')).toBeDefined());
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/content/posts').length).toBeGreaterThan(1));
    const t = await table();
    await waitFor(() => expect(within(t).queryByText('Bir günlük istek')).not.toBeInTheDocument());
  });

  it('keeps what the owner typed when a chip is chosen', async () => {
    const user = userEvent.setup();
    setViewport('desk');
    mockFetch({ ...postsAnswers(), 'GET /api/content/posts?filter=onay': delayed(200, postsOut()) });
    const { router } = renderAt('/posts');
    const region = await screen.findByRole('region', { name: P.composer.region });
    await user.type(within(region).getByLabelText(P.composer.label), 'Yarın için bir kupa');
    await user.click(within(screen.getByRole('group', { name: P.chips.label })).getByRole('button', { name: /Onay/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?f=onay'));
    expect(screen.getByRole('textbox', { name: P.composer.label })).toHaveValue('Yarın için bir kupa');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByRole('textbox', { name: P.composer.label })).toHaveValue('Yarın için bir kupa');
  });

  it('says a failed upload and tries again', async () => {
    const user = userEvent.setup();
    const { calls } = open('/posts', postsOut(), { 'POST /api/studio/files': withStatus(500, { code: 'INTERNAL', message: 'x', details: {} }) });
    const region = await screen.findByRole('region', { name: P.composer.region });
    await user.upload(screen.getByTestId('composer-file-input'), new File(['a'], 'kupa.jpg', { type: 'image/jpeg' }));
    await user.type(within(region).getByLabelText(P.composer.label), 'Bir kupa');
    await user.click(within(region).getByRole('button', { name: P.composer.send }));
    expect(await within(region).findByText(new RegExp(P.composer.failed))).toBeInTheDocument();
    expect(sent(calls, 'POST', '/api/content/post-requests')).toBeUndefined();
    expect(within(region).getByRole('button', { name: P.composer.retry })).toBeInTheDocument();
  });

  it('is absent without the permission, and says when the content module is missing', async () => {
    open('/posts', postsOut({ composer: { ...postsOut().composer, allowed: false } }));
    await table();
    expect(screen.queryByRole('region', { name: P.composer.region })).not.toBeInTheDocument();
  });

  it('hides the file button without the library', async () => {
    open('/posts', postsOut({ composer: { ...postsOut().composer, files_allowed: false } }));
    await rowButton('Mavi sır serisi');
    const region = await screen.findByRole('region', { name: P.composer.region });
    expect(within(region).queryByRole('button', { name: P.composer.file })).not.toBeInTheDocument();
  });
});

describe('special days', () => {
  const day = (state: 'none' | 'analysing' | 'needs_permission' | 'unchecked' | 'quality', found: ('face' | 'name')[] = []) => ({
    key: 'ogretmenler_gunu', year: 2026, name: 'Öğretmenler Günü', window_start: '2026-11-10', window_end: '2026-11-24', prepares_from: '2026-11-03',
    phase: 'preparing' as const, shoot_request_id: null, can_add: true, can_skip: true, files: { state, material_ids: ['m5'], permit: [{ material_id: 'm5', expected_revision: 3 }], found },
  });

  it.each([
    ['none', day('none'), /^Öğretmenler Günü \(24 Kas\) için fotoğrafın yok$/, [P.days.add, P.days.skip]],
    ['analysing', day('analysing'), /^Öğretmenler Günü: fotoğrafın inceleniyor\.$/, []],
    ['needs_permission', day('needs_permission', ['face', 'name']), /^Öğretmenler Günü: fotoğrafında yüz, isim var; paylaşılması için izin ver\.$/, [P.actions.permit, P.days.another]],
    ['unchecked', day('unchecked'), /^Öğretmenler Günü: fotoğrafının paylaşılabilir olduğunu onayla\.$/, [P.actions.permit, P.days.another]],
    ['quality', day('quality'), /^Öğretmenler Günü: ajan bu fotoğrafı paylaşmaya uygun bulmadı\.$/, [P.actions.useAnyway, P.days.another]],
  ] as const)('says the %s line with its actions', async (_, line, text, actions) => {
    open('/posts', postsOut({ days: [line] }));
    const region = await screen.findByRole('region', { name: P.days.region });
    expect(within(region).getByText(text)).toBeInTheDocument();
    expect(within(region).queryAllByRole('button').map((b) => b.textContent)).toEqual([...actions]);
  });

  it('dates a season by its day, the end of its window', async () => {
    const yilbasi = { ...day('none'), key: 'yilbasi', name: 'Yılbaşı', window_start: '2026-12-01', window_end: '2026-12-31', prepares_from: '2026-11-10' };
    open('/posts', postsOut({ days: [yilbasi] }));
    const region = await screen.findByRole('region', { name: P.days.region });
    expect(within(region).getByText(/^Yılbaşı \(31 Ara\) için fotoğrafın yok$/)).toBeInTheDocument();
  });

  it('adds a photo to the day and skips it for the year with an undo', async () => {
    const user = userEvent.setup();
    const { calls } = open('/posts', postsOut({ days: [day('none')], days_more: 2 }), {
      'POST /api/studio/files': { id: 'file-d' },
      'POST /api/content/files': {},
      'POST /api/content/special-days/ogretmenler_gunu/2026/skip': { key: 'ogretmenler_gunu', year: 2026, name: 'Öğretmenler Günü', kind: 'special_day', window_start: '2026-11-24', window_end: '2026-11-24', lead_days: null, enabled: false },
      'PUT /api/studio/calendar/ogretmenler_gunu/2026': {},
    });
    const region = await screen.findByRole('region', { name: P.days.region });
    expect(within(region).getByRole('button', { name: '2 özel gün daha' })).toBeInTheDocument();
    await user.upload(screen.getByTestId(`pick-${P.days.add}`), new File(['x'], 'ogretmen.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/files')?.body).toEqual({ request_key: expect.any(String), target: { kind: 'special_day', key: 'ogretmenler_gunu', year: 2026 }, file_ids: ['file-d'] }));
    await user.click(within(region).getByRole('button', { name: P.days.skip }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/content/special-days/ogretmenler_gunu/2026/skip')).toBeDefined());
    expect(await screen.findByText('Bu yıl Öğretmenler Günü için paylaşım yapılmayacak.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: P.days.undo }));
    await waitFor(() => expect(sent(calls, 'PUT', '/api/studio/calendar/ogretmenler_gunu/2026')?.body).toMatchObject({ enabled: true, name: 'Öğretmenler Günü' }));
    expect(sent(calls, 'GET', '/api/studio/calendar')).toBeUndefined();
  });

  it('permits the day’s photos at the revisions the read gave', async () => {
    const user = userEvent.setup();
    const { calls } = open('/posts', postsOut({ days: [day('needs_permission', ['face'])] }), { 'PUT /api/studio/materials/m5/permission': {} });
    const region = await screen.findByRole('region', { name: P.days.region });
    await user.click(within(region).getByRole('button', { name: P.actions.permit }));
    await waitFor(() => expect(sent(calls, 'PUT', '/api/studio/materials/m5/permission')?.body).toEqual({ expected_revision: 3, permission: 'shareable' }));
    expect(sent(calls, 'GET', '/api/studio/materials/m5')).toBeUndefined();
  });

  it('says a failed undo of a skipped day', async () => {
    const user = userEvent.setup();
    open('/posts', postsOut({ days: [day('none')] }), {
      'POST /api/content/special-days/ogretmenler_gunu/2026/skip': { key: 'ogretmenler_gunu', year: 2026, name: 'Öğretmenler Günü', kind: 'special_day', window_start: '2026-11-24', window_end: '2026-11-24', lead_days: null, enabled: false },
      'PUT /api/studio/calendar/ogretmenler_gunu/2026': withStatus(500, { code: 'INTERNAL', message: 'down', details: {} }),
    });
    const region = await screen.findByRole('region', { name: P.days.region });
    await user.click(within(region).getByRole('button', { name: P.days.skip }));
    await user.click(await screen.findByRole('button', { name: P.days.undo }));
    expect(await screen.findByText(tr.errors.INTERNAL)).toBeInTheDocument();
  });

  it('opens a named day in its own year, marked', async () => {
    const { calls } = open('/posts?settings=1&section=days&day=ogretmenler_gunu:2027', postsOut(), {
      'GET /api/studio/calendar': { year: 2027, entries: [{ key: 'ogretmenler_gunu', year: 2027, name: 'Öğretmenler Günü', kind: 'special_day', window_start: '2027-11-24', window_end: '2027-11-24', lead_days: null, enabled: true }], rows: [], policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: false } },
    });
    const dialog = await screen.findByRole('dialog', { name: P.settings.title });
    expect(await within(dialog).findByRole('combobox', { name: tr.materials.calendar.year })).toHaveValue('2027');
    expect(calls.some((c) => c.path === '/api/studio/calendar' && c.search === '?year=2027')).toBe(true);
    expect(await within(dialog).findByTestId('calendar-ogretmenler_gunu')).toHaveAttribute('aria-current', 'true');
  });

  it('opens Ayarlar at the special days for the rest', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts', postsOut({ days: [day('none')], days_more: 4 }));
    await user.click(await screen.findByRole('button', { name: '4 özel gün daha' }));
    await waitFor(() => expect(router.state.location.search).toBe('?settings=1&section=days'));
  });
});

describe('states', () => {
  it('loads with grey chips, skeleton rows and the composer usable', async () => {
    setViewport('desk');
    mockFetch({ ...postsAnswers(), 'GET /api/content/posts': delayed(300, postsOut()) });
    renderAt('/posts');
    expect(await screen.findByRole('group', { name: P.chips.label })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('status', { name: tr.common.loading }).length).toBeGreaterThan(0);
    const input = await screen.findByRole('textbox', { name: P.composer.label });
    expect(input).toBeEnabled();
    expect(screen.getByRole('group', { name: P.chips.label })).toHaveAttribute('aria-busy', 'true');
    await userEvent.setup().type(input, 'Bir kupa');
    expect(await table()).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: P.composer.label })).toHaveValue('Bir kupa');
  });

  it('says it could not load, and loads again', async () => {
    const user = userEvent.setup();
    setViewport('desk');
    const calls = mockFetch({ ...postsAnswers(), 'GET /api/content/posts': withStatus(500, { code: 'INTERNAL', message: 'down', details: {} }) });
    renderAt('/posts');
    expect(await screen.findByText(P.loadError)).toBeInTheDocument();
    const before = calls.filter((c) => c.path === '/api/content/posts').length;
    await user.click(screen.getByRole('button', { name: tr.common.retry }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/content/posts').length).toBeGreaterThan(before));
  });

  it.each([
    ['empty', postsOut({ rows: [], counts: { all: 0, you: 0, stages: {} } }), P.empty.plain],
    ['empty knowledge base', postsOut({ rows: [], knowledge_empty: true, counts: { all: 0, you: 0, stages: {} } }), P.empty.knowledge],
  ] as const)('says the page is %s', async (_, data, text) => {
    open('/posts', data, { 'GET /api/knowledge': emptyKnowledge });
    expect(await within(await table()).findByText(text)).toBeInTheDocument();
  });

  it('says nothing waits for you, and shows all', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts?f=you', postsOut({ rows: [], counts: { all: 3, you: 0, stages: { yayin: 3 } } }));
    expect(await within(await table()).findByText(P.empty.you)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: P.empty.showAll }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('says a stage holds nothing', async () => {
    open('/posts?f=yayin', postsOut({ rows: [], counts: { all: 3, you: 0, stages: { yayin: 3 } } }));
    expect(await within(await table()).findByText(P.empty.stage)).toBeInTheDocument();
  });

  it('shows cards and a full-screen panel on a phone', async () => {
    const user = userEvent.setup();
    setViewport('phone');
    mockFetch(postsAnswers());
    const { router } = renderAt('/posts');
    const t = await table();
    const card = (await within(t).findByText('Mavi sır serisi')).closest('button')!;
    expect(within(card).getByText(/^Instagram · /)).toBeInTheDocument();
    // No panel until a row is chosen.
    expect(screen.queryByRole('complementary', { name: P.panel.label })).not.toBeInTheDocument();
    await user.click(card);
    const sheet = await screen.findByRole('dialog', { name: P.panel.label });
    expect(await within(sheet).findByRole('heading', { name: 'Mavi sır serisi' })).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: P.panel.back }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('opens the panel over the table on a tablet', async () => {
    setViewport('tablet');
    mockFetch(postsAnswers());
    renderAt('/posts?slot=s-live');
    const sheet = await screen.findByRole('dialog', { name: P.panel.label });
    expect(await within(sheet).findByRole('heading', { name: 'Mavi sır serisi' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: tr.kit.close })).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('shows the header buttons to who may open them', async () => {
    open();
    await table();
    expect(screen.getByRole('button', { name: P.header.files })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: P.header.accounts })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: P.header.settings })).toBeInTheDocument();
  });

  it('hides Hesaplar from a content member', async () => {
    open('/posts', postsOut(), { 'GET /api/auth/me': withPermissions(['content.work', 'content.manage']) });
    await table();
    expect(screen.queryByRole('button', { name: P.header.accounts })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: P.header.files })).not.toBeInTheDocument();
  });

  it('shows Dosyalar to a library member', async () => {
    open('/posts', postsOut({ composer: { ...postsOut().composer, allowed: false } }), { 'GET /api/auth/me': withPermissions(['materials.work'], 'rep') });
    await table();
    expect(screen.getByRole('button', { name: P.header.files })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: P.composer.region })).not.toBeInTheDocument();
  });

  it('gives no button row where the read gives no action', async () => {
    const row = postRow('slot:r1', { title: 'Okunan', status: 'waiting_you', waits: [wait('approval')], actions: {} });
    open('/posts?slot=r1', postsOut({ rows: [row] }), { 'GET /api/auth/me': withPermissions(['content.work'], 'rep') });
    const p = await panel();
    expect(await within(p).findByTestId('wait-sentence')).toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: P.actions.approve })).not.toBeInTheDocument();
    expect(within(p).queryByRole('group')).not.toBeInTheDocument();
  });

  it('answers a member with none of the five permissions that they may not see it', async () => {
    const calls = mockFetch(postsAnswers(postsOut(), { 'GET /api/auth/me': withPermissions(['workspace.read'], 'rep') }));
    renderAt('/posts');
    expect(await screen.findByRole('alert')).toHaveTextContent(P.forbidden);
    expect(calls.some((c) => c.path === '/api/content/posts')).toBe(false);
  });

  it('runs a late agent now from the queued content’s panel', async () => {
    const row = postRow('content:q1', { title: 'Sırada bekleyen', kind: 'content', status: 'preparing', sub_state: { kind: 'queued', wakes_now: false, next_at: ago(3600_000), late: true }, progress: { index: 0, state: 'current' } });
    open('/posts?content=q1', postsOut({ rows: [row] }), {
      'GET /api/agents/wakes': wakes({ content: { state: 'schedule', next_expected_at: ago(3600_000), interval_minutes: 60, has_address: true, failed_at: null, run_now: { api_key_id: 'k1', after: null } } }),
    });
    const p = await panel();
    expect(await within(p).findByText(/^Sırada · ajan .+ bekleniyordu, gecikti$/)).toBeInTheDocument();
    expect(await within(p).findByRole('button', { name: tr.wake.line.runNow })).toBeInTheDocument();
  });
});

describe('the agent line', () => {
  it('speaks for the agent whose work waits and is not at work', async () => {
    const queued = postRow('content:q2', { title: 'Sıradaki içerik', kind: 'content', status: 'preparing', sub_state: { kind: 'queued', wakes_now: false, next_at: null, late: false }, progress: { index: 0, state: 'current' } });
    open('/posts', postsOut({ rows: [queued] }), {
      'GET /api/agents/wakes': wakes({ content: { state: 'calling', api_key_id: 'k1', due_at: new Date(Date.now() + 40_000).toISOString(), waiting_for: 'settle' } }),
    });
    expect(await screen.findByText(/^Ajan (39|40) sn içinde çağrılacak$/)).toBeInTheDocument();
    expect(screen.getAllByTestId('agent-wake-line')).toHaveLength(1);
  });

  it('says when an agent last ran while nothing waits', async () => {
    open('/posts', postsOut({ rows: [postRow('slot:done', { status: 'published', published_at: ago(3600_000) })] }), {
      'GET /api/agents/wakes': wakes({}, [{ api_key_id: 'k1', address: null, pending: null, last: null, last_seen_at: ago(2 * 3600_000), interval_minutes: 60, interval_learned: false, next_expected_at: null, run_now: null }]),
    });
    expect(await screen.findByTestId('agent-ran')).toHaveTextContent(/^Ajan 2 saat önce çalıştı\.$/);
  });
});

describe('the channel words', () => {
  it('names the account beside the platform when two share it, in the panel’s details too', async () => {
    open('/posts?slot=s-planned');
    const p = await panel();
    expect(await within(p).findByText('Instagram · alfa.magaza')).toBeInTheDocument();
    expect(INSTAGRAM_SHOP.label).toBe('Instagram · alfa.magaza');
  });
});
