import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { renderAt } from '@/test/render';
import { contentPageFetch, folder, olay, queueItem, row, stages, tree, view } from '@/test/contentPage';
import { area, detail } from '@/test/content';
import { dayFrom } from '@/test/materials';
import { groupTree } from './ContentTree';
import { analysisAgentLine } from './QueueView';
import { noteBeyondOutput } from './AreaDetail';

// The chain from upload to result, where the page used to leave a person uninformed.

const done = stages({
  hazirlik: 'done', fikir: 'done', metin: 'done', gorsel: 'done',
  paket: { state: 'done', package: { revision: 1, delivered_at: '2026-11-18T10:00:00Z', summary: 's', released: false, versions: [{ id: 'v1', format: 'reel', capability_id: null, title: null, material_ids: [], slot_id: null }] } },
  onay: 'current',
});
const stagesOf = (el: HTMLElement) => within(within(el).getByRole('list', { name: 'Üretim aşamaları' })).getAllByRole('listitem');

describe('a finished package with no time', () => {
  it('says the package is ready, who gives the time, and links to where a person gives it', async () => {
    contentPageFetch({
      'GET /api/content/areas': {
        areas: [row('t', { area: { status: { state: 'done', step: 14, note: null, starts_at: '2026-11-01T09:00:00Z' } }, stages: done, unscheduled: [{ version_id: 'v1', format: 'reel', capability_id: null, accounts: ['ig1'] }] })],
        next_cursor: null, next_done_before: null,
      },
      'GET /api/content/tree': tree({ genel: folder({ areas: 1, waits: ['content_time'] }), areas: 1, waiting: { olay_confirmations: 0, shoot_requests: 0, content_approvals: 0, content_times: 1, problem_contents: 0 } }),
    });
    renderAt('/content');
    const t = await screen.findByRole('article', { name: 'İçerik t' });
    expect(within(stagesOf(t)[5]).getByText('Paket hazır · paylaşım zamanı bekliyor', { selector: 'span' })).toBeInTheDocument();
    expect(within(t).getByText(/Ajan bir sonraki çalışmasında her sürüme hesap ve saat verecek/)).toBeVisible();
    expect(within(t).getByRole('link', { name: 'Zamanı siz verin' })).toHaveAttribute('href', '/social?version=v1');
    // "Sizi bekleyenler" counts it, and leads to its folder.
    const strip = screen.getAllByRole('region', { name: 'Sizi bekleyenler' })[0];
    expect(within(strip).getByRole('link', { name: /1 içerik zaman bekliyor/ })).toHaveAttribute('href', '/content?olay=genel');
  });

  it('shows a version no account can take as a problem with its reason', async () => {
    contentPageFetch({
      'GET /api/content/areas': {
        areas: [row('x', {
          area: { status: { state: 'done', step: 14, note: null, starts_at: '2026-11-01T09:00:00Z' } },
          stages: stages({ ...Object.fromEntries(done.slice(0, 5).map((s) => [s.key, s])), onay: 'current', yayin: 'problem' }),
          unscheduled: [{ version_id: 'v1', format: 'reel', capability_id: null, accounts: [], blocked: 'account_paused' }],
        })],
        next_cursor: null, next_done_before: null,
      },
    });
    renderAt('/content');
    const x = await screen.findByRole('article', { name: 'İçerik x' });
    expect(stagesOf(x)[6].querySelector('p')?.textContent).toBe('Yayın: sorun var');
    expect(within(stagesOf(x)[6]).getByText('Reels hiçbir hesaba gidemiyor')).toBeInTheDocument();
    expect(within(x).getByText('Hazır sürüm hiçbir hesaba gidemiyor')).toBeVisible();
    expect(within(x).getByText(/Uygun hesapların paylaşımı durdurulmuş/)).toBeVisible();
    expect(within(x).getByRole('link', { name: 'Sosyal medyada çöz' })).toHaveAttribute('href', '/social?version=v1');
    expect(within(x).queryByText('Takıldı')).not.toBeInTheDocument();
  });

  it('counts the contents waiting for a time in the olay flow', async () => {
    const o = olay('o1', { title: 'Kasım', starts_on: dayFrom(-2), ends_on: dayFrom(2) });
    contentPageFetch({
      'GET /api/content/tree': tree({ olays: [{ ...folder(), olay: o }] as never }),
      'GET /api/content/olays/o1': view({ olay: o as never, flow: { files: 1, analysed: 1, in_queue: 0, contents: 1, in_production: 0, awaiting_time: 1, awaiting_approval: 0, published: 0, problems: 0 } }),
    });
    renderAt('/content?olay=o1');
    const flow = await screen.findByRole('list', { name: 'Olayın akışı' });
    expect(within(flow).getByText('Zaman bekleyen').previousSibling).toHaveTextContent('1');
  });
});

describe('after the package', () => {
  const posted = (p: Record<string, unknown>) => row('p', {
    area: { status: { state: 'done', step: 14, note: null, starts_at: '2026-11-01T09:00:00Z' } },
    stages: stages({
      ...Object.fromEntries(done.slice(0, 5).map((s) => [s.key, s])),
      onay: 'done',
      yayin: { state: 'current', publications: [{ version_id: 'v1', slot_id: 's1', capability_id: 'c1', account_name: '@figurunica', state: 'ready', scheduled_at: '2030-01-01T10:00:00Z', published_at: null, url: null, failed: false, ...p }] },
    }),
  });

  it('says a post taken back is taken back, and one whose time came is being sent', async () => {
    contentPageFetch({ 'GET /api/content/areas': { areas: [posted({ state: 'retired', retirement: 'cancelled' })], next_cursor: null, next_done_before: null } });
    renderAt('/content');
    const p = await screen.findByRole('article', { name: 'İçerik p' });
    expect(within(stagesOf(p)[6]).getByText('@figurunica · geri alındı')).toBeInTheDocument();
    expect(within(p).queryByText(/planlandı/)).not.toBeInTheDocument();
  });

  it('says a ready post past its time is being sent, not planned', async () => {
    contentPageFetch({ 'GET /api/content/areas': { areas: [posted({ scheduled_at: '2026-01-01T10:00:00Z' })], next_cursor: null, next_done_before: null } });
    renderAt('/content');
    const p = await screen.findByRole('article', { name: 'İçerik p' });
    expect(within(stagesOf(p)[6]).getByText('@figurunica · zamanı geldi, gönderiliyor')).toBeInTheDocument();
  });
});

describe('a step', () => {
  it('shows its note only when it says more than its output', () => {
    expect(noteBeyondOutput({ note: 'Elle boyanır', output: 'Elle boyanır ' })).toBeNull();
    expect(noteBeyondOutput({ note: '  ', output: 'x' })).toBeNull();
    expect(noteBeyondOutput({ note: 'Neden: el işi öne çıksın', output: 'Elle boyanır' })).toBe('Neden: el işi öne çıksın');
    expect(noteBeyondOutput({ note: 'Amaç yazıldı' })).toBe('Amaç yazıldı');
  });

  it('prints a sentence reported as both output and note once', async () => {
    const r = row('s', {
      current_step: 6,
      stages: stages({ hazirlik: 'done', fikir: { state: 'current', steps: [{ step: 6, note: 'Bir figür, bir hatıra', at: '2026-11-18T09:00:00Z', output: 'Bir figür, bir hatıra' }, { step: 5, note: 'Üç fikirden biri seçildi', at: '2026-11-18T08:00:00Z', output: 'Hatıra figürü' }] } }),
    });
    contentPageFetch({
      'GET /api/content/areas': { areas: [r], next_cursor: null, next_done_before: null },
      'GET /api/studio/projects/s': detail(area('s'), []),
    });
    renderAt('/content?content=s');
    const s = await screen.findByRole('article', { name: 'İçerik s' });
    const steps = await within(s).findByRole('list', { name: 'Üretim adımları' });
    expect(within(steps).getAllByText('Bir figür, bir hatıra')).toHaveLength(1);
    expect(within(steps).getByText('Hatıra figürü')).toHaveClass('font-medium');
    expect(within(steps).getByText('Üç fikirden biri seçildi')).toHaveClass('text-xs');
  });
});

describe('the analysis queue', () => {
  const t = i18n.t.bind(i18n);
  const agents = [{ api_key_id: 'k1', last_seen_at: '2026-11-19T09:00:00Z' }, { api_key_id: 'k2', last_seen_at: '2026-11-19T11:00:00Z' }];

  it('says when an agent that can analyse was seen and is next expected, or that it is late', () => {
    const at = Date.parse('2026-11-19T09:30:00Z');
    const able = [{ id: 'k1', status: 'active' as const, scopes: ['materials.work' as const] }, { id: 'k2', status: 'active' as const, scopes: ['content.work' as const] }];
    expect(analysisAgentLine(t, 'tr', agents, able, 60, at)).toMatch(/en son .* geldi; bir sonraki gelişi .* civarında bekleniyor/);
    expect(analysisAgentLine(t, 'tr', agents, able, 15, at)).toMatch(/gelmesi gerekiyordu, gecikti/);
    // No time is made up: with no interval, the sighting only; with no able agent, none.
    expect(analysisAgentLine(t, 'tr', agents, able, undefined, at)).not.toMatch(/bekleniyor|gecikti/);
    expect(analysisAgentLine(t, 'tr', agents, [{ id: 'k2', status: 'active', scopes: ['content.work'] }], 60, at)).toBe('Analizi yapabilecek bağlı ajan yok; dosyalar bir ajan bağlanana kadar sırada bekler.');
  });

  it('says an upload nobody could place waits for a folder or deletion, and deletes it from its row', async () => {
    const calls = contentPageFetch({
      'GET /api/content/analysis-queue': { items: [queueItem('q2', 'needs_filing')] },
      'POST /api/studio/materials/q2/delete': {},
    });
    renderAt('/content?view=queue');
    expect(await screen.findByText('Ajan bu dosyayı bir olaya yerleştiremedi. Bir klasör seçin ya da dosyayı silin.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Dosyayı sil' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getAllByRole('button').find((b) => b.textContent && !/vazgeç|iptal|kapat/i.test(b.textContent) && b.className.includes('danger'))!);
    await waitFor(() => expect(calls.find((c) => c.path === '/api/studio/materials/q2/delete')?.body).toEqual({ expected_revision: 2, confirm: true }));
  });
});

describe('a special day with no olay', () => {
  const open = { key: 'ogretmenler_gunu', year: 2026, name: 'Öğretmenler Günü', kind: 'special_day', window_start: dayFrom(-9), window_end: dayFrom(5), prepares_from: dayFrom(-30), phase: 'open', shoot_request_id: 'r1' };
  const ahead = { key: 'yilbasi', year: 2026, name: 'Yılbaşı', kind: 'season', window_start: dayFrom(12), window_end: dayFrom(42), prepares_from: dayFrom(-9), phase: 'preparing', shoot_request_id: null };

  it('sits under Şimdi once its window started, not under Yaklaşan', () => {
    const g = groupTree(tree({ upcoming: [open, ahead] as never }));
    expect(g.nowDays.map((d) => d.key)).toEqual(['ogretmenler_gunu']);
    expect(g.soon.map((s) => (s.kind === 'day' ? s.day.key : s.item.olay.id))).toEqual(['yilbasi']);
  });

  it('says the system does not open its olay and names the capture it asked for', async () => {
    contentPageFetch({ 'GET /api/content/tree': tree({ upcoming: [open] as never }) });
    renderAt('/content?day=ogretmenler_gunu%3A2026');
    expect(await screen.findByText('Dönemi başladı, olayı yok')).toBeVisible();
    expect(screen.getByText(/Sistem olayı kendisi açmaz/)).toBeVisible();
    expect(screen.queryByText(/kendisi açar/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /çekim listesine bu gün için bir istek ekledi/ })).toHaveAttribute('href', '/content?olay=genel#eksikler');
    const nav = screen.getByRole('navigation', { name: 'Olaylar' });
    expect(within(nav).getByRole('link', { name: /Öğretmenler Günü/ })).toHaveTextContent('olayı yok');
  });
});

