import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { accountDetail, emptyPending, inDays, socialAccount, socialAnswers, socialSettings, tiktokAccount } from '@/test/social';
import { slot as studioSlot } from '@/test/studio';

const me = socialAnswers['GET /api/auth/me'];
/** The session with only `permissions`. */
const only = (...permissions: string[]) => ({ ...me, memberships: [{ ...me.memberships[0], permissions }] });
const chain = studioSlot.chain;
const pendingSlot = (id: string, capability = 'ig1', revision = 4) => ({ slot: { id, chain, capability_id: capability, scheduled_at: inDays(2), state: 'ready', revision }, overdue: false });
const approvalPost = (id: string, title: string, days: number) => ({ slot_id: id, publish_at: inDays(days), format: 'feed_post', title, held_at_provider: false, state: 'waiting_person', waits_for: 'approval' });

/** The owner's real state: one Instagram account, two posts awaiting approval, nothing else waiting. */
const owner = {
  ...socialAnswers,
  'GET /api/social/accounts': [{ ...socialAccount, name: 'figurunica instagram', requires_human_approval: true }],
  'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [approvalPost('a1', 'Kasım koleksiyonu', 2), approvalPost('a2', 'Perde arkası', 4)] },
  'GET /api/social/packages': [],
  'GET /api/studio/pending': {
    ...emptyPending,
    slots: [pendingSlot('a1'), pendingSlot('a2', 'ig1', 6)],
    approvals: [{ slot: 'a1' }, { slot: 'a2' }],
    blockers: [{ target: { slot: 'a1' }, reason: 'human_approval_required' }, { target: { slot: 'a2' }, reason: 'human_approval_required' }],
  },
};

describe('the rail', () => {
  it('lists every account with its kind, its marks and its next post, and selects one in the address', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts': [socialAccount, tiktokAccount, { ...socialAccount, capability_id: 'x1', name: '@kilitli', kind: 'x', status: 'unreachable', next: null }] });
    const { router } = renderAt('/social');
    const rail = await screen.findByRole('navigation', { name: 'Hesaplar' });
    expect(within(rail).getByRole('link', { name: /Tüm hesaplar/ })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('link', { name: /@atolye.video · TikTok · Duraklatıldı/ })).toBeVisible();
    expect(within(rail).getByRole('link', { name: /@kilitli · X · / })).toHaveTextContent('Planlanmış paylaşım yok');
    expect(within(rail).getByRole('link', { name: /^@atolye · Instagram/ })).toHaveTextContent(/Sıradaki:/);
    await userEvent.click(within(rail).getByRole('link', { name: /^@atolye · Instagram/ }));
    expect(router.state.location.search).toBe('?account=ig1');
    expect(await screen.findByRole('region', { name: 'Instagram · @atolye' })).toBeVisible();
  });

  it('shows an account empty state leading to Connect', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts': [] });
    renderAt('/social');
    expect(await screen.findByText('Henüz bağlı sosyal hesabın yok.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Hesap bağla' })).toHaveAttribute('href', '/connect');
  });

  it('offers retry for a failed account read without calling it empty', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts': withStatus(503, { code: 'INTERNAL', message: 'down', details: {} }) });
    renderAt('/social');
    expect(await screen.findByRole('button', { name: 'Yeniden dene' })).toBeVisible();
    expect(screen.queryByText('Henüz bağlı sosyal hesabın yok.')).not.toBeInTheDocument();
  });
});

describe('the owner’s state: one account, two posts awaiting approval', () => {
  it('counts them, shows the account’s numbers on the whole view and approves one on its row', async () => {
    const calls = mockFetch({ ...owner, 'POST /api/studio/approvals': {} });
    renderAt('/social');
    const strip = (await screen.findAllByRole('region', { name: 'Sizi bekleyenler' }))[0];
    expect(within(strip).getByRole('button', { name: '2 onay bekleyen paylaşım' })).toBeVisible();
    // With one account every account is that one: its numbers show without choosing it.
    expect(screen.getByRole('region', { name: 'Instagram · figurunica instagram' })).toBeVisible();
    const row = screen.getByRole('article', { name: 'Kasım koleksiyonu' });
    expect(within(row).getByText('Onayınızı bekliyor')).toBeVisible();
    // One account: the rows do not repeat its name.
    expect(within(row).queryByText('figurunica instagram')).not.toBeInTheDocument();
    const approve = within(row).getByRole('button', { name: /^Onayla · figurunica instagram, / });
    await userEvent.click(approve);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ target: { slot: 'a1' }, expected_revision: 4 }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('says "Sizi bekleyenler" and its count once, and that the waiting posts join "Sırada" once approved', async () => {
    mockFetch(owner);
    const { router } = renderAt('/social');
    const [rail, list] = await screen.findAllByRole('region', { name: 'Sizi bekleyenler' });
    // The rail's is the phone's accounts screen; on a desk the list's title line says it alone.
    expect(rail).toHaveClass('md:hidden');
    expect(within(list).getByRole('article', { name: 'Kasım koleksiyonu' })).toBeVisible();
    expect(within(list).getAllByText('Sizi bekleyenler')).toHaveLength(1);
    // One kind alone filters nothing: its chip is words, not a button.
    expect(within(list).getByText('onay bekleyen paylaşım')).toBeVisible();
    expect(within(list).queryByRole('button', { name: '2 onay bekleyen paylaşım' })).not.toBeInTheDocument();
    expect(list).not.toHaveTextContent(/Sizi bekleyenlers*2s*2/);
    const queued = screen.getByRole('region', { name: 'Sırada' });
    expect(within(queued).getByRole('heading', { level: 2 })).toHaveTextContent(/^Sırada$/);
    expect(queued).toHaveTextContent('Başka planlanmış paylaşım yok. Yukarıdaki 2 paylaşım onaylanınca buraya gelir.');
    expect(queued).not.toHaveTextContent('Planlanmış paylaşım yok.');
    // On the phone's accounts screen the one chip leads to the posts, unfiltered.
    await userEvent.click(within(rail).getByRole('button', { name: '2 onay bekleyen paylaşım' }));
    expect(router.state.location.search).toBe('?view=all');
  });

  it('says a refused approval is stale and reads again', async () => {
    const calls = mockFetch({ ...owner, 'POST /api/studio/approvals': withStatus(409, { code: 'CONFLICT', message: 'stale', details: {} }) });
    renderAt('/social');
    const row = await screen.findByRole('article', { name: 'Perde arkası' });
    await userEvent.click(within(row).getByRole('button', { name: /^Onayla/ }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Kayıt değişti');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ target: { slot: 'a2' }, expected_revision: 6 });
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/studio/pending').length).toBeGreaterThan(1));
  });

  it('lets a social worker see the waiting posts but approve none', async () => {
    const calls = mockFetch({ ...owner, 'GET /api/auth/me': only('social.work') });
    renderAt('/social');
    const row = await screen.findByRole('article', { name: 'Kasım koleksiyonu' });
    expect(within(row).queryByRole('button', { name: /^Onayla/ })).not.toBeInTheDocument();
    expect(within(row).getByText('Onayı sosyal medyayı yönetme yetkisi olan biri verir.')).toBeVisible();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });
});

describe('the waiting strip', () => {
  const crowded = {
    ...socialAnswers,
    'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [...accountDetail.upcoming, approvalPost('a1', 'Onaylık', 2), { ...approvalPost('f1', 'Gidemeyen', 0), state: 'ready', waits_for: null, publish_at: inDays(-1) }] },
    'GET /api/social/packages': [{ ...socialAnswers['GET /api/social/packages'][0], versions: [...socialAnswers['GET /api/social/packages'][0].versions, { version_id: 'v2', format: 'feed_post', text: 'Gidemez', material_ids: [], accounts: [], blocked: 'hypothesis_does_not_post' }] }],
    'GET /api/studio/pending': {
      ...emptyPending,
      slots: [pendingSlot('a1'), pendingSlot('f1'), pendingSlot('s1', 'tt1')],
      approvals: [{ slot: 'a1' }, { slot: 's1' }],
      blockers: [
        { target: { slot: 'a1' }, reason: 'human_approval_required' },
        { target: { slot: 's1' }, reason: 'human_approval_required', next_action: 'tiktok_posting_screen' },
        { target: { slot: 'f1' }, reason: 'publish_permanent', next_action: 'review_publication_duplicate_risk' },
      ],
    },
  };

  it.each([
    ['1 onay bekleyen paylaşım', 'approvals', 'Onaylık'],
    ['1 TikTok paylaşımı tamamlanacak', 'tiktok', 'Atölye videosu'],
    ['1 gönderilemeyen paylaşım', 'failed', 'Gidemeyen'],
    ['1 sürüm zaman bekliyor', 'times', 'Birlikte üretelim.'],
    ['1 sürüm hiçbir hesaba gidemiyor', 'blocked', 'Gidemez'],
  ])('“%s” filters to its own rows', async (chip, filter, title) => {
    mockFetch(crowded);
    const { router } = renderAt('/social');
    const strip = (await screen.findAllByRole('region', { name: 'Sizi bekleyenler' }))[0];
    await userEvent.click(await within(strip).findByRole('button', { name: chip }));
    expect(router.state.location.search).toContain(`filter=${filter}`);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article', { name: new RegExp(title.replace('.', '\\.')) })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Sırada' })).not.toBeInTheDocument();
    await userEvent.click(within((await screen.findAllByRole('region', { name: 'Sizi bekleyenler' }))[0]).getByRole('button', { name: chip }));
    expect(router.state.location.search).not.toContain('filter=');
  });

  it('filters from the list’s own title line when more than one kind waits', async () => {
    mockFetch(crowded);
    const { router } = renderAt('/social');
    const list = (await screen.findAllByRole('region', { name: 'Sizi bekleyenler' }))[1];
    await userEvent.click(await within(list).findByRole('button', { name: '1 gönderilemeyen paylaşım' }));
    expect(router.state.location.search).toContain('filter=failed');
    const filtered = screen.getAllByRole('region', { name: 'Sizi bekleyenler' })[1];
    expect(filtered).toHaveTextContent('Yalnız gönderilemeyen paylaşımlar.');
    expect(within(filtered).getByRole('button', { name: '1 gönderilemeyen paylaşım' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(filtered).getAllByRole('article')).toHaveLength(1);
  });

  it('says in a few words when nothing waits, once on each screen, and keeps "Sırada" plain', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts': [socialAccount], 'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [] }, 'GET /api/social/packages': [], 'GET /api/studio/pending': emptyPending });
    renderAt('/social');
    const queued = await screen.findByRole('region', { name: 'Sırada' });
    await waitFor(() => expect(queued).toHaveTextContent(/^Sıradas*Planlanmış paylaşım yok.$/));
    const [rail, list] = screen.getAllByRole('region', { name: 'Sizi bekleyenler' });
    expect(rail).toHaveClass('md:hidden');
    expect(within(list).getAllByText('Şu an sizi bekleyen bir şey yok.')).toHaveLength(1);
    expect(screen.getAllByText('Şu an sizi bekleyen bir şey yok.')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Yayınlananlar' })).toHaveTextContent(/^Yayınlananlars*1/);
    expect(screen.queryAllByRole('button', { pressed: false }).filter((b) => /bekleyen|tamamlanacak|gönderilemeyen|sürüm/.test(b.textContent ?? ''))).toHaveLength(0);
  });

  it.each([
    ['other kinds wait', owner],
    ['nothing waits at all', { ...owner, 'GET /api/social/accounts/ig1': accountDetail, 'GET /api/studio/pending': emptyPending }],
  ])('says an old ?filter= link that matches nothing matches nothing, with the way back (%s)', async (_, answers) => {
    mockFetch(answers);
    const { router } = renderAt('/social?filter=failed');
    const line = await screen.findByText('Bu türden bekleyen bir şey kalmadı.');
    // The list's own "Sizi bekleyenler" (the rail's is the phone's other screen).
    const list = line.closest('section')!;
    expect(list).toHaveAccessibleName('Sizi bekleyenler');
    expect(within(list).getAllByText('Sizi bekleyenler')).toHaveLength(1);
    expect(screen.queryByText('Yalnız gönderilemeyen paylaşımlar.')).not.toBeInTheDocument();
    expect(within(list).queryByText('Şu an sizi bekleyen bir şey yok.')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sırada' })).not.toBeInTheDocument();
    await userEvent.click(within(line).getByRole('button', { name: 'Hepsini göster' }));
    expect(router.state.location.search).not.toContain('filter=');
    expect(await screen.findByRole('region', { name: 'Sırada' })).toBeVisible();
  });
});

describe('a row for each state', () => {
  it('shows what goes out by itself, held, at the platform, and what went out with its numbers', async () => {
    mockFetch({
      ...socialAnswers,
      'GET /api/social/accounts': [socialAccount],
      'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [...accountDetail.upcoming, { ...accountDetail.upcoming[1], slot_id: 'h1', title: 'Bekleyen', state: 'held' }] },
      'GET /api/studio/pending': emptyPending,
    });
    renderAt('/social');
    expect(within(await screen.findByRole('article', { name: 'Yeni koleksiyon' })).getByText('Platformda zamanlandı')).toBeVisible();
    expect(within(screen.getByRole('article', { name: 'Atölyeden' })).getByText('Jeeta yayınlayacak')).toBeVisible();
    expect(within(screen.getByRole('article', { name: 'Bekleyen' })).getByText('Tutuluyor')).toBeVisible();
    const done = screen.getByRole('article', { name: 'Dünkü buluşma' });
    expect(within(done).getByText('Yayınlandı')).toBeVisible();
    expect(done).toHaveTextContent('Görüntülenme—');
    expect(done).toHaveTextContent('Etkileşim0');
    expect(within(done).getByRole('link', { name: 'Gönderiyi aç' })).toHaveAttribute('href', 'https://www.instagram.com/p/example');
  });

  it('shows a published post with no planned post behind it without a format', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, recent: [{ ...accountDetail.recent[0], slot_id: 'older', format: null, title: 'Eski paylaşım' }] } });
    renderAt('/social?account=ig1');
    const row = await screen.findByRole('article', { name: 'Eski paylaşım' });
    expect(row).not.toHaveTextContent('null');
    expect(row).not.toHaveTextContent('posts.format');
  });

  it('opens a row in place with its whole text and preview, in the address', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/studio/slots/ready': { slot: { ...studioSlot, id: 'ready' }, piece: { text: 'Atölyeden\nİkinci satır', media: [], adaptations: {} }, attempts: [], measurements: [] } });
    const { router } = renderAt('/social?account=ig1');
    const row = await screen.findByRole('article', { name: 'Atölyeden' });
    await userEvent.click(within(row).getByRole('button', { expanded: false }));
    expect(router.state.location.search).toContain('slot=ready');
    expect((await within(row).findAllByText(/İkinci satır/))[0]).toBeVisible();
    await userEvent.click(within(row).getByRole('button', { expanded: true }));
    expect(router.state.location.search).not.toContain('slot=');
  });

  it('cancels a failed post only with its reason, asked for at that moment', async () => {
    const calls = mockFetch({
      ...socialAnswers,
      'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [{ ...accountDetail.upcoming[1], slot_id: 'f1', title: 'Gidemeyen', publish_at: inDays(-1) }] },
      'GET /api/studio/pending': { ...emptyPending, slots: [pendingSlot('f1')], blockers: [{ target: { slot: 'f1' }, reason: 'publish_permanent' }] },
      'GET /api/studio/slots/f1': { slot: { ...studioSlot, id: 'f1', revision: 5 }, piece: null, attempts: [{ state: 'failed', failure_reason: 'permanent: instagram: media_rejected' }], measurements: [] },
      'POST /api/studio/slots/f1/cancel': {},
    });
    renderAt('/social');
    const row = await screen.findByRole('article', { name: 'Gidemeyen' });
    expect(within(row).getByText('Gönderilemedi')).toBeVisible();
    expect(await within(row).findByText(/media_rejected/)).toBeVisible();
    expect(within(row).queryByLabelText('İptal nedeni')).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'İçeriği iptal et' }));
    expect(within(row).getByRole('button', { name: 'Paylaşımı iptal et' })).toBeDisabled();
    await userEvent.type(within(row).getByLabelText('İptal nedeni'), 'Görsel yenilenecek');
    await userEvent.click(within(row).getByRole('button', { name: 'Paylaşımı iptal et' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ expected_revision: 5, reason: 'Görsel yenilenecek' }));
  });

  it('opens a TikTok post to finish in a dialog over the page', async () => {
    mockFetch(socialAnswers);
    const { router } = renderAt('/social');
    const row = await screen.findByRole('article', { name: 'Atölye videosu' });
    await userEvent.click(within(row).getByRole('link', { name: 'TikTok paylaşımını tamamla' }));
    expect(router.state.location.search).toContain('tiktok=s1');
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('form', { name: "TikTok'ta paylaş" })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.search).not.toContain('tiktok='));
  });
});

describe('a version with no time', () => {
  const settings = { ...socialSettings, policy: { ...socialSettings.policy, quiet_start_hour: 22, quiet_end_hour: 8 } };
  const planned = (id: string, at: string) => ({
    post: { slot_id: id, workspace_id: 'w', format: 'feed_post', capability_id: 'ig1', publish_at: at, prep_start_at: at, grace_until: at, olay_id: null, package_request_id: 'q', material_ids: [], subject: { kind: 'generic' }, hypothesis_id: 'h1', content_type: 'text', retired: null, created_at: at },
    slot: { ...studioSlot, id, capability_id: 'ig1', scheduled_at: at, state: 'ready' },
    pending: false,
  });

  it('offers the account’s usual time on free days and gives one with a tap', async () => {
    // The account posts at 12:00; days 3 and 4 already have a feed post.
    const calls = mockFetch({
      ...socialAnswers,
      'GET /api/social/accounts': [socialAccount],
      'GET /api/studio/pending': emptyPending,
      'GET /api/social/packages': [{ ...socialAnswers['GET /api/social/packages'][0], versions: [{ ...socialAnswers['GET /api/social/packages'][0].versions[0], format: 'feed_post' }] }],
      'GET /api/studio/posts': { posts: [planned('x1', inDays(3)), planned('x2', inDays(4)), planned('x3', inDays(-1))], settings },
      'POST /api/social/versions/schedule': {},
    });
    renderAt('/social?version=v1');
    const row = await screen.findByRole('article', { name: 'Birlikte üretelim.' });
    expect(within(row).getByText('@atolye hesabına')).toBeVisible();
    const offers = await within(row).findAllByRole('button', { name: /^Zamanı ver: / });
    expect(offers).toHaveLength(3);
    const first = offers[0].getAttribute('aria-label')!;
    // Not days 3 or 4, and every offer is at 12:00.
    for (const o of offers) expect(o.getAttribute('aria-label')).toMatch(/12:00$/);
    await userEvent.click(offers[0]);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ project_id: 'p1', version_id: 'v1', capability_id: 'ig1' }));
    const at = (calls.find((c) => c.method === 'POST')!.body as { publish_at: string }).publish_at;
    expect(new Date(at).getHours()).toBe(12);
    expect([inDays(3), inDays(4)]).not.toContain(at);
    expect(first).toBeTruthy();
  });

  it('offers no time it cannot derive: an account with no post gets only the field', async () => {
    const calls = mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [], recent: [] }, 'POST /api/social/versions/schedule': {} });
    renderAt('/social?tab=packages#version-v1');
    const row = await screen.findByRole('article', { name: 'Birlikte üretelim.' });
    expect(within(row).queryByRole('button', { name: /^Zamanı ver: / })).not.toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText('Paylaşım zamanı'), { target: { value: '2026-12-21T10:30' } });
    await userEvent.click(within(row).getByRole('button', { name: 'Zamanı ver' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      project_id: 'p1', version_id: 'v1', capability_id: 'ig1', publish_at: new Date('2026-12-21T10:30').toISOString(), request_key: expect.any(String),
    }));
  });

  it('says in words why the engine refused a time', async () => {
    mockFetch({ ...socialAnswers, 'POST /api/social/versions/schedule': withStatus(422, { code: 'VALIDATION', message: 'refused', details: { field: 'posts', reason: 'package_refused', items: [{ index: 0, reason: 'quiet_hours' }] } }) });
    renderAt('/social');
    const row = await screen.findByRole('article', { name: 'Birlikte üretelim.' });
    await userEvent.click(within(row).getByRole('button', { name: 'Zamanı siz verin' }));
    fireEvent.change(within(row).getByLabelText(/Paylaşım zamanı|Başka bir zaman/), { target: { value: '2026-12-21T03:00' } });
    await userEvent.click(within(row).getByRole('button', { name: 'Zamanı ver' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Bu zaman verilemedi: sessiz saatlere denk geliyor');
  });

  it('says why no account can take a blocked version and where that is fixed', async () => {
    const pack = socialAnswers['GET /api/social/packages'][0];
    mockFetch({ ...socialAnswers, 'GET /api/social/packages': [{ ...pack, versions: [{ ...pack.versions[0], accounts: [], blocked: 'hypothesis_does_not_post' }] }] });
    renderAt('/social');
    const row = await screen.findByRole('article', { name: 'Birlikte üretelim.' });
    expect(within(row).getByText(/hipotezi stratejide paylaşım yapmıyor/)).toBeVisible();
    expect(within(row).getByRole('link', { name: 'Stratejiye git' })).toHaveAttribute('href', '/strategy');
    expect(within(row).queryByRole('button', { name: 'Zamanı ver' })).not.toBeInTheDocument();
  });
});

describe('old addresses', () => {
  it('lands ?tab=packages#version-<id> on that version’s row, open', async () => {
    mockFetch(socialAnswers);
    const { router } = renderAt('/social?tab=packages#version-v1');
    const row = await screen.findByRole('article', { name: 'Birlikte üretelim.' });
    expect(router.state.location.search).toBe('?version=v1');
    expect(row).toHaveAttribute('id', 'version-v1');
    expect(within(row).getByRole('button', { name: 'Zamanı ver' })).toBeInTheDocument();
  });

  it.each(['?tab=settings', '?section=settings', '?tab=posts&view=settings'])('opens the settings for %s', async (query) => {
    mockFetch(socialAnswers);
    const { router } = renderAt(`/social${query}`);
    expect(await screen.findByRole('dialog', { name: 'Paylaşım ayarları' })).toBeVisible();
    expect(router.state.location.search).toBe('?settings=1');
  });

  it.each(['?tab=posts', '?tab=plan', '?tab=posts&view=week', '?tab=accounts'])('opens the page for the old tab %s', async (query) => {
    mockFetch({ ...socialAnswers, 'GET /api/studio/pending': emptyPending });
    const { router } = renderAt(`/social${query}`);
    expect(await screen.findByRole('link', { name: /^@atolye · Instagram/ })).toBeVisible();
    expect(router.state.location.search).toBe('');
  });

  it.each(['?slot=s1', '?tiktok=s1'])('opens the retained TikTok posting form for %s', async (query) => {
    mockFetch(socialAnswers);
    renderAt(`/social${query}`);
    expect(await screen.findByRole('form', { name: "TikTok'ta paylaş" })).toBeVisible();
  });

  it('opens a post named by ?slot= in place, and one no list holds from its slot', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/studio/slots/done': { slot: { ...studioSlot, id: 'done', state: 'published' }, piece: { text: 'Dünkü buluşma\nUzun metin', media: [], adaptations: {} }, attempts: [], measurements: [] } });
    renderAt('/social?slot=done');
    const row = await screen.findByRole('article', { name: 'Dünkü buluşma' });
    expect(within(row).getByRole('button', { expanded: true })).toBeVisible();
    expect((await within(row).findAllByText(/Uzun metin/))[0]).toBeVisible();
  });

  it('shows a post taken back, that no list holds, from its slot', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/studio/slots/gone': { slot: { ...studioSlot, id: 'gone', state: 'retired' }, piece: { text: 'Geri alınan', media: [], adaptations: {} }, attempts: [], measurements: [] } });
    renderAt('/social?slot=gone');
    const card = await screen.findByRole('article', { name: 'Bu paylaşım listelerde yok' });
    expect(await within(card).findByText('Geri alınan')).toBeVisible();
    expect(within(card).getByText('Emekliye ayrıldı')).toBeVisible();
  });
});

describe('the account view', () => {
  it('shows each metric with its change and a line, missing ones as —, and the period’s totals', async () => {
    mockFetch(socialAnswers);
    renderAt('/social?account=ig1');
    const view = await screen.findByRole('region', { name: 'Instagram · @atolye' });
    expect(await within(view).findByTestId('metric-followers')).toHaveTextContent('1.250');
    expect(within(view).getByTestId('metric-followers')).toHaveTextContent('+50');
    expect(within(view).getByTestId('metric-views')).toHaveTextContent('—');
    // A day with no number splits the line; it is not a zero.
    expect(within(view).getByRole('img', { name: 'Takipçi eğilimi' }).querySelectorAll('polyline')).toHaveLength(2);
    expect(within(view).queryByRole('img', { name: 'Görüntülenme eğilimi' })).not.toBeInTheDocument();
    expect(within(view).getByLabelText('Dönem toplamı')).toHaveTextContent('12.000');
  });

  it('does not fabricate a change when the starting observation is absent', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, days: [{ ...socialAccount.latest, followers: null }, socialAccount.latest] } });
    renderAt('/social?account=ig1');
    expect(await screen.findByTestId('metric-followers')).toHaveTextContent('Değişim: —');
  });

  it('reads the period chosen and keeps it in the address; the phone’s way back clears the account', async () => {
    const calls = mockFetch(socialAnswers);
    const { router } = renderAt('/social?account=ig1');
    await userEvent.click(await screen.findByRole('button', { name: '90 gün' }));
    await waitFor(() => {
      const query = new URLSearchParams(calls.filter((c) => c.path === '/api/social/accounts/ig1').at(-1)?.search);
      expect((Date.parse(query.get('until')!) - Date.parse(query.get('from')!)) / 86400000).toBe(89);
    });
    expect(router.state.location.search).toContain('days=90');
    await userEvent.click(screen.getByRole('link', { name: 'Hesaplara dön' }));
    expect(router.state.location.search).toBe('');
  });

  it('warns about posts the platform holds that Jeeta did not leave there, and only about those', async () => {
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, at_platform: [
      { external_id: 'p1', publish_at: inDays(3, 11), title: 'Elle zamanlanmış', known: false },
      { external_id: 'p2', publish_at: inDays(3, 10), title: 'Sistemin kendi gönderisi', known: true },
    ] } });
    renderAt('/social?account=ig1');
    const strays = await screen.findByRole('region', { name: 'Platformda zamanlanmış, Jeeta’nın bilmediği gönderiler' });
    expect(within(strays).getByText(/Elle zamanlanmış/)).toBeVisible();
    expect(within(strays).queryByText(/Sistemin kendi gönderisi/)).not.toBeInTheDocument();
  });

  it('pauses with the latest revision and updates the account’s marks', async () => {
    const pausedSettings = { ...socialSettings, paused_capability_ids: ['ig1', 'tt1'], revision: 8 };
    const calls = mockFetch({ ...socialAnswers, 'POST /api/social/accounts/ig1/pause': pausedSettings });
    renderAt('/social?account=ig1');
    const toggle = await screen.findByRole('switch', { name: '@atolye · Paylaşımı duraklat' });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ paused: true, expected_revision: 7 }));
    expect(await screen.findByRole('switch', { name: '@atolye · Paylaşımı sürdür' })).toBeChecked();
    expect(screen.getByRole('link', { name: /^@atolye · Instagram · Duraklatıldı/ })).toBeVisible();
  });

  it('keeps the account unchanged after a refused pause and reads the revision again', async () => {
    const calls = mockFetch({ ...socialAnswers, 'POST /api/social/accounts/ig1/pause': withStatus(409, { code: 'CONFLICT', message: 'stale revision', details: {} }) });
    renderAt('/social?account=ig1');
    const toggle = await screen.findByRole('switch', { name: '@atolye · Paylaşımı duraklat' });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(await screen.findByText('Kayıt değişti. Yenileyip tekrar deneyin.')).toBeVisible();
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/studio/posts').length).toBeGreaterThan(1));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('many accounts and many posts', () => {
  it('shows ten rows a section and the rest on request, each row naming its account', async () => {
    const upcoming = Array.from({ length: 30 }, (_, i) => ({ ...accountDetail.upcoming[1], slot_id: `u${i}`, title: `Sıradaki ${i}`, publish_at: inDays(1 + i) }));
    const recent = Array.from({ length: 40 }, (_, i) => ({ ...accountDetail.recent[0], slot_id: `p${i}`, title: `Yayın ${i}`, published_at: inDays(-1 - i) }));
    mockFetch({ ...socialAnswers, 'GET /api/social/accounts/ig1': { ...accountDetail, upcoming, recent }, 'GET /api/studio/pending': emptyPending, 'GET /api/social/packages': [] });
    renderAt('/social');
    const queued = await screen.findByRole('region', { name: 'Sırada' });
    expect(within(queued).getAllByRole('article')).toHaveLength(10);
    expect(within(queued).getByRole('article', { name: 'Sıradaki 0' })).toHaveTextContent('@atolye');
    await userEvent.click(within(queued).getByRole('button', { name: '20 tane daha göster' }));
    expect(within(queued).getAllByRole('article')).toHaveLength(30);
    const published = screen.getByRole('region', { name: 'Yayınlananlar' });
    expect(within(published).getAllByRole('article')[0]).toHaveAccessibleName('Yayın 0');
    expect(within(published).getAllByRole('article')).toHaveLength(10);
  });
});
