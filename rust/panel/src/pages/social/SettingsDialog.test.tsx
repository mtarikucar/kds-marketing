import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { repMe } from '@/test/materials';
import { defaultSettings, postsAnswers } from '@/test/posts';
import { socialAnswers, socialSettings } from '@/test/social';

const answers = { ...socialAnswers, 'GET /api/studio/posts': { posts: [], settings: socialSettings } };
const open = () => renderAt('/social?settings=1');
const dialog = () => screen.findByRole('dialog', { name: 'Paylaşım ayarları' });
/** Opens the edit of the rule whose sentence starts with `start`. */
async function edit(start: string) {
  const d = await dialog();
  await userEvent.click(await within(d).findByRole('button', { name: new RegExp(`^Değiştir: ${start}`) }));
  return within(d).getByRole('form');
}
const sent = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === 'PUT');

describe('Paylaşım ayarları as sentences', () => {
  it('states the rules in words, the rare ones folded under Gelişmiş', async () => {
    mockFetch(answers);
    open();
    const d = await dialog();
    expect(await within(d).findByText('Günde en çok 2 gönderi, aralarında en az 3 saat')).toBeVisible();
    expect(within(d).getByText('Günde en çok 25 hikâye, aralarında en az 10 dakika')).toBeVisible();
    expect(within(d).getByText('Günde en çok 3 TikTok videosu')).toBeVisible();
    expect(within(d).getByText('00:00–08:00 arasında paylaşım yapılmaz')).toBeVisible();
    expect(within(d).getByText('Saat dilimi: Europe/Istanbul')).toBeVisible();
    expect(within(d).queryByText(/^Reels: 48 saat önce/)).not.toBeInTheDocument();
    await userEvent.click(within(d).getByRole('button', { name: 'Gelişmiş' }));
    expect(within(d).getByText('Reels: 48 saat önce hazırlanmaya başlar, en çok 6 saat gecikebilir')).toBeVisible();
    expect(within(d).getByText('Bir kanalda 4 gün gönderi olmazsa tek bir genel paylaşım istenir')).toBeVisible();
    expect(within(d).getByText('Materyal eklemek bittikten 30 dakika sonra plan istenir')).toBeVisible();
    expect(within(d).getByText('En çok 30 gün ilerisi planlanır')).toBeVisible();
    expect(within(d).getByRole('switch', { name: 'Platformun kendi zamanlayıcısını kullan' })).not.toBeChecked();
  });

  it('saves one sentence’s values into the whole settings read again, in minutes', async () => {
    const calls = mockFetch({ ...answers, 'PUT /api/studio/posting-policy': { ...socialSettings, feed_cap: undefined, revision: 8, policy: { ...socialSettings.policy, feed_cap: { per_day: 3, spacing_minutes: 150 } } } });
    open();
    const form = await edit('Günde en çok 2 gönderi');
    const spacing = within(form).getByLabelText('Gönderiler arası en az (saat)');
    expect(spacing).toHaveValue('3');
    await userEvent.clear(within(form).getByLabelText('Günlük gönderi sınırı (kanal başına)'));
    await userEvent.type(within(form).getByLabelText('Günlük gönderi sınırı (kanal başına)'), '3');
    await userEvent.clear(spacing);
    await userEvent.type(spacing, '2,5');
    const reads = calls.filter((c) => c.path === '/api/studio/posts').length;
    await userEvent.click(within(form).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(sent(calls)).toHaveLength(1));
    // Read again just before the write.
    expect(calls.filter((c) => c.path === '/api/studio/posts').length).toBeGreaterThan(reads);
    expect(sent(calls)[0].path).toBe('/api/studio/posting-policy');
    expect(sent(calls)[0].body).toEqual({
      tz: 'Europe/Istanbul',
      provider_scheduling: false,
      policy: { ...defaultSettings.policy, feed_cap: { per_day: 3, spacing_minutes: 150 } },
    });
    expect(await within(await dialog()).findByText('Günde en çok 3 gönderi, aralarında en az 2,5 saat')).toBeVisible();
  });

  it.each([
    ['00:00–08:00', 'Sessiz saatler bitişi', '25'],
    ['Günde en çok 2 gönderi', 'Gönderiler arası en az (saat)', '25'],
    ['Günde en çok 25 hikâye', 'Hikâyeler arası en az (dakika)', '1,5'],
  ])('refuses an out-of-range value of “%s” before sending', async (rule, label, value) => {
    const calls = mockFetch(answers);
    open();
    const form = await edit(rule);
    await userEvent.clear(within(form).getByLabelText(label));
    await userEvent.type(within(form).getByLabelText(label), value);
    await userEvent.click(within(form).getByRole('button', { name: 'Kaydet' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/saatler 0–23/);
    expect(sent(calls)).toHaveLength(0);
  });

  it('refuses a horizon shorter than a format’s lead', async () => {
    const calls = mockFetch(answers);
    open();
    await userEvent.click(await within(await dialog()).findByRole('button', { name: 'Gelişmiş' }));
    const form = await edit('En çok 30 gün');
    await userEvent.clear(within(form).getByLabelText('Planlama ufku (gün)'));
    await userEvent.type(within(form).getByLabelText('Planlama ufku (gün)'), '1');
    await userEvent.click(within(form).getByRole('button', { name: 'Kaydet' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('hazırlık süresinden kısa olamaz');
    expect(sent(calls)).toHaveLength(0);
  });

  it('sends nothing when the settings changed meanwhile, and shows them as they are now', async () => {
    const routes: Record<string, unknown> = { ...answers };
    const calls = mockFetch(routes);
    open();
    const form = await edit('Günde en çok 3 TikTok');
    // Someone else saved meanwhile: the next read has a newer revision and another cap.
    routes['GET /api/studio/posts'] = { posts: [], settings: { ...socialSettings, revision: 9, policy: { ...socialSettings.policy, tiktok_video_cap: { per_day: 5, spacing_minutes: 0 } } } };
    await userEvent.clear(within(form).getByLabelText('Günlük TikTok videosu sınırı'));
    await userEvent.type(within(form).getByLabelText('Günlük TikTok videosu sınırı'), '4');
    await userEvent.click(within(form).getByRole('button', { name: 'Kaydet' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Ayarlar bu arada değişti');
    expect(sent(calls)).toHaveLength(0);
    expect(within(await dialog()).getByText('Günde en çok 5 TikTok videosu')).toBeVisible();
  });

  it('says when the zone is not one the server knows', async () => {
    mockFetch({ ...answers, 'PUT /api/studio/posting-policy': withStatus(422, { code: 'VALIDATION', message: 'an IANA time zone', details: { field: 'tz' } }) });
    open();
    const form = await edit('Saat dilimi');
    await userEvent.clear(within(form).getByLabelText('Saat dilimi'));
    await userEvent.type(within(form).getByLabelText('Saat dilimi'), 'Mars/Olympus');
    await userEvent.click(within(form).getByRole('button', { name: 'Kaydet' }));
    expect(await within(form).findByText('Saat dilimi tanınmadı (ör. Europe/Istanbul).')).toBeVisible();
  });

  it('changes a format’s lead and grace on its own', async () => {
    const calls = mockFetch({ ...answers, 'PUT /api/studio/posting-policy': socialSettings });
    open();
    await userEvent.click(await within(await dialog()).findByRole('button', { name: 'Gelişmiş' }));
    const form = await edit('Reels: 48 saat');
    const lead = within(form).getByLabelText('Reels · Hazırlık (saat önce)');
    expect(lead).toHaveValue('48');
    await userEvent.clear(lead);
    await userEvent.type(lead, '36');
    await userEvent.click(within(form).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(sent(calls)[0]?.body).toEqual({
      tz: 'Europe/Istanbul', provider_scheduling: false,
      policy: { ...defaultSettings.policy, lead_minutes: { ...defaultSettings.policy.lead_minutes, reel: 2160 } },
    }));
  });

  it('saves the platform scheduler choice on its own', async () => {
    const calls = mockFetch({ ...answers, 'PUT /api/studio/posting-policy': { ...socialSettings, provider_scheduling: true } });
    open();
    await userEvent.click(await within(await dialog()).findByRole('button', { name: 'Gelişmiş' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Platformun kendi zamanlayıcısını kullan' }));
    await waitFor(() => expect((sent(calls)[0]?.body as { provider_scheduling?: boolean })?.provider_scheduling).toBe(true));
    expect(await screen.findByText(/paylaşım, saatinden önce platformun kendi zamanlayıcısına bırakılır/)).toBeVisible();
  });

  it('a member who is no owner or manager reads them only', async () => {
    mockFetch({ ...postsAnswers, ...socialAnswers, 'GET /api/studio/posts': { posts: [], settings: socialSettings }, 'GET /api/auth/me': { ...repMe, memberships: [{ ...repMe.memberships[0], permissions: [...repMe.memberships[0].permissions, 'social.work'] }] } });
    open();
    const d = await dialog();
    expect(await within(d).findByText('Günde en çok 2 gönderi, aralarında en az 3 saat')).toBeVisible();
    expect(within(d).queryByRole('button', { name: /^Değiştir/ })).not.toBeInTheDocument();
    expect(within(d).getByText('Bu ayarları yalnız sahip veya yönetici değiştirir.')).toBeVisible();
  });

  it('closes back to the page, out of the address', async () => {
    mockFetch(answers);
    const { router } = open();
    await dialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});
