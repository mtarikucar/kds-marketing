import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { repMe } from '@/test/materials';
import { defaultSettings, postsAnswers } from '@/test/posts';
const open = (_view: string) => renderAt('/social?tab=settings');

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
      // The platform's scheduler stays as it was: off.
      provider_scheduling: false,
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
