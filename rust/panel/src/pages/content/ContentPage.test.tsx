import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAt } from '@/test/render';
import { coreModules, legacyModules } from '@/test/modules';
import { contentPageFetch, folder, intelligence, material, meWith, olay, queueItem, row, stages, tree, view } from '@/test/contentPage';
import { detail, pack, version } from '@/test/content';
import { dayFrom } from '@/test/materials';
import { groupTree } from './ContentTree';

const o1 = olay('o1', { title: 'Yılbaşı', starts_on: dayFrom(-2), ends_on: dayFrom(5) });
const old = olay('o2', { title: 'Cadılar', starts_on: dayFrom(-30), ends_on: dayFrom(-20) });
const late = olay('o3', { title: 'Ekim çekimi', starts_on: dayFrom(-40), ends_on: dayFrom(-35) });
const next = olay('o4', { title: 'Sergi', starts_on: dayFrom(10), ends_on: dayFrom(11) });
/** What a sighted person reads: the text without what is there for screen readers only. */
function visibleText(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return copy.textContent ?? '';
}
const day = { key: 'sevgililer', year: 2027, name: 'Sevgililer Günü', kind: 'special_day', window_start: dayFrom(20), window_end: dayFrom(20), prepares_from: dayFrom(5) };

describe('the tree', () => {
  it('groups olays by their days, keeps a waiting past olay in Şimdi and joins the coming special days', () => {
    const t = tree({
      olays: [
        { ...folder(), olay: next },
        { ...folder({ files: 3 }), olay: o1 },
        { ...folder(), olay: old },
        { ...folder({ waits: ['content_problem'] }), olay: late },
      ] as never,
      upcoming: [day] as never,
    });
    const g = groupTree(t);
    expect(g.now.map((o) => o.olay.id)).toEqual(['o1', 'o3']);
    expect(g.soon.map((s) => (s.kind === 'olay' ? s.item.olay.id : s.day.key))).toEqual(['o4', 'sevgililer']);
    expect(g.past.map((o) => o.olay.id)).toEqual(['o2']);
  });

  it('shows Tüm üretim, the folders, Genel, the past folded away and the queue with its size', async () => {
    contentPageFetch({
      'GET /api/content/tree': tree({ olays: [{ ...folder({ files: 3, waits: ['olay_proposed'] }), olay: o1 }, { ...folder(), olay: old }] as never, upcoming: [day] as never, analysis_queue: 4, areas: 2 }),
    });
    renderAt('/content');
    const nav = await screen.findByRole('navigation', { name: 'Olaylar' });
    expect(within(nav).getByRole('link', { name: /Tüm üretim/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /Yılbaşı/ })).toHaveAttribute('href', '/content?olay=o1');
    expect(within(nav).getByRole('link', { name: /Yılbaşı/ })).toHaveTextContent('Sizi bekleyen bir şey var');
    expect(within(nav).getByRole('link', { name: /Genel/ })).toHaveAttribute('href', '/content?olay=genel');
    expect(within(nav).getByRole('link', { name: /Sevgililer Günü/ })).toHaveAttribute('href', '/content?day=sevgililer%3A2027');
    expect(within(nav).getByRole('link', { name: /Analiz sırası/ })).toHaveTextContent('4');
    expect(within(nav).queryByRole('link', { name: /Cadılar/ })).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: /Geçmiş/ }));
    expect(within(nav).getByRole('link', { name: /Cadılar/ })).toBeVisible();
  });
});

describe('a pipeline row', () => {
  const metric = { version_id: 'v1', publication_id: 'p1', window: 'hours72' as const, measured_at: '2026-11-10T10:00:00Z', metrics: { reach: 6240, saves: 412, likes: null } };
  const rows = [
    row('a', {
      current_step: 9,
      area: { status: { state: 'waiting_material', step: 9, note: null, starts_at: '2026-10-01T09:00:00Z' }, open_requests: 2 },
      stages: stages({
        hazirlik: { state: 'done', steps: [{ step: 3, note: '', at: '2026-10-01T09:00:00Z', output: 'Instagram · Reels' }] },
        fikir: { state: 'done', steps: [{ step: 6, note: '', at: '2026-10-01T09:00:00Z', output: 'Bir figür, bir hatıra' }] },
        metin: 'done',
        gorsel: 'waiting_person',
      }),
    }),
    row('b', {
      current_step: 13,
      area: { status: { state: 'held', step: 13, note: null, starts_at: '2026-10-01T09:00:00Z' } },
      stages: stages({ hazirlik: 'done', fikir: 'done', metin: 'done', gorsel: 'done', paket: 'problem' }),
    }),
    row('c', {
      current_step: 14,
      area: { status: { state: 'done', step: 14, note: null, starts_at: '2026-10-01T09:00:00Z' } },
      stages: stages({
        hazirlik: 'done', fikir: 'done', metin: 'done', gorsel: 'done',
        paket: { state: 'done', package: { revision: 1, delivered_at: '2026-11-01T10:00:00Z', summary: 's', released: false, versions: [{ id: 'v1', format: 'reel', capability_id: null, title: null, material_ids: [], slot_id: 's1' }] } },
        onay: { state: 'done', approvals: [{ version_id: 'v1', slot_id: 's1', required: false, waiting: false, approved_by: null, approved_at: null }] },
        yayin: { state: 'done', publications: [{ version_id: 'v1', slot_id: 's1', capability_id: 'c1', account_name: '@figurunica', state: 'measured', scheduled_at: '2026-11-02T16:00:00Z', published_at: '2026-11-02T16:00:00Z', url: 'https://instagram.example/p/1', failed: false }] },
        sonuc: { state: 'done', results: [metric] },
      }),
    }),
    row('d', {
      current_step: 2,
      stages: stages({ hazirlik: 'current' }),
    }),
  ];

  it('names every stage with its state and outputs, shows only the current one\'s, and the one thing that waits under the track', async () => {
    contentPageFetch({ 'GET /api/content/areas': { areas: rows, next_cursor: null, next_done_before: null } });
    renderAt('/content');
    const a = await screen.findByRole('article', { name: 'İçerik a' });
    const stagesOf = (el: HTMLElement) => within(within(el).getByRole('list', { name: 'Üretim aşamaları' })).getAllByRole('listitem');
    const label = (li: HTMLElement) => li.querySelector('[data-stage-label]')?.textContent;
    expect(stagesOf(a).map(label)).toEqual([
      'Hazırlık: tamamlandı · Instagram · Reels', 'Fikir: tamamlandı · Bir figür, bir hatıra', 'Metin: tamamlandı', 'Görsel: sizi bekliyor · Ajan 2 çekim istedi',
      'Paket: sırada', 'Onay: sırada', 'Yayın: sırada', 'Sonuç: sırada',
    ]);
    // A finished stage's output is in its name only; on screen the row shows its tick.
    expect(visibleText(a)).not.toContain('Instagram · Reels');
    expect(visibleText(a)).not.toContain('Bir figür, bir hatıra');
    // What the bar says is said once.
    expect(visibleText(a).match(/Ajan 2 çekim istedi/g)).toHaveLength(1);
    expect(within(a).getByRole('link', { name: 'Eksiklere git' })).toHaveAttribute('href', '/content?olay=genel#eksikler');

    const b = screen.getByRole('article', { name: 'İçerik b' });
    expect(label(stagesOf(b)[4])).toBe('Paket: sorun var · Takıldı');
    expect(within(b).getByText('Sorun var · Paket')).toBeVisible();
    expect(visibleText(b)).not.toContain('Takıldı');

    const c = screen.getByRole('article', { name: 'İçerik c' });
    expect(stagesOf(c).every((li) => label(li)?.split(' · ')[0].endsWith('tamamlandı'))).toBe(true);
    expect(label(stagesOf(c)[4])).toContain('Reels');
    expect(label(stagesOf(c)[5])).toContain('Onay gerekmedi');
    expect(label(stagesOf(c)[6])).toMatch(/@figurunica · yayında/);
    // All done: the row speaks of its results, the measured numbers only, a null counter left out.
    expect(visibleText(stagesOf(c)[7])).toContain('6.240 erişim · 412 kayıt');
    expect(visibleText(c)).not.toContain('beğeni');
    expect(visibleText(c)).not.toContain('@figurunica');

    const d = screen.getByRole('article', { name: 'İçerik d' });
    expect(label(stagesOf(d)[0])).toBe('Hazırlık: sürüyor · Hedef kitleyi tanımla');
    expect(visibleText(stagesOf(d)[0])).toContain('Hedef kitleyi tanımla');
    expect(stagesOf(d)[0]).toHaveAttribute('aria-current', 'step');
  });

  it('opens to the fourteen steps and the package versions in a phone frame, in the address', async () => {
    const done = rows[2];
    contentPageFetch({
      'GET /api/content/areas': { areas: [done], next_cursor: null, next_done_before: null },
      'GET /api/studio/projects/c': detail({ ...(await import('@/test/content')).area('c'), packages: [{ ...pack, versions: [{ ...version, format: 'reel', material_ids: ['m1'] }, { ...version, id: 'v2' }] }] } as never, [material('m1')]),
    });
    const { router } = renderAt('/content');
    const c = await screen.findByRole('article', { name: 'İçerik c' });
    await userEvent.click(within(c).getByRole('button', { name: /İçerik c/ }));
    expect(router.state.location.search).toBe('?content=c');
    const steps = await within(c).findByRole('list', { name: 'Üretim adımları' });
    expect(steps.querySelectorAll('li[aria-current], ol ol > li').length).toBe(14);
    expect(await within(c).findByTestId('platform-frame')).toBeVisible();
    expect(within(c).getAllByRole('tab')).toHaveLength(2);
    expect(within(c).getByRole('link', { name: 'Gönderiyi aç' })).toHaveAttribute('href', 'https://instagram.example/p/1');
    await userEvent.click(within(c).getByRole('button', { name: /İçerik c/ }));
    expect(router.state.location.search).toBe('');
  });
});

describe('uploads and the analysis queue', () => {
  it('adds every file unfiled: no olay, no genel, no share permission', async () => {
    const calls = contentPageFetch({
      'POST /api/studio/files': { id: 'f1' },
      'POST /api/studio/materials': { material: material('m9', { binding: { kind: 'unfiled' } }), olay_suggestions: [] },
      'GET /api/content/olays/o1': view({ olay: o1 as never }),
      'GET /api/content/tree': tree({ olays: [{ ...folder(), olay: o1 }] as never }),
    });
    renderAt('/content?olay=o1');
    await screen.findByRole('heading', { name: /Yılbaşı/ });
    const file = new File(['x'], 'kupa.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('content-upload-input'), { target: { files: [file] } });
    expect(await screen.findByText('1 dosya analiz sırasına girdi')).toBeVisible();
    const add = calls.find((c) => c.method === 'POST' && c.path === '/api/studio/materials');
    expect(add?.body).toEqual({ request_key: expect.stringMatching(/:material$/), file_id: 'f1', origin: { kind: 'real' } });
    expect(screen.getByRole('link', { name: 'Analiz sırasını aç' })).toHaveAttribute('href', '/content?view=queue');
  });

  it('refuses a file type the store does not take without sending it', async () => {
    const calls = contentPageFetch();
    renderAt('/content');
    await screen.findByRole('navigation', { name: 'Olaylar' });
    fireEvent.change(screen.getByTestId('content-upload-input'), { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText(/Bu dosya türü ya da boyutu alınmıyor/)).toBeVisible();
    expect(calls.some((c) => c.path === '/api/studio/files')).toBe(false);
  });

  it('says nothing of a stale agent when no file waits for analysis', async () => {
    contentPageFetch({
      'GET /api/content/analysis-queue': { items: [queueItem('q2', 'needs_filing')] },
    });
    renderAt('/content?view=queue');
    expect(await screen.findByText('Dosyalanmalı')).toBeVisible();
    expect(screen.queryByText(/ajanı bekliyor/)).not.toBeInTheDocument();
  });

  it('shows each stage, says when no agent is connected and lets a manager file an analysed upload', async () => {
    const calls = contentPageFetch({
      'GET /api/agents': [],
      'GET /api/content/tree': tree({ olays: [{ ...folder(), olay: o1 }] as never, analysis_queue: 3 }),
      'GET /api/content/analysis-queue': { items: [queueItem('q1', 'waiting'), queueItem('q2', 'needs_filing'), queueItem('q3', 'failed')] },
      'POST /api/studio/materials/q2/bind': material('q2'),
    });
    renderAt('/content?view=queue');
    expect(await screen.findByRole('link', { name: 'Analizi yapabilecek bağlı ajan yok; dosyalar bir ajan bağlanana kadar sırada bekler.' }, { timeout: 5000 })).toHaveAttribute('href', '/agents');
    expect(screen.getByText('Bağlı ajan yok · ajan bağlanınca sırayla analiz edilecek')).toBeVisible();
    expect(screen.getByText('Dosyalanmalı')).toBeVisible();
    // The page's own line stays away from the queue, which says it once.
    expect(screen.queryByText(/ajanı bekliyor/)).not.toBeInTheDocument();
    expect(screen.getByText('Analiz olmadı')).toBeVisible();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Olayı seçin · Dosya q2/ }), 'o1');
    await userEvent.click(screen.getByRole('button', { name: 'Dosyala' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/studio/materials/q2/bind')?.body).toEqual({ expected_revision: 2, binding: { kind: 'olay', olay_id: 'o1' } }));
  });
});

describe('an olay', () => {
  it('shows a proposed olay with its confirmation, files and Eksikler', async () => {
    const proposed = { ...o1, status: 'proposed', confirmed: null };
    const calls = contentPageFetch({
      'GET /api/content/tree': tree({ olays: [{ ...folder({ waits: ['olay_proposed'] }), olay: proposed }] as never }),
      'GET /api/content/olays/o1': view({
        olay: proposed as never,
        files: [
          { material: material('m1', { title: 'Kupa ön' }), intelligence: intelligence(), used_in: [] },
          { material: material('m2', { title: 'Kupa yan' }), intelligence: intelligence({ status: 'pending' }), used_in: [] },
        ] as never,
        needs: [{ kind: 'shoot_request', id: 'r1', text: 'Kutudan çıkış anı', status: 'open', created_at: '2026-10-02T09:00:00Z', resolved_at: null, project_id: null, project_title: null, material_ids: [], asked_by: null }],
      }),
      'POST /api/studio/olays/o1/confirm': { ...o1 },
      'POST /api/studio/shoot-requests/r1/resolve': {},
    });
    renderAt('/content?olay=o1');
    expect(await screen.findByText('Ajan bu olayı önerdi')).toBeVisible();
    const files = screen.getByRole('region', { name: 'Dosyalar' });
    // The file waiting for its analysis is said once beside the heading, leading to the queue.
    expect(within(files).getByRole('link', { name: '1 analiz bekliyor' })).toHaveAttribute('href', '/content?view=queue');
    expect(screen.getByRole('link', { name: /Kupa ön/ })).toHaveAttribute('href', '/content?olay=o1&file=m1');
    const needs = screen.getByRole('region', { name: 'Eksikler' });
    await userEvent.click(within(needs).getByRole('button', { name: 'Gerek yok' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/studio/shoot-requests/r1/resolve')?.body).toEqual({ status: 'dismissed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Onayla' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/studio/olays/o1/confirm')).toBe(true));
  });

  it('opens a new content in the olay it was opened from', async () => {
    const calls = contentPageFetch({
      'GET /api/content/tree': tree({ olays: [{ ...folder(), olay: o1 }] as never }),
      'GET /api/content/olays/o1': view({ olay: o1 as never }),
      'POST /api/studio/projects': { id: 'n1' },
      'GET /api/studio/projects/n1': detail(),
    });
    renderAt('/content?olay=o1');
    await userEvent.click(await screen.findByRole('button', { name: 'Yeni içerik' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Yeni içerik · Yılbaşı' })).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText('Hedef'), 'Kupaları tanıt');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yeni içerik' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/studio/projects')?.body).toMatchObject({ brief: 'Kupaları tanıt', olay_id: 'o1' }));
  });

  it('tolerates an olay given by its identity only', async () => {
    const bare = { id: 'o1', kind: 'workshop', title: 'Yılbaşı', starts_on: o1.starts_on, ends_on: o1.ends_on, status: 'confirmed' };
    contentPageFetch({
      'GET /api/content/tree': tree({ olays: [{ ...folder(), olay: bare }] as never }),
      'GET /api/content/olays/o1': view({ olay: bare as never, files: null }),
    }, meWith(['content.work']));
    renderAt('/content?olay=o1');
    expect(await screen.findByRole('heading', { name: /Yılbaşı/ })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Dosyalar' })).not.toBeInTheDocument();
  });
});

describe('permissions and modules', () => {
  it('shows files and the queue without contents to a library worker', async () => {
    const calls = contentPageFetch({ 'GET /api/content/olays/genel': view({ contents: null, files: [] }) }, meWith(['materials.work']));
    renderAt('/content');
    expect(await screen.findByText('İçerikleri görme izniniz yok')).toBeVisible();
    expect(screen.getByRole('link', { name: /Analiz sırası/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dosya yükle' })).toBeVisible();
    expect(calls.some((c) => c.path === '/api/content/areas')).toBe(false);
  });

  it('shows contents without uploads or the queue to a content worker', async () => {
    const calls = contentPageFetch({}, meWith(['content.work']));
    renderAt('/content');
    expect(await screen.findByText('Henüz içerik yok')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Analiz sırası/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dosya yükle' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/content/analysis-queue')).toBe(false);
  });

  it('refuses a member with neither permission without reading', async () => {
    const calls = contentPageFetch({}, meWith([]));
    renderAt('/content');
    expect(await screen.findByRole('alert')).toHaveTextContent('Bu işlem için yetkiniz yok');
    expect(calls.some((c) => c.path.startsWith('/api/content/'))).toBe(false);
  });

  it('keeps the library on the page when the content module is off', async () => {
    const modules = { ...legacyModules, modules: legacyModules.modules.map((m) => (m.blueprint.id === 'content' ? { ...m, installed: false } : m)) };
    const calls = contentPageFetch({ 'GET /api/workspace/modules': modules });
    renderAt('/content');
    expect(await screen.findByText('İçerik üretimi bu çalışma alanında açık değil')).toBeVisible();
    expect(screen.getByRole('link', { name: /Analiz sırası/ })).toBeVisible();
    expect(calls.some((c) => c.path === '/api/content/areas')).toBe(false);
  });

  it('offers the content module when neither module is installed', async () => {
    contentPageFetch({ 'GET /api/workspace/modules': coreModules });
    renderAt('/content');
    expect(await screen.findByRole('link', { name: 'Modülü incele' })).toHaveAttribute('href', '/modules/content');
  });
});

describe('addresses', () => {
  it.each([
    ['/materials', '/content', ''],
    ['/materials?view=olays&olay=o1', '/content', '?olay=o1'],
    ['/materials?view=olays&olay=genel&material=m1', '/content', '?olay=genel&file=m1'],
    ['/materials?view=library&material=m1', '/content', '?file=m1'],
    ['/materials?view=olays&olay=review', '/content', ''],
    ['/content?area=p1', '/content', '?content=p1'],
    ['/content?tab=calendar', '/content', '?settings=1'],
  ])('sends %s to the content page', async (from, path, search) => {
    contentPageFetch();
    const { router } = renderAt(from);
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(`${path}${search}`));
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('opens the special days and rules behind the gear', async () => {
    contentPageFetch({ 'GET /api/studio/calendar': { year: 2026, entries: [], rows: [], policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: true } } });
    const { router } = renderAt('/content');
    await userEvent.click(await screen.findByRole('button', { name: 'Özel günler ve kurallar' }));
    expect(router.state.location.search).toBe('?settings=1');
    expect(await screen.findByTestId('materials-calendar')).toBeVisible();
  });
});

describe('a cancelled post on the content page', () => {
  const cancelled = { by: 'u1', at: '2026-11-19T10:05:00Z', reason: 'Aynı görseller', slot_id: 's1' };
  const versions = [
    { id: 'v1', format: 'feed_post', capability_id: null, title: null, material_ids: [], slot_id: 's1', cancelled },
    { id: 'v2', format: 'story', capability_id: null, title: null, material_ids: [], slot_id: 's2' },
  ];
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const k = row('k', {
    area: { status: { state: 'done', step: 14, note: null, starts_at: '2026-10-01T09:00:00Z' } },
    stages: stages({
      hazirlik: 'done', fikir: 'done', metin: 'done', gorsel: 'done',
      paket: { state: 'done', package: { revision: 1, delivered_at: '2026-11-01T10:00:00Z', summary: 's', released: false, versions } as never },
      onay: 'done',
      yayin: { state: 'current', publications: [
        { version_id: 'v1', slot_id: 's1', capability_id: 'c1', account_name: '@figurunica', state: 'retired', scheduled_at: later, published_at: null, url: null, failed: false, retirement: 'cancelled' },
        { version_id: 'v2', slot_id: 's2', capability_id: 'c1', account_name: '@figurunica', state: 'ready', scheduled_at: later, published_at: null, url: null, failed: false },
      ] },
    }),
  });
  const contentPost = (slot_id: string, patch: Record<string, unknown> = {}) => ({ slot_id, format: 'story', capability_id: 'c1', account_name: '@figurunica', scheduled_at: later, state: 'ready', published: false, withdrawn_by_redo: true, ...patch });

  it('says where the cancelled version stopped and why, and offers the same cancel for the one still to go', async () => {
    const slot = (await import('@/test/studio')).studioAnswers['GET /api/studio/slots/s1'] as Record<string, unknown>;
    const calls = contentPageFetch({
      'GET /api/content/areas': { areas: [k], next_cursor: null, next_done_before: null },
      'GET /api/studio/projects/k': detail({ ...(await import('@/test/content')).area('k'), packages: [{ ...pack, versions: [
        { ...version, id: 'v1', slot_id: 's1', cancelled }, { ...version, id: 'v2', format: 'story', slot_id: 's2' },
      ] }] } as never),
      'GET /api/studio/slots/s2': { ...slot, slot: { ...(slot.slot as object), id: 's2', state: 'ready', revision: 7 },
        content: { project_id: 'k', title: 'İçerik k', package_revision: 1, current: true, redo: null, posts: [contentPost('s1', { state: 'retired', withdrawn_by_redo: false, format: 'feed_post' }), contentPost('s2')], cancel_archives: true } },
      'POST /api/studio/slots/s2/cancel': slot,
    });
    renderAt('/content');
    const article = await screen.findByRole('article', { name: 'İçerik k' });
    // Quietly on the track: the cancelled one with its reason, the other planned.
    expect(within(article).getAllByText('@figurunica · iptal edildi: “Aynı görseller”').length).toBeGreaterThan(0);
    await userEvent.click(within(article).getByRole('button', { name: /İçerik k/ }));
    const steps = await within(article).findByRole('list', { name: 'Üretim adımları' });
    expect(within(steps).getByText('iptal edildi: “Aynı görseller”')).toBeVisible();
    await userEvent.click(await within(steps).findByRole('button', { name: 'İptal et' }));
    const form = within(steps).getByRole('form', { name: 'İptal et' });
    expect(form).toHaveTextContent('içerik de arşive kalkar');
    await userEvent.type(within(form).getByLabelText('Neden iptal ediyorsunuz?'), 'Bu da olmasın');
    await userEvent.click(within(form).getByRole('button', { name: 'Paylaşımı iptal et' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/studio/slots/s2/cancel', body: { expected_revision: 7, reason: 'Bu da olmasın' } }));
  });
});

describe('a post that waits for the owner', () => {
  const publication = (slot: string, account: string) => ({ version_id: slot, slot_id: slot, capability_id: 'c', account_name: account, state: 'ready' as const, scheduled_at: '2026-11-24T16:00:00Z', published_at: null, url: null, failed: false });
  const waiting = (slot: string, screen: boolean) => ({ version_id: slot, slot_id: slot, required: true, posting_screen: screen, waiting: true, approved_by: null, approved_at: null });

  it('leads a TikTok post to its posting screen with the social page’s words, never to a plain approval', async () => {
    contentPageFetch({ 'GET /api/content/areas': { areas: [row('t', { stages: stages({
      onay: { state: 'waiting_person', approvals: [waiting('s1', true)] },
      yayin: { state: 'todo', publications: [publication('s1', 'figurunica tiktok')] },
    }) })], next_cursor: null, next_done_before: null } });
    renderAt('/content');
    const article = await screen.findByRole('article', { name: 'İçerik t' });
    const finish = within(article).getByRole('link', { name: /^TikTok paylaşımını tamamla · figurunica tiktok/ });
    expect(finish).toHaveAttribute('href', '/social?tiktok=s1');
    expect(within(article).queryByRole('link', { name: /^Onayla/ })).not.toBeInTheDocument();
    expect(within(article).getAllByText('TikTok’ta tamamlanacak').length).toBeGreaterThan(0);
  });

  it('keeps "Onayla" for a post whose account asks for an approval', async () => {
    contentPageFetch({ 'GET /api/content/areas': { areas: [row('i', { stages: stages({
      onay: { state: 'waiting_person', approvals: [waiting('s2', false)] },
      yayin: { state: 'todo', publications: [publication('s2', 'figurunica')] },
    }) })], next_cursor: null, next_done_before: null } });
    renderAt('/content');
    const article = await screen.findByRole('article', { name: 'İçerik i' });
    expect(within(article).getByRole('link', { name: /^Onayla · figurunica/ })).toHaveAttribute('href', '/social?slot=s2');
  });
});
