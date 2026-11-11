import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { dayFrom, materialsAnswers, shoot } from '@/test/materials';

// Çekim listesi (spec §4.6, D11): this week's open requests first, then the older ones; "yapıldı"
// and "gerek yok" resolve one request each; a person adds requests of their own.

const thisWeek = shoot('r1', { text: 'Yılbaşı figürlerinin vitrin fotoğrafı', reason: { kind: 'season_ahead', occasion: 'yilbasi', year: 2026 } });
const older = shoot('r2', { text: 'Kulüp siparişinin teslim videosu', week_start: dayFrom(-21) });
const dates = shoot('r3', {
  text: 'Ramazan Bayramı 2027 tarihlerini takvime gir.',
  reason: { kind: 'season_dates_missing', occasion: 'ramazan_bayrami', year: 2027 },
  week_start: dayFrom(-14),
});
const answers = { ...materialsAnswers, 'GET /api/studio/shoot-requests': [older, thisWeek, dates] };
const open = () => renderAt('/materials?view=shoots');

describe('Materyaller · Çekim listesi', () => {
  it("lists this week's open requests first, then the older ones", async () => {
    mockFetch(answers);
    open();
    const week = await screen.findByRole('region', { name: 'Bu hafta' });
    expect(await within(week).findByText('Yılbaşı figürlerinin vitrin fotoğrafı')).toBeInTheDocument();
    expect(within(week).getByText(/Sezon yaklaşıyor/)).toBeInTheDocument();
    const earlier = screen.getByRole('region', { name: 'Önceki haftalar' });
    const texts = within(earlier)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('p')?.textContent);
    expect(texts).toEqual(['Ramazan Bayramı 2027 tarihlerini takvime gir.', 'Kulüp siparişinin teslim videosu']);
  });

  it('"yapıldı" and "gerek yok" resolve their own request', async () => {
    const calls = mockFetch({
      ...answers,
      'POST /api/studio/shoot-requests/r1/resolve': delayed(300, { ...thisWeek, status: 'done' }),
      'POST /api/studio/shoot-requests/r2/resolve': { ...older, status: 'dismissed' },
    });
    open();
    const r1 = await screen.findByTestId('shoot-r1');
    const r2 = screen.getByTestId('shoot-r2');
    await userEvent.click(within(r1).getByRole('button', { name: 'Yapıldı' }));
    // One request's pending state never holds another's.
    expect(within(r1).getByRole('button', { name: 'Gerek yok' })).toBeDisabled();
    expect(within(r2).getByRole('button', { name: 'Gerek yok' })).toBeEnabled();
    await userEvent.click(within(r2).getByRole('button', { name: 'Gerek yok' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]),
      ).toEqual([
        ['/api/studio/shoot-requests/r1/resolve', { status: 'done' }],
        ['/api/studio/shoot-requests/r2/resolve', { status: 'dismissed' }],
      ]),
    );
  });

  it('adds a request once, even on a second click while it is sent', async () => {
    const calls = mockFetch({
      ...answers,
      'POST /api/studio/shoot-requests': delayed(300, shoot('r9', { text: 'Atölye masası' })),
    });
    open();
    const box = await screen.findByLabelText('Çekim listesine ekle');
    await userEvent.type(box, 'Atölye masası');
    await userEvent.click(screen.getByRole('button', { name: 'Listeye ekle' }));
    await userEvent.click(screen.getByRole('button', { name: 'Listeye ekle' }));
    await waitFor(() => expect(box).toHaveValue(''));
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/api/studio/shoot-requests');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ text: 'Atölye masası' });
    expect((posts[0].body as { request_key: string }).request_key).toMatch(/[0-9a-f-]{36}/);
  });

  it('leads a missing-dates request to its calendar year', async () => {
    mockFetch({ ...answers, 'GET /api/studio/calendar': { year: 2027, entries: [], rows: [], policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: true } } });
    const { router } = open();
    await userEvent.click(await within(await screen.findByTestId('shoot-r3')).findByRole('button', { name: 'Takvime git' }));
    await screen.findByTestId('materials-calendar');
    expect(router.state.location.search).toContain('year=2027');
  });
});
