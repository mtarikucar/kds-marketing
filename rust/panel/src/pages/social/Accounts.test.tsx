import { expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { accountDetail, socialAccount, socialAnswers, socialSettings } from '@/test/social';

it('shows an account empty state leading to Connect', async () => {
  mockFetch({ ...socialAnswers, 'GET /api/social/accounts': [] });
  renderAt('/social');
  expect(await screen.findByText('Henüz bağlı sosyal hesabın yok.')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Hesap bağla' })).toHaveAttribute('href', '/connect');
});
it('shows account metrics, change, gaps and scheduled and published posts', async () => {
  mockFetch(socialAnswers);
  renderAt('/social');
  await userEvent.click(await screen.findByRole('button', { name: /@atolye · Instagram/ }));
  const detail = await screen.findByRole('region', { name: 'Instagram · @atolye' });
  expect(within(detail).getByTestId('metric-followers')).toHaveTextContent('1.250');
  expect(within(detail).getByTestId('metric-followers')).toHaveTextContent('+50');
  expect(within(detail).getByTestId('metric-views')).toHaveTextContent('—');
  expect(within(detail).getByText('Platformda zamanlandı')).toBeVisible();
  expect(within(detail).getByText('Jeeta yayınlayacak')).toBeVisible();
  expect(within(detail).getByRole('link', { name: 'Dünkü buluşma' })).toHaveAttribute('href', 'https://www.instagram.com/p/example');
  expect(within(detail).getByTestId('recent-done')).toHaveTextContent('Görüntülenme: —');
  expect(within(detail).getByTestId('recent-done')).toHaveTextContent('Etkileşim: 0');
  expect(within(detail).getByRole('img', { name: /Takipçi eğilimi/ }).querySelectorAll('polyline')).toHaveLength(2);
});
it('requests the selected period and offers a way back to the account list', async () => {
  const calls = mockFetch(socialAnswers);
  const { router } = renderAt('/social');
  await userEvent.click(await screen.findByRole('button', { name: /@atolye · Instagram/ }));
  await userEvent.click(await screen.findByRole('button', { name: '90 gün' }));
  await waitFor(() => {
    const query = new URLSearchParams(calls.filter(c => c.path === '/api/social/accounts/ig1').at(-1)?.search);
    expect((Date.parse(query.get('until')!) - Date.parse(query.get('from')!)) / 86400000).toBe(89);
  });
  await userEvent.click(screen.getByRole('button', { name: 'Hesaplara dön' }));
  expect(router.state.location.search).not.toContain('account=');
});
it('pauses and resumes with the latest revision and updates both account marks', async () => {
  const pausedSettings = { ...socialSettings, paused_capability_ids: ['ig1', 'tt1'], revision: 8 };
  const routes: Record<string, unknown> = { ...socialAnswers, 'POST /api/social/accounts/ig1/pause': pausedSettings };
  const calls = mockFetch(routes);
  renderAt('/social?tab=settings');
  await userEvent.click(await screen.findByRole('switch', { name: '@atolye · Paylaşımı duraklat' }));
  await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ paused: true, expected_revision: 7 }));
  expect(await screen.findByRole('switch', { name: '@atolye · Paylaşımı sürdür' })).toBeChecked();
  routes['GET /api/studio/posts'] = { posts: [], settings: pausedSettings };
  await userEvent.click(screen.getByRole('tab', { name: 'Hesaplar' }));
  await userEvent.click(await screen.findByRole('button', { name: /@atolye · Instagram · Duraklatıldı/ }));
  expect(await screen.findByRole('region', { name: 'Instagram · @atolye' })).toHaveTextContent('Duraklatıldı');
  await userEvent.click(screen.getByRole('tab', { name: 'Ayarlar' }));
  await userEvent.click(await screen.findByRole('switch', { name: '@atolye · Paylaşımı sürdür' }));
  await waitFor(() => expect(calls.filter(c => c.method === 'POST').at(-1)?.body).toEqual({ paused: false, expected_revision: 8 }));
});
it('lists waiting package versions read-only', async () => {
  const calls = mockFetch(socialAnswers);
  renderAt('/social?tab=packages');
  expect(await screen.findByText('Birlikte üretelim.')).toBeVisible();
  expect(screen.getByText('Ajan bu sürümler için zaman seçecek.')).toBeVisible();
  expect(screen.getByText('Atölyeyi tanıt')).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(calls.some(c => c.method !== 'GET')).toBe(false);
});
it.each(['?tab=posts', '?tab=plan', '?slot=ordinary'])('opens accounts for the old link %s', async query => {
  mockFetch({ ...socialAnswers, 'GET /api/studio/pending': { slots: [], approvals: [], blockers: [], budget_moves: [], paid_alerts: [] } });
  renderAt(`/social${query}`);
  expect(await screen.findByRole('tab', { name: 'Hesaplar' })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByRole('button', { name: /@atolye · Instagram/ })).toBeVisible();
  expect(screen.queryByTestId('slot-detail')).not.toBeInTheDocument();
});
it.each(['?slot=s1', '?tiktok=s1'])('opens the retained TikTok posting form for %s', async query => {
  mockFetch(socialAnswers);
  renderAt(`/social${query}`);
  expect(await screen.findByRole('form', { name: "TikTok'ta paylaş" })).toBeVisible();
});
it('links a waiting TikTok post to its posting screen and shows absent metrics as missing', async () => {
  mockFetch(socialAnswers);
  renderAt('/social?account=tt1');
  const detail = await screen.findByRole('region', { name: 'TikTok · @atolye.video' });
  expect(await within(detail).findByTestId('metric-followers')).toHaveTextContent('—');
  expect(within(detail).getByRole('link', { name: /Senden bekleniyor/ })).toHaveAttribute('href', '/social?tiktok=s1');
});
it('warns about posts the platform holds that Jeeta did not leave there, and only about those', async () => {
  mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, at_platform: [
    { external_id: 'p1', publish_at: '2026-11-13T11:00:00Z', title: 'Elle zamanlanmış', known: false },
    { external_id: 'p2', publish_at: '2026-11-12T10:45:00Z', title: 'Sistemin kendi gönderisi', known: true },
  ] } });
  renderAt('/social?account=ig1');
  const strays = await screen.findByRole('region', { name: 'Platformda zamanlanmış, Jeeta’nın bilmediği gönderiler' });
  expect(within(strays).getByText(/Elle zamanlanmış/)).toBeVisible();
  expect(within(strays).queryByText(/Sistemin kendi gönderisi/)).not.toBeInTheDocument();
});
it('says nothing about the platform’s scheduler when it holds only Jeeta’s own posts or cannot be read', async () => {
  mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, at_platform: [{ external_id: 'p2', publish_at: '2026-11-12T10:45:00Z', title: 'Sistemin kendi gönderisi', known: true }] } });
  renderAt('/social?account=ig1');
  await screen.findByRole('region', { name: 'Sıradaki paylaşımlar' });
  expect(screen.queryByRole('region', { name: 'Platformda zamanlanmış, Jeeta’nın bilmediği gönderiler' })).not.toBeInTheDocument();
});
it('does not fabricate a change when the starting observation is absent', async () => {
  mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, days: [{ ...socialAccount.latest, followers: null }, socialAccount.latest] } });
  renderAt('/social?account=ig1');
  expect(await screen.findByTestId('metric-followers')).toHaveTextContent('Değişim: —');
});
it('offers retry for a failed account read without calling it empty', async () => {
  mockFetch({ ...socialAnswers, 'GET /api/social/accounts': withStatus(503, { code: 'INTERNAL', message: 'down', details: {} }) });
  renderAt('/social');
  expect(await screen.findByRole('button', { name: 'Yeniden dene' })).toBeVisible();
  expect(screen.queryByText('Henüz bağlı sosyal hesabın yok.')).not.toBeInTheDocument();
});

it('keeps the account unchanged after a refused pause and reads the revision again', async () => {
  const calls = mockFetch({ ...socialAnswers, 'POST /api/social/accounts/ig1/pause': withStatus(409, { code: 'CONFLICT', message: 'stale revision', details: {} }) });
  renderAt('/social?tab=settings');
  const toggle = await screen.findByRole('switch', { name: '@atolye · Paylaşımı duraklat' });
  await waitFor(() => expect(toggle).toBeEnabled());
  await userEvent.click(toggle);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(toggle).not.toBeChecked();
  await waitFor(() => expect(calls.filter(call => call.path === '/api/studio/posts').length).toBeGreaterThan(1));
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
});
it('lets a social worker read accounts but does not offer account pause', async () => {
  const me = socialAnswers['GET /api/auth/me'];
  const calls = mockFetch({ ...socialAnswers, 'GET /api/auth/me': { ...me, memberships: [{ ...me.memberships[0], permissions: ['social.work'] }] } });
  renderAt('/social?tab=settings');
  await screen.findByTestId('posting-settings');
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(calls.some(call => call.method === 'POST')).toBe(false);
});
it('leaves a gap for an omitted calendar day as well as a null observation', async () => {
  mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, days: accountDetail.days.filter(day => day.day !== '2026-11-08') } });
  renderAt('/social?account=ig1');
  const chart = await screen.findByRole('img', { name: 'Takipçi eğilimi' });
  expect(chart.querySelectorAll('polyline')).toHaveLength(2);
  expect(chart.querySelectorAll('circle')).toHaveLength(4);
});
it('opens a post that waits for the connection approval and approves its revision', async () => {
  const approval = { slot_id: 's1', publish_at: '2026-11-12T09:00:00Z', format: 'feed_post', title: 'Atölyeden', state: 'waiting_person', waits_for: 'approval', held_at_provider: false };
  const calls = mockFetch({
    ...socialAnswers,
    'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [approval, { ...approval, slot_id: 'h1', title: 'Bekleyen', state: 'held', waits_for: null }] },
    'GET /api/studio/pending': { slots: [], approvals: [{ slot: 's1' }], blockers: [{ target: { slot: 's1' }, reason: 'human_approval_required' }], budget_moves: [], paid_alerts: [] },
    'POST /api/studio/approvals': {},
  });
  renderAt('/social?account=ig1');
  const detail = await screen.findByRole('region', { name: 'Instagram · @atolye' });
  // A post the checks hold says so; it is neither "scheduled" nor "waiting for you".
  expect(await within(detail).findByText('Tutuluyor')).toBeVisible();
  await userEvent.click(within(detail).getByRole('link', { name: 'Onayını bekliyor' }));
  const view = await screen.findByRole('region', { name: 'Onay bekleyen paylaşım' });
  expect(await within(view).findByText('Örnek içerik')).toBeVisible();
  await userEvent.click(within(view).getByRole('button', { name: 'Onayla' }));
  await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ target: { slot: 's1' }, expected_revision: 1 }));
  expect(await within(view).findByRole('status')).toHaveTextContent('Onaylandı');
});
it('saves the platform scheduler choice with the posting settings', async () => {
  const calls = mockFetch({ ...socialAnswers, 'PUT /api/studio/posting-policy': { ...socialSettings, provider_scheduling: true } });
  renderAt('/social?tab=settings');
  await userEvent.click(await screen.findByRole('button', { name: 'Takvim ve saat' }));
  const box = await screen.findByRole('checkbox', { name: /Platformun kendi zamanlayıcısını kullan/ });
  expect(box).not.toBeChecked();
  await userEvent.click(box);
  await userEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  await waitFor(() => expect((calls.find(c => c.method === 'PUT')?.body as { provider_scheduling?: boolean }).provider_scheduling).toBe(true));
});

it('shows a published post that has no planned post behind it without a format line', async () => {
  mockFetch({
    ...socialAnswers,
    'GET /api/social/accounts/ig1': {
      ...accountDetail,
      recent: [{ ...accountDetail.recent[0], slot_id: 'older', format: null, title: 'Eski paylaşım' }],
    },
  });
  renderAt('/social?account=ig1');
  const row = await screen.findByTestId('recent-older');
  expect(row).toHaveTextContent('Eski paylaşım');
  expect(row).not.toHaveTextContent('null');
  expect(row).not.toHaveTextContent('posts.format');
});

it('says why no account can take a waiting version', async () => {
  const packages = socialAnswers['GET /api/social/packages'];
  mockFetch({
    ...socialAnswers,
    'GET /api/social/packages': [
      { ...packages[0], versions: [{ ...packages[0].versions[0], accounts: [], blocked: 'hypothesis_does_not_post' }] },
    ],
  });
  renderAt('/social?tab=packages');
  expect(await screen.findByText(/hipotezi stratejide paylaşım yapmıyor/)).toBeVisible();
  expect(screen.queryByText('Uygun hesap henüz yok.')).not.toBeInTheDocument();
});
