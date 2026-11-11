import { expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { adsAnswers, campaign } from '@/test/ads';

it('leads with the campaign queue, its budget and results; legacy controls are secondary', async () => {
  mockFetch(adsAnswers);
  renderAt('/ads');
  expect(await screen.findByRole('link', { name: campaign.title })).toHaveAttribute(
    'href',
    '/ads?campaign=campaign-1',
  );
  expect(screen.getByText('41 form')).toBeVisible();
  expect(screen.getByRole('progressbar', { name: 'Harcanan / bütçe' })).toHaveAttribute('max', '500000');
  expect(screen.getByRole('button', { name: 'Reklam kampanyası aç' })).toBeVisible();
  expect(screen.queryByText('Reklam seti bağla')).not.toBeInTheDocument();
});

it('renders provider markup only in an opaque sandbox, with placement selection', async () => {
  const calls = mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1/ads/0/preview': {
      html: '<iframe src="https://example.com/preview"></iframe>',
    },
  });
  renderAt('/ads?campaign=campaign-1');
  const preview = await screen.findByTitle('Mavi kupa');
  expect(preview).toHaveAttribute('sandbox', 'allow-scripts');
  expect(preview).toHaveAttribute('srcdoc', '<iframe src="https://example.com/preview"></iframe>');
  await userEvent.selectOptions(screen.getByLabelText('Yerleşim'), 'instagram_story');
  await waitFor(() => expect(calls.some((c) => c.search === '?placement=instagram_story')).toBe(true));
  expect(screen.getByText(campaign.plan.audience_summary)).toBeVisible();
  expect(screen.getByText(campaign.moves[0].reason)).toBeVisible();
});

it('requires a reason to decline a proposal and sends the revision', async () => {
  const proposed = { ...campaign, state: { state: 'proposed', note: null }, built: null };
  const calls = mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': { campaign: proposed, days: [], materials: [] },
    'POST /api/ads/campaigns/campaign-1/decline': {
      ...proposed,
      revision: 5,
      state: { state: 'declined', note: null },
    },
  });
  renderAt('/ads?campaign=campaign-1');
  await userEvent.click(await screen.findByRole('button', { name: 'Reddet' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Reddet' })).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Neden'), 'Bu hafta uygun değil');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Reddet' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      expected_revision: 4,
      reason: 'Bu hafta uygun değil',
    }),
  );
});

it('uses a neutral preview when the provider is unavailable', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1/ads/0/preview': withStatus(503, {
      code: 'INTERNAL',
      message: 'offline',
    }),
  });
  renderAt('/ads?campaign=campaign-1');
  expect(await screen.findByText('El yapımı kupalar')).toBeVisible();
  expect(screen.getByText('Yeni seri')).toBeVisible();
  expect(screen.getByText('Daha fazla bilgi')).toBeVisible();
});

import { fireEvent } from '@testing-library/react';
import { formatMoney } from '@/lib/format';
import { generalBudget } from '@/test/ads';

async function fillOpening() {
  await userEvent.click(await screen.findByRole('button', { name: 'Reklam kampanyası aç' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Hedef', { exact: false }), 'Yeni müşterilere ulaş');
  await userEvent.type(
    within(dialog).getByLabelText('Reklam kampanyası bütçesi', { exact: false }),
    '1.250,50',
  );
  fireEvent.change(within(dialog).getByLabelText('Başlama saati', { exact: false }), {
    target: { value: '2026-12-01T09:00' },
  });
  return dialog;
}
it('opens with required goal, minor-unit budget and local start converted to RFC3339', async () => {
  const calls = mockFetch({ ...adsAnswers, 'POST /api/ads/campaigns': campaign });
  renderAt('/ads');
  const dialog = await fillOpening();
  expect(
    within(dialog).getByText(
      // What the open campaign has not spent yet is held, so it is not free for another.
      `Genel reklam bütçesinde kalan: ${formatMoney(
        generalBudget.remaining - (campaign.budget_minor - campaign.totals.spent_minor),
        'TRY',
        'tr',
      )}`,
    ),
  ).toBeVisible();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Reklam kampanyası aç' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      request_key: expect.any(String),
      goal: 'Yeni müşterilere ulaş',
      budget_minor: 125050,
      start_at: new Date('2026-12-01T09:00').toISOString(),
    }),
  );
  expect(await screen.findByRole('heading', { name: campaign.title })).toBeVisible();
});

// The refusals as `jt_app::usecases::ads` gives them: `CONFLICT` with `details.reason`, and
// what is left under the limit in `details.left`.
it.each([
  ['no_general_ad_budget', 'Önce Bütçe sayfasında genel reklam bütçesini belirleyin.'],
  [
    'no_paid_lane',
    'Onaylı stratejide, genel reklam bütçesinin para biriminde bir ücretli kanal yok. Önce stratejiye ekleyin.',
  ],
  ['spend_stopped', 'Reklam harcaması durdurulmuş. Bütçe sayfasından yeniden açılabilir.'],
  [
    'above_general_budget',
    `Reklam kampanyası bütçesi genel reklam bütçesinde kalanı aşıyor. Kalan: ${formatMoney(1200, 'TRY', 'tr')}.`,
  ],
  [
    'above_strategy_cap',
    `Reklam kampanyası bütçesi stratejideki ücretli kanal sınırını aşıyor. Kalan: ${formatMoney(1200, 'TRY', 'tr')}.`,
  ],
  [
    'above_account_cap',
    `Reklam kampanyası bütçesi reklam hesabının harcama sınırını aşıyor. Kalan: ${formatMoney(1200, 'TRY', 'tr')}.`,
  ],
])('explains %s refusals plainly', async (reason, message) => {
  mockFetch({
    ...adsAnswers,
    'POST /api/ads/campaigns': withStatus(409, {
      code: 'CONFLICT',
      message: 'private detail',
      details: { reason, left: 1200 },
    }),
  });
  renderAt('/ads');
  const dialog = await fillOpening();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Reklam kampanyası aç' }));
  expect(await within(dialog).findByText(message)).toBeVisible();
});

it('loads open pages by cursor, sorts by start time, filters platforms, and reveals closed campaigns', async () => {
  const later = {
    ...campaign,
    id: 'later',
    title: 'Sonraki reklam',
    start_at: '2026-12-30T10:00:00Z',
    plan: { ...campaign.plan, placements: { platforms: ['instagram'] } },
  };
  const ended = { ...campaign, id: 'ended', title: 'Biten reklam', state: { state: 'ended', note: null } };
  const calls = mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns?scope=open': { campaigns: [later], next_before: 'cursor/1' },
    'GET /api/ads/campaigns?scope=open&before=cursor%2F1': { campaigns: [campaign], next_before: null },
    'GET /api/ads/campaigns?scope=closed': { campaigns: [ended], next_before: null },
  });
  renderAt('/ads');
  await screen.findByText('Sonraki reklam');
  expect(calls.some((c) => c.search.includes('closed'))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Daha fazla' }));
  await screen.findByRole('link', { name: campaign.title });
  const queue = screen.getByRole('list', { name: 'Reklam kampanyaları' });
  expect(
    within(queue)
      .getAllByRole('link')
      .map((a) => a.textContent),
  ).toEqual([campaign.title, 'Sonraki reklam']);
  await userEvent.selectOptions(screen.getByLabelText('Platform', { exact: true }), 'facebook');
  expect(within(queue).queryByText('Sonraki reklam')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Kapanmış reklam kampanyalarını göster' }));
  expect(await screen.findByRole('link', { name: 'Biten reklam' })).toBeVisible();
});

it.each(['ended', 'expired', 'declined'])('keeps %s campaigns read-only', async (state) => {
  mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': {
      campaign: { ...campaign, state: { state, note: null } },
      days: [],
      materials: [],
    },
  });
  renderAt('/ads?campaign=campaign-1');
  await screen.findByRole('heading', { name: campaign.title });
  for (const name of [
    'Onayla',
    'Reddet',
    'Sürdür',
    'Bitir',
    'Kampanyayı durdur',
    'Bütçeyi ve bitiş tarihini değiştir',
  ])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  if (state === 'expired')
    expect(screen.getByText('Bu önerinin onay süresi doldu. Harcama yapılmadı.')).toBeVisible();
});

it.each([
  ['proposed', 'Onayla', 'approve'],
  ['paused', 'Sürdür', 'resume'],
  ['live', 'Bitir', 'end'],
])('uses the revision for %s → %s', async (state, name, action) => {
  const stop =
    state === 'paused'
      ? { by: 'person' as const, at: '2026-11-12T09:00:00Z', reason: 'Yeni görsel bekliyoruz' }
      : null;
  const calls = mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': {
      campaign: { ...campaign, stop, state: { state, note: stop?.reason ?? null } },
      days: [],
      materials: [],
    },
    [`POST /api/ads/campaigns/campaign-1/${action}`]: campaign,
  });
  renderAt('/ads?campaign=campaign-1');
  await userEvent.click(await screen.findByRole('button', { name }));
  if (action === 'end') {
    // Ending cannot be undone: it is confirmed first, and says what happens to the money.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/yeniden başlatılamaz/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bitir' }));
  }
  if (stop)
    expect(screen.getByText('Bir kişi durdurdu: Yeni görsel bekliyoruz')).toBeVisible();
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: `/api/ads/campaigns/campaign-1/${action}`,
      body: { expected_revision: 4 },
    }),
  );
});

it('aggregates daily spend and results across ads and shows no fabricated zero cost', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': {
      ...adsAnswers['GET /api/ads/campaigns/campaign-1'],
      campaign: { ...campaign, totals: { ...campaign.totals, results: 0 } },
    },
  });
  renderAt('/ads?campaign=campaign-1');
  expect(await screen.findByText('7 form')).toBeVisible();
  expect(screen.getByText(`Harcanan: ${formatMoney(30000, 'TRY', 'tr')}`)).toBeVisible();
  expect(screen.getByText('Sonuç başına maliyet').parentElement).toHaveTextContent('—');
});

it('ads workers can read but cannot open, approve or edit campaign money', async () => {
  const session = adsAnswers['GET /api/auth/me'];
  mockFetch({
    ...adsAnswers,
    'GET /api/auth/me': {
      ...session,
      memberships: [{ ...session.memberships[0], permissions: ['ads.work'] }],
    },
  });
  const { router } = renderAt('/ads');
  await screen.findByRole('link', { name: campaign.title });
  expect(screen.queryByRole('button', { name: 'Reklam kampanyası aç' })).not.toBeInTheDocument();
  await router.navigate('/ads?campaign=campaign-1');
  await screen.findByRole('heading', { name: campaign.title });
  expect(
    screen.queryByRole('button', { name: 'Bütçeyi ve bitiş tarihini değiştir' }),
  ).not.toBeInTheDocument();
});

it('pauses with a required reason and updates budget and end time with the revision', async () => {
  // Not built yet: what is built at the ad platform keeps its budget and its end.
  const queued = { ...campaign, built: null, state: { state: 'queued' as const, note: null } };
  const calls = mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': { campaign: queued, days: [], materials: [] },
    'POST /api/ads/campaigns/campaign-1/pause': queued,
    'PATCH /api/ads/campaigns/campaign-1': queued,
  });
  renderAt('/ads?campaign=campaign-1');
  await userEvent.click(await screen.findByRole('button', { name: 'Kampanyayı durdur' }));
  let dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Neden'), 'Yeni görsel bekliyoruz');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Kampanyayı durdur' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      expected_revision: 4,
      reason: 'Yeni görsel bekliyoruz',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Bütçeyi ve bitiş tarihini değiştir' }));
  dialog = screen.getByRole('dialog');
  await userEvent.clear(within(dialog).getByLabelText('Reklam kampanyası bütçesi'));
  await userEvent.type(within(dialog).getByLabelText('Reklam kampanyası bütçesi'), '6.000,50');
  fireEvent.change(within(dialog).getByLabelText('Bitiş tarihi (isteğe bağlı)'), {
    target: { value: '2026-12-20T15:30' },
  });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      expected_revision: 4,
      budget_minor: 600050,
      end_at: new Date('2026-12-20T15:30').toISOString(),
    }),
  );
});

it('links to Budget when the existing ad budget is not general', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/budget/items': [{ ...generalBudget, item: { ...generalBudget.item, general: false } }],
  });
  renderAt('/ads');
  expect(await screen.findByText('Başlamak için genel reklam bütçesini belirleyin.')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Bütçe’de gör' })).toHaveAttribute('href', '/budget');
});

it('lets an ads worker pause a running campaign without granting resume or money edits', async () => {
  const session = adsAnswers['GET /api/auth/me'];
  mockFetch({
    ...adsAnswers,
    'GET /api/auth/me': {
      ...session,
      memberships: [{ ...session.memberships[0], permissions: ['ads.work'] }],
    },
  });
  renderAt('/ads?campaign=campaign-1');
  expect(await screen.findByRole('button', { name: 'Kampanyayı durdur' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Sürdür' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Bitir' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Bütçeyi ve bitiş tarihini değiştir' }),
  ).not.toBeInTheDocument();
});

import { material } from '@/test/materials';
it('uses the ad’s authorized material preview in the fallback frame', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': {
      campaign: {
        ...campaign,
        plan: { ...campaign.plan, ads: [{ ...campaign.plan.ads[0], material_ids: ['m-ad'] }] },
      },
      days: [],
      materials: [material('m-ad', { title: 'Kupa fotoğrafı' })],
    },
    'GET /api/studio/materials/m-ad/preview': {
      url: 'https://example.com/kupa.jpg',
      expires_at: '2026-12-01T00:00:00Z',
    },
  });
  renderAt('/ads?campaign=campaign-1');
  await waitFor(() => expect(screen.getByRole('img', { name: 'Kupa fotoğrafı' })).toHaveAttribute('src', 'https://example.com/kupa.jpg'));
  expect(screen.getByText('El yapımı kupalar')).toBeVisible();
});

it('offers no budget or end change on a built campaign, and no resume while the budget holds it', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': {
      campaign: {
        ...campaign,
        stop: { by: 'budget', at: '2026-11-12T09:00:00Z', reason: 'budget_exhausted' },
        state: { state: 'paused', note: 'budget_exhausted' },
      },
      days: [],
      materials: [],
    },
  });
  renderAt('/ads?campaign=campaign-1');
  expect(
    await screen.findByText('Bütçe durdurdu; kendiliğinden sürer: genel reklam bütçesi bu dönem için doldu'),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Sürdür' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Bütçeyi ve bitiş tarihini değiştir' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Bitir' })).toBeVisible();
});

it('says why a campaign ended and when the ad platform has not confirmed its pause yet', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': {
      campaign: {
        ...campaign,
        ended: { at: '2026-11-13T09:00:00Z', reason: 'person' },
        state: { state: 'ended', note: 'provider_still_running' },
      },
      days: [],
      materials: [],
    },
  });
  renderAt('/ads?campaign=campaign-1');
  expect(await screen.findByText('Bir kişi bitirdi.')).toBeVisible();
  expect(screen.getByText(/Reklam platformunda durdurulması bekleniyor/)).toBeVisible();
});

it('refuses an end date outside 24 hours to 90 days after the start before sending', async () => {
  const calls = mockFetch({ ...adsAnswers, 'POST /api/ads/campaigns': campaign });
  renderAt('/ads');
  const dialog = await fillOpening();
  fireEvent.change(within(dialog).getByLabelText('Bitiş tarihi (isteğe bağlı)'), {
    target: { value: '2026-12-01T20:00' },
  });
  expect(within(dialog).getByRole('button', { name: 'Reklam kampanyası aç' })).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText('Bitiş tarihi (isteğe bağlı)'), {
    target: { value: '2026-12-02T09:00' },
  });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Reklam kampanyası aç' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      end_at: new Date('2026-12-02T09:00').toISOString(),
    }),
  );
});

it('tells a person why the agent’s plan was turned down, in words they can act on', async () => {
  mockFetch({
    ...adsAnswers,
    'GET /api/ads/campaigns/campaign-1': {
      campaign: {
        ...campaign,
        plan: null,
        built: null,
        refused: 2,
        refusal: [
          { field: 'ad_account', reason: 'not_a_usable_ad_account' },
          { field: 'ad_account', reason: 'credential_scope_missing', needs: ['ads_management'] },
          { field: 'budget_minor', reason: 'below_the_accounts_minimum', least: 700000 },
          { field: 'ads[0].primary_text', reason: 'claim_not_in_strategy' },
        ],
        state: { state: 'queued', note: null },
      },
      days: [],
      materials: [],
    },
  });
  renderAt('/ads?campaign=campaign-1');
  expect(await screen.findByText('Ajanın son planı geri çevrildi (2/3)')).toBeVisible();
  expect(
    screen.getByText('Reklam hesabı kullanılamıyor: bağlı ve doğrulanmış bir reklam hesabı gerekli.'),
  ).toBeVisible();
  // A connection that may only read says which permission to allow when reconnecting.
  expect(
    screen.getByText((text) => text.includes('reklam oluşturma izni yok (ads_management)')),
  ).toBeVisible();
  expect(
    screen.getByText((text) => text.includes(`En az: ${formatMoney(700000, 'TRY', 'tr')}.`)),
  ).toBeVisible();
  expect(screen.getByText('Ajanın düzelteceği alan: ads[0].primary_text')).toBeVisible();
  // The goal is not said twice when the title is the goal.
  expect(screen.getAllByText(campaign.title)).toHaveLength(1);
});
