import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { repMe } from '@/test/materials';
import {
  HYPOTHESIS,
  X_CHANNEL,
  defaultSettings,
  postOut,
  postRequest,
  postsAnswers,
  weekSummary,
} from '@/test/posts';

// The Paylaşımlar tab of Growth Studio (spec 2026-11-03 §14): what the agent is asked to plan,
// what is planned, a week's summary and the posting settings, an owner's or manager's.

const open = (view = 'plan', extra = '') => renderAt(`/studio?tab=posts&view=${view}${extra}`);

describe('Paylaşımlar · Plan', () => {
  it("lists the agent's open requests and the live posts by publish time, with where each stands", async () => {
    mockFetch({
      ...postsAnswers,
      'GET /api/studio/post-requests': [
        postRequest('q1'),
        postRequest('q2', {
          trigger: 'floor',
          capability_id: X_CHANNEL,
          material_ids: ['m9'],
          best_formats: [{ format: 'feed_post', mean: null, posts: 0 }],
        }),
      ],
      'GET /api/studio/posts': {
        settings: defaultSettings,
        posts: [
          postOut('late', '2026-10-26T07:00:00Z'),
          postOut('ready', '2026-10-24T07:00:00Z', { state: 'ready', pending: true }),
          postOut('soon', '2026-10-25T07:00:00Z', { pending: true }),
          postOut('gone', '2026-10-23T07:00:00Z', {
            state: 'retired',
            retired: { reason: 'missed_grace', at: '2026-10-23T13:00:00Z' },
          }),
        ],
      },
    });
    open();
    const q1 = await screen.findByTestId('request-q1');
    expect(within(q1).getByText('Yeni olay materyalleri')).toBeInTheDocument();
    expect(within(q1).getByText('3 materyal')).toBeInTheDocument();
    expect(within(q1).getByText('Önerilen biçim: Reels')).toBeInTheDocument();
    const q2 = screen.getByTestId('request-q2');
    expect(within(q2).getByText('Uzun süredir gönderi yok')).toBeInTheDocument();
    expect(await within(q2).findByText('Tek gönderi: Jeeta X')).toBeInTheDocument();
    // Live posts only, the earliest first; a retired one is the summary's.
    const planned = screen.getByRole('region', { name: 'Planlanan paylaşımlar' });
    await waitFor(() =>
      expect(within(planned).getAllByRole('listitem').map((li) => li.dataset.testid)).toEqual([
        'post-ready',
        'post-soon',
        'post-late',
      ]),
    );
    expect(within(screen.getByTestId('post-ready')).getByText('Hazır')).toBeInTheDocument();
    expect(within(screen.getByTestId('post-soon')).getByText('Hazırlanıyor')).toBeInTheDocument();
    const late = screen.getByTestId('post-late');
    expect(within(late).getByText('Hazırlık başlamadı')).toBeInTheDocument();
    expect(within(late).getByText(/^Hazırlık: /)).toBeInTheDocument();
    expect(within(late).getByText('Gönderi')).toBeInTheDocument();
    expect(within(late).getByText('Jeeta X')).toBeInTheDocument();
    expect(screen.getByText('Saatler Europe/Istanbul saat dilimine göredir.')).toBeInTheDocument();
  });

  it('says what happens when nothing is asked or planned', async () => {
    mockFetch(postsAnswers);
    open();
    expect(await screen.findByText('Bekleyen istek yok.')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Planlanmış paylaşım yok. Materyal yükledikçe Studio ajandan plan ister.',
      ),
    ).toBeInTheDocument();
  });

  it('opens a planned post in Studio', async () => {
    mockFetch({
      ...postsAnswers,
      'GET /api/studio/posts': { settings: defaultSettings, posts: [postOut('s9', '2026-10-24T07:00:00Z')] },
    });
    const { router } = open();
    await userEvent.click(
      await within(await screen.findByTestId('post-s9')).findByRole('button', { name: "Studio'da aç" }),
    );
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});

describe('Paylaşımlar · Haftalık özet', () => {
  it("shows a week's published, planned and unpublished posts with why, and what worked", async () => {
    mockFetch({
      ...postsAnswers,
      // Only what the page reads outside the Studio tab: the hypotheses' titles.
      'GET /api/studio/overview': {
        hypotheses: [{ id: HYPOTHESIS, title: 'Atölye anları' }],
        slots: [],
        learned: { arms: [] },
      },
    });
    open('week');
    const published = await screen.findByRole('region', { name: 'Yayınlananlar' });
    expect(within(published).getByText('Gönderi')).toBeInTheDocument();
    expect(within(published).getByRole('link', { name: 'Gönderiyi aç' })).toHaveAttribute(
      'href',
      'https://x.com/jeeta/status/1',
    );
    const planned = screen.getByRole('region', { name: 'Planlananlar' });
    expect(within(planned).getByText('Kaydırmalı gönderi')).toBeInTheDocument();
    expect(within(planned).getByText('Hazır')).toBeInTheDocument();
    const cancelled = screen.getByRole('region', { name: 'Yayınlanmayanlar' });
    expect(within(cancelled).getByText('Zamanında hazırlanamadı')).toBeInTheDocument();
    expect(within(cancelled).getByText('Yeni planlamaya geçildi')).toBeInTheDocument();
    expect(within(cancelled).getByText('Eski haftalık plan')).toBeInTheDocument();
    const scores = screen.getByRole('region', { name: 'Ne işe yarıyor' });
    const row = within(scores).getAllByRole('row')[1];
    expect(within(row).getByText('Reels')).toBeInTheDocument();
    expect(within(row).getByText('Atölye')).toBeInTheDocument();
    expect(await within(row).findByText('Atölye anları')).toBeInTheDocument();
    expect(within(row).getByText(/%25/)).toBeInTheDocument();
  });

  it('walks to the previous and next weeks by their Mondays', async () => {
    const calls = mockFetch(postsAnswers);
    const { router } = open('week');
    await screen.findByRole('region', { name: 'Yayınlananlar' });
    await userEvent.click(screen.getByRole('button', { name: 'Önceki hafta' }));
    await waitFor(() => expect(router.state.location.search).toContain('week=2026-10-12'));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/studio/summary' && c.search === '?week=2026-10-12')).toBe(
        true,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Bu hafta' }));
    await waitFor(() => expect(router.state.location.search).not.toContain('week='));
    await userEvent.click(screen.getByRole('button', { name: 'Sonraki hafta' }));
    await waitFor(() => expect(router.state.location.search).toContain('week=2026-10-26'));
  });

  it('says when nothing was measured yet', async () => {
    mockFetch({ ...postsAnswers, 'GET /api/studio/summary': { ...weekSummary, scores: [] } });
    open('week');
    expect(await screen.findByText('Henüz ölçülmüş paylaşım yok.')).toBeInTheDocument();
  });
});

describe('Paylaşımlar · Paylaşım ayarları', () => {
  it.each([
    ['Format süreleri', 'Reels · Hazırlık (saat önce)', '-1'],
    ['Günlük sınırlar', 'Gönderiler arası en az (saat)', '25'],
  ])('reveals an invalid field in %s even after leaving that group', async (group, label, value) => {
    const calls = mockFetch(postsAnswers);
    const user = userEvent.setup();
    open('settings');
    const form = await screen.findByTestId('posting-settings');
    await user.click(within(form).getByRole('button', { name: group }));
    const field = within(form).getByLabelText(label);
    await user.clear(field);
    await user.type(field, value);
    await user.click(within(form).getByRole('button', { name: 'Takvim ve saat' }));
    expect(field).not.toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Ayarları kaydet' }));
    expect(await within(form).findByRole('alert')).toBeVisible();
    expect(field).toBeVisible();
    expect(within(form).getByRole('button', { name: group })).toHaveAttribute('aria-pressed', 'true');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('an owner reads the policy in hours and saves it in minutes', async () => {
    const calls = mockFetch({
      ...postsAnswers,
      'PUT /api/studio/posting-policy': { ...defaultSettings, tz: 'Europe/Berlin' },
    });
    open('settings');
    const form = await screen.findByTestId('posting-settings');
    const lead = within(form).getByLabelText('Reels · Hazırlık (saat önce)');
    expect(lead).toHaveValue('48');
    await userEvent.clear(lead);
    await userEvent.type(lead, '36');
    await userEvent.click(within(form).getByRole('button', { name: 'Günlük sınırlar' }));
    expect(lead).not.toBeVisible();
    const spacing = within(form).getByLabelText('Gönderiler arası en az (saat)');
    expect(spacing).toHaveValue('3');
    await userEvent.clear(spacing);
    await userEvent.type(spacing, '2,5');
    await userEvent.click(within(form).getByRole('button', { name: 'Takvim ve saat' }));
    const tz = within(form).getByLabelText('Saat dilimi');
    await userEvent.clear(tz);
    await userEvent.type(tz, 'Europe/Berlin');
    await userEvent.click(within(form).getByRole('button', { name: 'Format süreleri' }));
    expect(lead).toBeVisible();
    expect(lead).toHaveValue('36');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.click(within(form).getByRole('button', { name: 'Ayarları kaydet' }));
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('Kaydedildi.'));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/studio/posting-policy');
    expect(put?.body).toEqual({
      tz: 'Europe/Berlin',
      policy: {
        ...defaultSettings.policy,
        lead_minutes: { ...defaultSettings.policy.lead_minutes, reel: 2160 },
        feed_cap: { per_day: 2, spacing_minutes: 150 },
      },
    });
  });

  it('refuses a value out of range before sending, and says when the zone is not one', async () => {
    const calls = mockFetch({
      ...postsAnswers,
      'PUT /api/studio/posting-policy': withStatus(422, {
        code: 'VALIDATION',
        message: 'an IANA time zone, e.g. Europe/Istanbul',
        details: { field: 'tz' },
      }),
    });
    open('settings');
    const form = await screen.findByTestId('posting-settings');
    await userEvent.click(within(form).getByRole('button', { name: 'Takvim ve saat' }));
    const quiet = within(form).getByLabelText('Sessiz saatler bitişi');
    await userEvent.clear(quiet);
    await userEvent.type(quiet, '25');
    await userEvent.click(within(form).getByRole('button', { name: 'Format süreleri' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Ayarları kaydet' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/saatler 0–23/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(quiet).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Takvim ve saat' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.clear(quiet);
    await userEvent.type(quiet, '8');
    const tz = within(form).getByLabelText('Saat dilimi');
    await userEvent.clear(tz);
    await userEvent.type(tz, 'Mars/Olympus');
    await userEvent.click(within(form).getByRole('button', { name: 'Günlük sınırlar' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Ayarları kaydet' }));
    expect(await within(form).findByText('Saat dilimi tanınmadı (ör. Europe/Istanbul).')).toBeInTheDocument();
    expect(tz).toBeVisible();
  });

  it('a member who is no owner or manager reads them only', async () => {
    mockFetch({ ...postsAnswers, 'GET /api/auth/me': repMe });
    open('settings');
    const form = await screen.findByTestId('posting-settings');
    expect(within(form).getByLabelText('Reels · Hazırlık (saat önce)')).toBeDisabled();
    await userEvent.click(within(form).getByRole('button', { name: 'Günlük sınırlar' }));
    expect(within(form).getByLabelText('Gönderiler arası en az (saat)')).toBeDisabled();
    await userEvent.click(within(form).getByRole('button', { name: 'Takvim ve saat' }));
    expect(within(form).getByLabelText('Saat dilimi')).toBeDisabled();
    expect(within(form).queryByRole('button', { name: 'Ayarları kaydet' })).toBeNull();
    expect(
      within(form).getByText('Bu ayarları yalnız sahip veya yönetici değiştirir.'),
    ).toBeInTheDocument();
  });
});
