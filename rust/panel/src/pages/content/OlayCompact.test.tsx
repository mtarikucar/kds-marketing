import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAt } from '@/test/render';
import { contentPageFetch, folder, intelligence, material, olay, row, stages, tree, view } from '@/test/contentPage';
import { dayFrom } from '@/test/materials';

// The olay's page kept compact (2026-11-19): no counter strip, the sections in dense lines.

const o1 = olay('o1', { title: 'Daily', starts_on: dayFrom(-2), ends_on: dayFrom(5) });
const withTree = { 'GET /api/content/tree': tree({ olays: [{ ...folder(), olay: o1 }] as never }) };
const file = (id: string, title: string, m: Record<string, unknown> = {}, i: Record<string, unknown> = {}) =>
  ({ material: material(id, { title, ...m }), intelligence: intelligence(i), used_in: [] });
const need = (id: string, text: string) =>
  ({ kind: 'shoot_request', id, text, status: 'open', created_at: '2026-11-18T09:00:00Z', resolved_at: null, project_id: null, project_title: null, material_ids: [], asked_by: null });
const strip = () => [
  screen.queryByRole('list', { name: 'Olayın akışı' }),
  screen.queryByText('Zaman bekleyen'),
  screen.queryByText('Onay bekleyen'),
  screen.queryByText(/Analiz · \d+ sırada/),
];

describe('the counter strip', () => {
  it('is gone from an olay, Genel and Tüm üretim', async () => {
    const waiting = row('w', { stages: stages({ hazirlik: 'done', fikir: 'done', metin: 'done', gorsel: 'done', paket: 'done', onay: 'waiting_person' }) });
    contentPageFetch({
      ...withTree,
      'GET /api/content/olays/o1': view({ olay: o1 as never, contents: [waiting], files: [file('m1', 'Kupa', {}, { status: 'pending' })] as never }),
      'GET /api/content/olays/genel': view({ contents: [waiting] }),
      'GET /api/content/areas': { areas: [waiting], next_cursor: null, next_done_before: null },
    });
    const { router } = renderAt('/content?olay=o1');
    await screen.findByRole('article', { name: 'İçerik w' });
    expect(strip().every((x) => x === null)).toBe(true);
    await router.navigate('/content?olay=genel');
    await screen.findByRole('heading', { name: /Genel/ });
    await screen.findByRole('article', { name: 'İçerik w' });
    expect(strip().every((x) => x === null)).toBe(true);
    await router.navigate('/content');
    await screen.findByRole('article', { name: 'İçerik w' });
    expect(strip().every((x) => x === null)).toBe(true);
  });
});

describe('Dosyalar', () => {
  it('says nothing of the analysis when no file waits for it', async () => {
    contentPageFetch({ ...withTree, 'GET /api/content/olays/o1': view({ olay: o1 as never, files: [file('m1', 'Kupa')] as never }) });
    renderAt('/content?olay=o1');
    const files = await screen.findByRole('region', { name: 'Dosyalar' });
    expect(within(files).queryByText(/analiz bekliyor/)).not.toBeInTheDocument();
    expect(within(files).queryByRole('link', { name: /Analiz sırası/ })).not.toBeInTheDocument();
  });

  it('marks only what needs looking at; a healthy shareable file shows no badge', async () => {
    contentPageFetch({
      ...withTree,
      'GET /api/content/olays/o1': view({
        olay: o1 as never,
        files: [
          file('ok', 'Kupa ön'),
          file('wait', 'Yeni kare', {}, { status: 'pending' }),
          file('perm', 'İzinsiz', { share: null }),
          file('bad', 'Bulanık', { tags: { product_groups: [], doors: [], content_types: [], quality: 'unusable', depicts: [] } }),
          file('no', 'Paylaşılmaz', { share: { permission: 'not_shareable', by: 'u1', at: '2026-10-02T09:00:00Z' } }),
        ] as never,
      }),
    });
    renderAt('/content?olay=o1');
    const files = await screen.findByRole('region', { name: 'Dosyalar' });
    expect(within(files).getByRole('link', { name: /^Kupa ön/ })).not.toHaveTextContent(/Paylaşılabilir|bekleniyor|izni/);
    expect(within(files).getByRole('link', { name: /^Yeni kare/ })).toHaveTextContent('Ajan analizi bekleniyor');
    expect(within(files).getByRole('link', { name: /^İzinsiz/ })).toHaveTextContent('Paylaşım izni yok');
    expect(within(files).getByRole('link', { name: /^Bulanık/ })).toHaveTextContent('Kullanılamaz');
    expect(within(files).getByRole('link', { name: /^Paylaşılmaz/ })).toHaveTextContent('Paylaşılamaz');
    // The list keeps the marks, and says where a file is used.
    await userEvent.click(within(files).getByRole('button', { name: 'Liste' }));
    expect(within(files).getByRole('link', { name: /^Yeni kare/ })).toHaveTextContent('Ajan analizi bekleniyor');
  });

  it('folds the erased files into one line that opens', async () => {
    contentPageFetch({
      ...withTree,
      'GET /api/content/olays/o1': view({
        olay: o1 as never,
        files: [file('a', 'Kupa ön'), file('b', 'Kupa yan'), file('x1', 'Eski kare', { erased_at: '2026-11-01T09:00:00Z' }), file('x2', 'Eski kare 2', { erased_at: '2026-11-01T09:00:00Z' })] as never,
      }),
    });
    renderAt('/content?olay=o1');
    const files = await screen.findByRole('region', { name: 'Dosyalar' });
    expect(within(files).getByText('2', { selector: 'span.font-mono' })).toBeInTheDocument();
    expect(within(files).getAllByRole('link')).toHaveLength(2);
    const fold = within(files).getByRole('button', { name: /2 silinmiş dosya/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(within(files).getByRole('link', { name: /Eski kare 2/ })).toHaveTextContent('Silindi');
  });
});

describe('Eksikler', () => {
  it('shows three and folds the rest behind one line', async () => {
    const needs = ['Bir', 'İki', 'Üç', 'Dört', 'Beş'].map((text, i) => need(`r${i}`, text));
    contentPageFetch({ ...withTree, 'GET /api/content/olays/o1': view({ olay: o1 as never, needs: needs as never }) });
    renderAt('/content?olay=o1');
    const section = await screen.findByRole('region', { name: 'Eksikler' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(3);
    expect(within(section).queryByText('Dört')).not.toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: '2 tane daha göster' }));
    expect(within(section).getAllByRole('listitem')).toHaveLength(5);
    expect(within(section).getByText('Beş')).toBeVisible();
  });

  it('folds nothing at three, and shows all when a link comes for them', async () => {
    const three = ['Bir', 'İki', 'Üç'].map((text, i) => need(`r${i}`, text));
    contentPageFetch({ ...withTree, 'GET /api/content/olays/o1': view({ olay: o1 as never, needs: three as never }) });
    renderAt('/content?olay=o1');
    const section = await screen.findByRole('region', { name: 'Eksikler' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(3);
    expect(within(section).queryByRole('button', { name: /daha göster/ })).not.toBeInTheDocument();
  });

  it('opens every one when "Eksiklere git" leads there', async () => {
    const five = ['Bir', 'İki', 'Üç', 'Dört', 'Beş'].map((text, i) => need(`r${i}`, text));
    contentPageFetch({ ...withTree, 'GET /api/content/olays/o1': view({ olay: o1 as never, needs: five as never }) });
    renderAt('/content?olay=o1#eksikler');
    const section = await screen.findByRole('region', { name: 'Eksikler' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(5);
  });
});
