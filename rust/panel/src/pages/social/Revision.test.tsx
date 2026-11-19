import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { accountDetail, emptyPending, inDays, socialAccount, socialAnswers } from '@/test/social';
import { slot as studioSlot, studioAnswers } from '@/test/studio';

const me = socialAnswers['GET /api/auth/me'];
const only = (...permissions: string[]) => ({ ...me, memberships: [{ ...me.memberships[0], permissions }] });
const chain = studioSlot.chain;
const slotOf = (id: string, revision = 4, capability = 'ig1', state = 'ready') => ({ id, chain, capability_id: capability, scheduled_at: inDays(2), state, revision });
const approvalPost = (id: string, title: string, days: number) => ({ slot_id: id, publish_at: inDays(days), format: 'feed_post', title, held_at_provider: false, state: 'waiting_person', waits_for: 'approval' });
const base = studioAnswers['GET /api/studio/slots/s1'];

/** A post of one content: its slot detail, the content and its package's posts as the server says. */
function slotDetail(id: string, content?: Record<string, unknown>, revision = 4) {
  return { ...base, slot: slotOf(id, revision), ...(content ? { content } : {}) };
}
const contentPost = (slot_id: string, patch: Record<string, unknown> = {}) => ({
  slot_id, format: 'feed_post', capability_id: 'ig1', account_name: 'figurunica instagram', scheduled_at: inDays(2), state: 'ready', published: false, withdrawn_by_redo: true, ...patch,
});
const contentOf = (project_id: string, posts: unknown[], patch: Record<string, unknown> = {}) => ({ project_id, title: `İçerik ${project_id}`, package_revision: 1, current: true, redo: null, posts, cancel_archives: false, ...patch });
const areaRow = (id: string, redo: unknown, brief = 'Evcil dostum için yeni koleksiyon') => ({
  area: { id, title: `Evcil dostum ${id}`, brief, olay_id: null, opened_by: { kind: 'human' }, hints: { formats: [], capability_ids: [] }, status: { state: 'queued', step: null, note: null, starts_at: '2026-11-01T09:00:00Z' }, revision: 3, redo, open_requests: 0, created_at: '', updated_at: '' },
  pipeline: { current_step: null, stages: [], unscheduled: [] },
});
const noAreas = { areas: [], next_cursor: null, next_done_before: null };

/** The owner's real case: one Instagram account that asks for approval, two posts waiting, each its own content. */
const owner = {
  ...socialAnswers,
  'GET /api/social/accounts': [{ ...socialAccount, name: 'figurunica instagram', requires_human_approval: true }],
  'GET /api/social/accounts/ig1': { ...accountDetail, upcoming: [approvalPost('a1', 'Evcil dostum', 2), approvalPost('a2', 'Perde arkası', 4)], recent: [] },
  'GET /api/social/packages': [],
  'GET /api/studio/pending': {
    ...emptyPending,
    slots: [{ slot: slotOf('a1'), overdue: false }, { slot: slotOf('a2', 6), overdue: false }],
    approvals: [{ slot: 'a1' }, { slot: 'a2' }],
    blockers: [{ target: { slot: 'a1' }, reason: 'human_approval_required' }, { target: { slot: 'a2' }, reason: 'human_approval_required' }],
  },
  'GET /api/studio/slots/a1': slotDetail('a1', contentOf('p1', [contentPost('a1')])),
  'GET /api/studio/slots/a2': slotDetail('a2', contentOf('p2', [contentPost('a2', { scheduled_at: inDays(4) })]), 6),
  'GET /api/content/areas': noAreas,
};

const rowOf = (name: string) => screen.findByRole('article', { name });

describe('asking for a revision instead of approving', () => {
  it('offers it next to the approval, takes one note inline, says what happens and sends it', async () => {
    const answers: Record<string, unknown> = { ...owner, 'POST /api/content/areas/p1/redo': { project: {}, materials: [], productions: [], publications: [] } };
    const calls = mockFetch(answers as never);
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    expect(within(row).getByRole('button', { name: /^Onayla · figurunica instagram, / })).toBeVisible();
    await userEvent.click(await within(row).findByRole('button', { name: 'Düzenleme iste' }));
    // No dialog: one field in the row.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const form = within(row).getByRole('form', { name: 'Düzenleme iste' });
    const note = within(form).getByLabelText('Ne değişsin?');
    expect(note).toBeRequired();
    expect(note).toHaveAttribute('maxLength', '2000');
    expect(form).toHaveTextContent('Bu paylaşım takvimden çıkar. Ajan içeriği notunuza göre yeniden hazırlar, yeni hali onayınıza gelir.');
    expect(form).not.toHaveTextContent('Aynı içeriğin');
    const send = within(form).getByRole('button', { name: 'Gönder' });
    expect(send).toBeDisabled();
    await userEvent.type(note, 'Köpek yerine kedi olsun');
    // The redo answered: the area now carries the note and the post it took back.
    answers['GET /api/content/areas'] = { ...noAreas, areas: [areaRow('p1', { note: 'Köpek yerine kedi olsun', by: 'u', at: '2026-11-19T10:00:00Z', withdrawn: ['a1'] })] };
    await userEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/content/areas/p1/redo', body: { package_revision: 1, note: 'Köpek yerine kedi olsun' } }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // Not vanished: the content shows as being revised, apart from what waits for the person.
    const group = await screen.findByRole('region', { name: 'Düzenleniyor' });
    expect(within(group).getByText('Evcil dostum p1')).toBeVisible();
    expect(within(group).getByText('Notunuz: “Köpek yerine kedi olsun”')).toBeVisible();
    expect(within(group).getByText(/ istendi$/)).toBeVisible();
    expect(within(group).getByRole('link', { name: 'İçeriği aç' })).toHaveAttribute('href', '/content?content=p1');
    const waiting = screen.getAllByRole('region', { name: 'Sizi bekleyenler' })[0];
    expect(within(waiting).queryByText('Evcil dostum p1')).not.toBeInTheDocument();

    // The agent's new delivery answers the note: the next read has no redo, and the group goes.
    answers['GET /api/content/areas'] = { ...noAreas, areas: [areaRow('p1', null)] };
    answers['POST /api/studio/approvals'] = {};
    await userEvent.click(within(await rowOf('Perde arkası')).getByRole('button', { name: /^Onayla/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Düzenleniyor' })).not.toBeInTheDocument());
  });

  it('names the other posts the redo takes back and the published one that stays', async () => {
    const posts = [
      contentPost('a1'),
      contentPost('x9', { capability_id: 'fb1', account_name: 'Figurunica Sayfa', format: 'story', scheduled_at: inDays(3, 9) }),
      contentPost('pub', { published: true, withdrawn_by_redo: false, state: 'published', account_name: 'figurunica instagram', format: 'reel', scheduled_at: inDays(-1, 9) }),
    ];
    mockFetch({ ...owner, 'GET /api/studio/slots/a1': slotDetail('a1', contentOf('p1', posts)) });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    await userEvent.click(await within(row).findByRole('button', { name: 'Düzenleme iste' }));
    const form = within(row).getByRole('form', { name: 'Düzenleme iste' });
    expect(form).toHaveTextContent(/Bu paylaşım takvimden çıkar\. Aynı içeriğin şu paylaşımı da çıkar: Figurunica Sayfa · Hikâye · .+\. Yayınlanmış olan kalır: figurunica instagram · Reels · .+\. Ajan içeriği/);
  });

  it('says a stale package changed meanwhile and reads the post again', async () => {
    const calls = mockFetch({ ...owner, 'POST /api/content/areas/p1/redo': withStatus(409, { code: 'CONFLICT', message: "the area's package changed", details: {} }) });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    await userEvent.click(await within(row).findByRole('button', { name: 'Düzenleme iste' }));
    await userEvent.type(within(row).getByLabelText('Ne değişsin?'), 'Daha kısa');
    const reads = calls.filter((c) => c.path === '/api/studio/slots/a1').length;
    await userEvent.click(within(row).getByRole('button', { name: 'Gönder' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('İçerik bu arada değişti; güncel hali yüklendi.');
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/studio/slots/a1').length).toBeGreaterThan(reads));
    // The note stays to be sent again.
    expect(within(row).getByLabelText('Ne değişsin?')).toHaveValue('Daha kısa');
  });

  it('says the platform did not let a scheduled post go, and nothing changed', async () => {
    mockFetch({ ...owner, 'POST /api/content/areas/p1/redo': withStatus(409, { code: 'CONFLICT', message: 'the platform did not confirm taking the scheduled post back', details: { reason: 'withdraw_unconfirmed', slot_id: 'a1' } }) });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    await userEvent.click(await within(row).findByRole('button', { name: 'Düzenleme iste' }));
    await userEvent.type(within(row).getByLabelText('Ne değişsin?'), 'Daha kısa');
    await userEvent.click(within(row).getByRole('button', { name: 'Gönder' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('Platform zamanlanmış paylaşımı geri aldığını doğrulamadı; hiçbir şey değişmedi.');
  });

  it('is not offered to a session without content.manage, nor is the group without a content read', async () => {
    const calls = mockFetch({ ...owner, 'GET /api/auth/me': only('social.work', 'social.manage') });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    expect(within(row).getByRole('button', { name: /^Onayla/ })).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Düzenleme iste' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'İptal et' })).not.toBeInTheDocument();
    // Nothing of the production line is asked for.
    expect(calls.some((c) => c.path === '/api/content/areas')).toBe(false);
    expect(calls.some((c) => c.path === '/api/studio/slots/a1')).toBe(false);
  });

  it('offers a content worker without content.manage no revision', async () => {
    mockFetch({ ...owner, 'GET /api/auth/me': only('social.work', 'social.manage', 'content.work') });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    await waitFor(() => expect(within(row).getByRole('button', { name: /^Onayla/ })).toBeVisible());
    expect(within(row).queryByRole('button', { name: 'Düzenleme iste' })).not.toBeInTheDocument();
  });

  it('offers the cancel with a reason for a post made of no content', async () => {
    const calls = mockFetch({ ...owner, 'GET /api/studio/slots/a1': slotDetail('a1'), 'POST /api/studio/slots/a1/cancel': slotDetail('a1') });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    expect(await within(row).findByText('Bu paylaşım bir içerikten gelmedi; düzenlenecek içerik yok. İsterseniz iptal edin, gönderilmez.')).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'Düzenleme iste' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'İptal et' }));
    await userEvent.type(within(row).getByLabelText('İptal nedeni'), 'Artık gerek yok');
    await userEvent.click(within(row).getByRole('button', { name: 'Paylaşımı iptal et' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/studio/slots/a1/cancel', body: { expected_revision: 4, reason: 'Artık gerek yok' } }));
  });

  it('keeps a planned post’s row quiet and offers the revision in its opened detail', async () => {
    mockFetch({
      ...owner,
      'GET /api/social/accounts': [socialAccount],
      'GET /api/social/accounts/ig1': { ...accountDetail, recent: [] },
      'GET /api/studio/pending': emptyPending,
      'GET /api/studio/slots/ready': slotDetail('ready', contentOf('p3', [contentPost('ready', { account_name: '@atolye' })])),
      'GET /api/studio/slots/held': slotDetail('held'),
    });
    renderAt('/social');
    const row = await rowOf('Atölyeden');
    expect(within(row).queryByRole('button', { name: 'Düzenleme iste' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /Atölyeden/ }));
    await userEvent.click(await within(row).findByRole('button', { name: 'Düzenleme iste' }));
    expect(within(row).getByRole('form', { name: 'Düzenleme iste' })).toHaveTextContent('Bu paylaşım takvimden çıkar. Ajan içeriği notunuza göre yeniden hazırlar, yeni hali yeniden sıraya girer.');
  });

  it('shows a content whose redo names no post when it had a post on the chosen account', async () => {
    // A redo recorded before `withdrawn` existed: the posts list says which content its posts were of.
    mockFetch({
      ...owner,
      'GET /api/studio/posts': { posts: [
        { post: { slot_id: 'old1', capability_id: 'ig1', material_ids: [], format: 'feed_post', publish_at: inDays(1) }, slot: slotOf('old1', 2, 'ig1', 'retired'), pending: false },
        { post: { slot_id: 'old2', capability_id: 'fb1', material_ids: [], format: 'feed_post', publish_at: inDays(1) }, slot: slotOf('old2', 2, 'fb1', 'retired'), pending: false },
      ], settings: socialAnswers['GET /api/studio/posts'].settings,
      contents: [{ slot_id: 'old1', project_id: 'older' }, { slot_id: 'old2', project_id: 'elsewhere' }] },
      'GET /api/content/areas': { ...noAreas, areas: [
        areaRow('older', { note: 'Eski kayıt', by: 'u', at: '2026-11-19T09:13:00Z' }),
        areaRow('elsewhere', { note: 'Başka hesap', by: 'u', at: '2026-11-19T09:14:00Z' }),
        areaRow('none', { note: 'Postu yoktu', by: 'u', at: '2026-11-19T10:00:00Z' }),
      ] },
    });
    renderAt('/social?account=ig1');
    const group = await screen.findByRole('region', { name: 'Düzenleniyor' });
    expect(within(group).getByText('Evcil dostum older')).toBeVisible();
    expect(within(group).queryByText('Evcil dostum elsewhere')).not.toBeInTheDocument();
    expect(within(group).queryByText('Evcil dostum none')).not.toBeInTheDocument();
  });

  it('shows only the contents that had a post on the chosen account', async () => {
    mockFetch({
      ...owner,
      'GET /api/studio/posts': { posts: [
        { post: { slot_id: 'gone1', capability_id: 'ig1', material_ids: [], format: 'feed_post', publish_at: inDays(1) }, slot: slotOf('gone1', 2, 'ig1', 'retired'), pending: false },
        { post: { slot_id: 'gone2', capability_id: 'fb1', material_ids: [], format: 'feed_post', publish_at: inDays(1) }, slot: slotOf('gone2', 2, 'fb1', 'retired'), pending: false },
      ], settings: socialAnswers['GET /api/studio/posts'].settings },
      'GET /api/content/areas': { ...noAreas, areas: [
        areaRow('here', { note: 'Kısalt', by: 'u', at: '2026-11-19T10:00:00Z', withdrawn: ['gone1'] }),
        areaRow('there', { note: 'Uzat', by: 'u', at: '2026-11-19T10:00:00Z', withdrawn: ['gone2'] }),
        areaRow('none', { note: 'Postu yoktu', by: 'u', at: '2026-11-19T10:00:00Z' }),
      ] },
    });
    renderAt('/social?account=ig1');
    const group = await screen.findByRole('region', { name: 'Düzenleniyor' });
    expect(within(group).getByText('Evcil dostum here')).toBeVisible();
    expect(within(group).queryByText('Evcil dostum there')).not.toBeInTheDocument();
    // A redo that took back no post here is the content page's matter only.
    expect(within(group).queryByText('Evcil dostum none')).not.toBeInTheDocument();
  });
});

describe('cancelling a post of a content', () => {
  it('offers “İptal et” next to the approval and the revision, takes a reason inline and names the post that stays', async () => {
    const posts = [
      contentPost('a1'),
      contentPost('x9', { capability_id: 'fb1', account_name: 'Figurunica Sayfa', format: 'story', scheduled_at: inDays(3, 9) }),
    ];
    const calls = mockFetch({ ...owner, 'GET /api/studio/slots/a1': slotDetail('a1', contentOf('p1', posts)), 'POST /api/studio/slots/a1/cancel': slotDetail('a1') });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    expect(within(row).getByRole('button', { name: /^Onayla · figurunica instagram, / })).toBeVisible();
    expect(await within(row).findByRole('button', { name: 'Düzenleme iste' })).toBeVisible();
    await userEvent.click(within(row).getByRole('button', { name: 'İptal et' }));
    // One form at a time: the revision waits until the cancel is put away.
    expect(within(row).queryByRole('button', { name: 'Düzenleme iste' })).not.toBeInTheDocument();
    const form = within(row).getByRole('form', { name: 'İptal et' });
    const reason = within(form).getByLabelText('Neden iptal ediyorsunuz?');
    expect(reason).toBeRequired();
    expect(form).toHaveTextContent(/^.*Bu paylaşım takvimden çıkar ve bir daha planlanmaz; ajan ona yeni bir saat vermez\. İçeriğin şu paylaşımı yerinde kalır: Figurunica Sayfa · Hikâye · .+\./);
    expect(form).not.toHaveTextContent('arşive');
    const send = within(form).getByRole('button', { name: 'Paylaşımı iptal et' });
    expect(send).toBeDisabled();
    await userEvent.type(reason, 'Aynı görsellerle ikinci kez hazırlanmış');
    await userEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/studio/slots/a1/cancel', body: { expected_revision: 4, reason: 'Aynı görsellerle ikinci kez hazırlanmış' } }));
    expect(await within(row).findByText('İptal edildi. Bu paylaşım bir daha planlanmaz.')).toBeVisible();
  });

  it('says the content is archived when this is its last post, and puts the form away on “Vazgeç”', async () => {
    mockFetch({ ...owner, 'GET /api/studio/slots/a1': slotDetail('a1', contentOf('p1', [contentPost('a1')], { cancel_archives: true })) });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    await userEvent.click(await within(row).findByRole('button', { name: 'İptal et' }));
    const form = within(row).getByRole('form', { name: 'İptal et' });
    expect(form).toHaveTextContent('Bu paylaşım takvimden çıkar ve bir daha planlanmaz; ajan ona yeni bir saat vermez. İçeriğin gidecek başka paylaşımı kalmadığı için içerik de arşive kalkar.');
    await userEvent.click(within(form).getByRole('button', { name: 'Vazgeç' }));
    expect(within(row).queryByRole('form', { name: 'İptal et' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Düzenleme iste' })).toBeVisible();
  });

  it('offers it for a queued post inside its opened row', async () => {
    mockFetch({
      ...owner,
      'GET /api/social/accounts': [socialAccount],
      'GET /api/social/accounts/ig1': { ...accountDetail, recent: [] },
      'GET /api/studio/pending': emptyPending,
      'GET /api/studio/slots/ready': slotDetail('ready', contentOf('p3', [contentPost('ready', { account_name: '@atolye' })])),
      'GET /api/studio/slots/held': slotDetail('held'),
    });
    renderAt('/social');
    const row = await rowOf('Atölyeden');
    expect(within(row).queryByRole('button', { name: 'İptal et' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /Atölyeden/ }));
    await userEvent.click(await within(row).findByRole('button', { name: 'İptal et' }));
    expect(within(row).getByRole('form', { name: 'İptal et' })).toHaveTextContent('Bu paylaşım takvimden çıkar ve bir daha planlanmaz');
  });

  it('is not offered to a content reader who may not manage posts', async () => {
    mockFetch({ ...owner, 'GET /api/auth/me': only('social.work', 'content.manage') });
    renderAt('/social');
    const row = await rowOf('Evcil dostum');
    expect(await within(row).findByRole('button', { name: 'Düzenleme iste' })).toBeVisible();
    expect(within(row).queryByRole('button', { name: 'İptal et' })).not.toBeInTheDocument();
  });
});

describe('what the agent will do about the contents being revised', () => {
  const none = { state: 'no_agent' } as const;
  const wakes = (content: unknown) => ({ agents: [], needs: { content, materials: none, social: none, ads: none, research: none, inbox: none } });
  const revising = { ...noAreas, areas: [
    areaRow('p1', { note: 'Köpek yerine kedi olsun', by: 'u', at: '2026-11-19T10:00:00Z', withdrawn: ['a1'] }),
    areaRow('p2', { note: 'Daha kısa', by: 'u', at: '2026-11-19T10:00:00Z', withdrawn: ['a2'] }),
  ] };

  it('says once, over the page, that the agent will be called in seconds', async () => {
    mockFetch({ ...owner, 'GET /api/content/areas': revising, 'GET /api/agents/wakes': wakes({ state: 'calling', api_key_id: 'k1', due_at: new Date(Date.now() + 40_000).toISOString(), waiting_for: 'settle' }) });
    renderAt('/social');
    await screen.findByRole('region', { name: 'Düzenleniyor' });
    expect(await screen.findByText(/^Ajan (39|40) sn içinde çağrılacak$/)).toBeInTheDocument();
    expect(screen.getAllByTestId('agent-wake-line')).toHaveLength(1);
  });

  it('says nothing of the agent when no content is being revised', async () => {
    const calls = mockFetch({ ...owner, 'GET /api/agents/wakes': wakes({ state: 'called', api_key_id: 'k1', at: new Date().toISOString() }) });
    const { client } = renderAt('/social');
    await rowOf('Evcil dostum');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/agents/wakes')).toBe(true));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByTestId('agent-wake-line')).not.toBeInTheDocument();
  });
});
