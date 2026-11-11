import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { materialsAnswers, repMe } from '@/test/materials';

// Takvim (spec §4.4, D12): the year's effective calendar; the lunar holidays, mezuniyet and kulüp
// sezon başı have no dates until the owner enters them.

const entry = (key: string, name: string, w: [string, string] | null, patch: Record<string, unknown> = {}) => ({
  key,
  year: 2027,
  name,
  kind: 'special_day',
  window_start: w?.[0] ?? null,
  window_end: w?.[1] ?? null,
  lead_days: null,
  enabled: true,
  ...patch,
});
const calendar = {
  year: 2027,
  entries: [
    entry('yilbasi', 'Yılbaşı', ['2027-12-01', '2027-12-31'], { kind: 'season' }),
    entry('anneler_gunu', 'Anneler Günü', ['2027-04-25', '2027-05-09'], { lead_days: 30 }),
    entry('ramazan_bayrami', 'Ramazan Bayramı', null),
    entry('kurban_bayrami', 'Kurban Bayramı', null),
    entry('mezuniyet', 'Mezuniyet', null, { kind: 'season' }),
    entry('kulup_sezon_basi', 'Kulüp sezon başı', null, { kind: 'season' }),
  ],
  rows: [entry('anneler_gunu', 'Anneler Günü', ['2027-04-25', '2027-05-09'], { lead_days: 30 })],
  policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: true },
};
const answers = { ...materialsAnswers, 'GET /api/studio/calendar': calendar };
const open = () => renderAt('/content?tab=calendar&year=2027');

describe('Materyaller · Takvim', () => {
  it('shows "tarih girilmeli" for the undated lunar holidays and the dated windows', async () => {
    const calls = mockFetch(answers);
    open();
    for (const key of ['ramazan_bayrami', 'kurban_bayrami', 'mezuniyet', 'kulup_sezon_basi']) {
      expect(within(await screen.findByTestId(`calendar-${key}`)).getByText('Tarih girilmeli')).toBeInTheDocument();
    }
    const yilbasi = screen.getByTestId('calendar-yilbasi');
    expect(within(yilbasi).queryByText('Tarih girilmeli')).not.toBeInTheDocument();
    expect(within(yilbasi).getByText('21 gün önceden hazırlık (varsayılan)')).toBeInTheDocument();
    const anneler = screen.getByTestId('calendar-anneler_gunu');
    expect(within(anneler).getByText('30 gün önceden hazırlık')).toBeInTheDocument();
    expect(within(anneler).getByText('Düzenlendi')).toBeInTheDocument();
    expect(screen.getByText(/2027 için 4 günün tarihi girilmedi/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/studio/calendar')?.search).toBe('?year=2027');
  });

  it("enters a lunar holiday's dates as the year's row", async () => {
    const calls = mockFetch({
      ...answers,
      'PUT /api/studio/calendar/ramazan_bayrami/2027': entry('ramazan_bayrami', 'Ramazan Bayramı', [
        '2027-02-25',
        '2027-03-11',
      ]),
    });
    open();
    const row = await screen.findByTestId('calendar-ramazan_bayrami');
    await userEvent.click(within(row).getByRole('button', { name: 'Tarihleri gir' }));
    await userEvent.type(within(row).getByLabelText('Pencere başlangıcı'), '2027-02-25');
    await userEvent.type(within(row).getByLabelText('Pencere bitişi'), '2027-03-11');
    await userEvent.click(within(row).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        name: 'Ramazan Bayramı',
        kind: 'special_day',
        window_start: '2027-02-25',
        window_end: '2027-03-11',
        lead_days: null,
        enabled: true,
      }),
    );
  });

  it('refuses a window with one date before sending it', async () => {
    const calls = mockFetch(answers);
    open();
    const row = await screen.findByTestId('calendar-mezuniyet');
    await userEvent.click(within(row).getByRole('button', { name: 'Tarihleri gir' }));
    await userEvent.type(within(row).getByLabelText('Pencere başlangıcı'), '2027-06-10');
    await userEvent.click(within(row).getByRole('button', { name: 'Kaydet' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('iki tarihini de girin');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('saves the materials policy', async () => {
    const calls = mockFetch({
      ...answers,
      'PUT /api/studio/materials/policy': { lead_days: 28, reuse_days: 14, recap_days: 30, ai_standalone: false },
    });
    open();
    const lead = await screen.findByLabelText(/^Hazırlık \(gün\)/, { selector: 'input[inputmode]:not([placeholder])' });
    await userEvent.clear(lead);
    await userEvent.type(lead, '28');
    // On unless the workspace turned it off; the form sends it with the days.
    const standalone = screen.getByRole('checkbox', { name: /Ajanın ürettiği görsel tek başına paylaşılabilsin/ });
    expect(standalone).toBeChecked();
    await userEvent.click(standalone);
    await userEvent.click(screen.getByRole('button', { name: 'Kuralları kaydet' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/studio/materials/policy')?.body).toEqual({
        lead_days: 28,
        reuse_days: 14,
        recap_days: 30,
        ai_standalone: false,
      }),
    );
  });

  it('is read-only for a member who is no owner or manager', async () => {
    mockFetch({ ...answers, 'GET /api/auth/me': repMe });
    open();
    await screen.findByTestId('calendar-ramazan_bayrami');
    expect(screen.queryByRole('button', { name: 'Tarihleri gir' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kuralları kaydet' })).not.toBeInTheDocument();
  });
});
