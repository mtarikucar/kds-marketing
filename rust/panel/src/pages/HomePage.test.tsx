import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import {
  DRAFT_ID,
  PAGE_ID,
  approvedVersion,
  draftVersion,
  me,
  pendingOverdue,
  repMe,
  strategyWithDraft,
  workspace,
} from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

/** The pending work of a workspace whose draft awaits approval. */
const submitted = {
  ...pendingOverdue,
  strategy: { submitted: { version_id: DRAFT_ID, submitted_at: '2026-10-22T10:00:00Z' } },
};

describe('HomePage', () => {
  it('shows the workspace, its status and the missing strategy with its call to action', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': pendingOverdue });
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: tr.home.title })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: workspace.name })).toBeInTheDocument();
    expect(screen.getAllByText(tr.status.workspace.pending_payment).length).toBeGreaterThan(0);
    expect(await screen.findByText(tr.home.strategy.title)).toBeInTheDocument();
    expect(screen.getByText(tr.home.strategy.body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.home.strategy.start })).toBeInTheDocument();
  });

  it('treats a never-connected agent as a setup step, with the way to connect one', async () => {
    mockFetch({
      'GET /api/auth/me': me,
      'GET /api/workspace': workspace,
      'GET /api/work/pending': { ...pendingOverdue, agent: { last_seen_at: null, interval_minutes: 1440, overdue: true } },
    });
    renderAt('/');
    const note = await screen.findByText(tr.home.agent.neverTitle);
    expect(note.closest('[role="alert"]')).toBeNull();
    expect(screen.queryByText(tr.home.agent.overdueTitle)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: tr.home.agent.connectLink })).toHaveAttribute('href', '/api-keys');
  });

  it('warns in red when the agent is overdue, and lists each pending item in its own words', async () => {
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': pendingOverdue });
    renderAt('/');
    const warning = await screen.findByText(tr.home.agent.overdueTitle);
    expect(warning.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText(tr.home.agent.schedulerNote)).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t('home.pending.verify_capability_stale', { name: 'Ofis yazıcısı' })),
    ).toBeInTheDocument();
    expect(screen.getByText(tr.home.pending.consult_strategy)).toBeInTheDocument();
    // The agent's English hint is for the agent, never shown.
    expect(screen.queryByText('verify it again')).not.toBeInTheDocument();
  });

  it('names the connector capability that awaits its connection', async () => {
    const connector = {
      ...pendingOverdue,
      items: [
        {
          kind: 'connect_connector' as const,
          capability_id: '0190a000-0000-7000-8000-000000000044',
          name: 'Marka Instagram',
          priority: 2,
          hint: 'connect it',
        },
      ],
    };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': connector });
    renderAt('/');
    const text = await screen.findByText(i18n.t('home.pending.connect_connector', { name: 'Marka Instagram' }));
    expect(text).toHaveTextContent('Marka Instagram');
    expect(screen.queryByText('connect it')).not.toBeInTheDocument();
  });

  it('offers the approval shortcut only to someone who may approve', async () => {
    mockFetch({ 'GET /api/auth/me': repMe, 'GET /api/workspace': workspace, 'GET /api/work/pending': submitted });
    renderAt('/');
    expect(await screen.findByText(tr.home.strategy.submittedTitle)).toBeInTheDocument();
    expect(screen.getByText(tr.home.strategy.submittedWait)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.home.strategy.approve })).not.toBeInTheDocument();
  });

  it('opens the assumptions before the shortcut approves, and sends the pending draft only once confirmed', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/workspace': workspace,
      'GET /api/work/pending': submitted,
      'GET /api/strategy': {
        ...strategyWithDraft,
        draft: { ...draftVersion, gaps: [], hypotheses: approvedVersion.hypotheses },
      },
      'POST /api/strategy/draft/approve': { ...draftVersion, status: 'approved', assumptions: [] },
    });
    const approvals = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/strategy/draft/approve');
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: tr.home.strategy.approve }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Öğrenciler akşamları sipariş verir')).toBeInTheDocument();
    expect(within(dialog).getByText(i18n.t('strategy.approveHypotheses', { count: 1 }))).toBeInTheDocument();
    expect(approvals()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: tr.strategy.approveConfirm }));
    await waitFor(() => expect(approvals()).toHaveLength(1));
    // The shortcut names the draft as the dialog showed it.
    expect(approvals()[0].body).toEqual({ version_id: DRAFT_ID, submitted_at: draftVersion.submitted_at });
  });

  it('home_approve_uses_the_displayed_drafts_stamp', async () => {
    // The pending work was read before the agent submitted the draft again: its stamp is stale.
    // The dialog fetches the draft when it opens and approves the one it shows.
    const user = userEvent.setup();
    const fresh = '2026-10-22T11:30:00Z';
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/workspace': workspace,
      'GET /api/work/pending': submitted,
      'GET /api/strategy': {
        ...strategyWithDraft,
        draft: { ...draftVersion, submitted_at: fresh, gaps: [], hypotheses: approvedVersion.hypotheses },
      },
      'POST /api/strategy/draft/approve': { ...draftVersion, status: 'approved', assumptions: [] },
    });
    renderAt('/');
    await user.click(await screen.findByRole('button', { name: tr.home.strategy.approve }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Öğrenciler akşamları sipariş verir');
    await user.click(within(dialog).getByRole('button', { name: tr.strategy.approveConfirm }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/strategy/draft/approve')?.body).toEqual({
        version_id: DRAFT_ID,
        submitted_at: fresh,
      }),
    );
    expect(submitted.strategy.submitted.submitted_at).not.toBe(fresh);
  });

  it('says why the draft it fetched can no longer be approved', async () => {
    const user = userEvent.setup();
    for (const [draft, reason] of [
      // The agent reopened the draft meanwhile: not submitted any more.
      [{ ...draftVersion, submitted_at: null, gaps: [], hypotheses: approvedVersion.hypotheses }, tr.strategy.approveNotSubmitted],
      // It was approved or closed meanwhile: no draft left.
      [null, tr.strategy.approveNoDraft],
    ] as const) {
      const calls = mockFetch({
        'GET /api/auth/me': me,
        'GET /api/workspace': workspace,
        'GET /api/work/pending': submitted,
        'GET /api/strategy': { ...strategyWithDraft, draft },
      });
      const { unmount } = renderAt('/');
      await user.click(await screen.findByRole('button', { name: tr.home.strategy.approve }));
      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByText(reason)).toBeInTheDocument();
      expect(within(dialog).queryByText(tr.strategy.approveLoading)).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: tr.strategy.approveConfirm })).toBeDisabled();
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
      unmount();
    }
  });

  it('names the connector to reconnect and links to its reconnection', async () => {
    const reconnect = {
      ...pendingOverdue,
      items: [
        {
          kind: 'reconnect_connector' as const,
          capability_id: PAGE_ID,
          name: 'Atölye sayfası',
          priority: 1,
          hint: 'reconnect it',
        },
      ],
    };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': reconnect });
    renderAt('/');
    const text = await screen.findByText(i18n.t('home.pending.reconnect_connector', { name: 'Atölye sayfası' }));
    const row = text.closest('li') as HTMLElement;
    expect(within(row).getByRole('link', { name: tr.home.pending.reconnect })).toHaveAttribute(
      'href',
      `/connect?capability=${PAGE_ID}`,
    );
    expect(screen.queryByText('reconnect it')).not.toBeInTheDocument();
  });

  it('voice_bridge_offline: names the silent bridge and opens the capabilities', async () => {
    const offline = {
      ...pendingOverdue,
      items: [
        {
          kind: 'voice_bridge_offline' as const,
          capability_id: PAGE_ID,
          name: 'Voice bridge 101',
          last_seen_at: '2026-10-22T08:00:00Z',
          priority: 2,
          hint: 'check the bridge',
        },
      ],
    };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': offline });
    renderAt('/');
    const text = await screen.findByText(i18n.t('home.pending.voice_bridge_offline', { name: 'Voice bridge 101' }));
    const row = text.closest('li') as HTMLElement;
    expect(within(row).getByRole('link', { name: tr.home.pending.open })).toHaveAttribute('href', '/capabilities');
    expect(screen.queryByText('check the bridge')).not.toBeInTheDocument();
  });

  it('phone_offline: names the unlisted phone, never as a voice bridge, and opens the capabilities', async () => {
    const offline = {
      ...pendingOverdue,
      items: [
        {
          kind: 'phone_offline' as const,
          capability_id: PAGE_ID,
          name: 'Redmi 10C (SER1)',
          last_seen_at: '2026-10-22T08:00:00Z',
          priority: 2,
          hint: 'check the device bridge',
        },
      ],
    };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': offline });
    renderAt('/');
    const text = await screen.findByText(i18n.t('home.pending.phone_offline', { name: 'Redmi 10C (SER1)' }));
    const row = text.closest('li') as HTMLElement;
    expect(within(row).getByRole('link', { name: tr.home.pending.open })).toHaveAttribute('href', '/capabilities');
    expect(screen.queryByText(i18n.t('home.pending.voice_bridge_offline', { name: 'Redmi 10C (SER1)' }))).not.toBeInTheDocument();
    expect(screen.queryByText('check the device bridge')).not.toBeInTheDocument();
  });

  it('shows the draft gaps and the version in force', async () => {
    const draft = {
      ...pendingOverdue,
      strategy: { draft_open: { gaps: [{ field: 'identity.product', message: 'the product is required' }] } },
      agent: { ...pendingOverdue.agent, overdue: false },
    };
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': draft });
    renderAt('/');
    expect(await screen.findByText(tr.home.strategy.draftTitle)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('home.strategy.draftBody', { count: 1 }))).toBeInTheDocument();
    // The panel's own sentence, never the server's English message.
    expect(screen.getByText(tr.strategy.gaps.product)).toBeInTheDocument();
    expect(screen.queryByText('the product is required')).not.toBeInTheDocument();
    expect(screen.queryByText(tr.home.agent.overdueTitle)).not.toBeInTheDocument();
    expect(screen.getByText(tr.home.agent.onTime)).toBeInTheDocument();
  });

  it('counts the inbound events awaiting the agent, a full count as at least that many', async () => {
    const withEvents = (count: number) => ({
      ...pendingOverdue,
      items: [{ kind: 'inbound_events' as const, count, priority: 2, hint: 'read them' }],
    });
    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': withEvents(3) });
    const { unmount } = renderAt('/');
    const item = await screen.findByText(i18n.t('home.pending.inbound_events', { count: 3, n: '3' }));
    // The agent handles them: nothing for the person to open.
    expect(within(item.closest('li') as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('read them')).not.toBeInTheDocument();
    unmount();

    mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/work/pending': withEvents(1000) });
    renderAt('/');
    expect(
      await screen.findByText(i18n.t('home.pending.inbound_events', { count: 1000, n: '1000+' })),
    ).toBeInTheDocument();
  });

  it('says one inbound event in the singular in English, and keeps one Turkish sentence', () => {
    const en = i18n.getFixedT('en');
    expect(en('home.pending.inbound_events', { count: 1, n: '1' })).toBe(
      '1 inbound event (a message, status, lead, call or consent change) awaits your agent.',
    );
    expect(en('home.pending.inbound_events', { count: 3, n: '3' })).toBe(
      '3 inbound events (messages, statuses, leads, calls, consent changes) await your agent.',
    );
    expect(en('home.pending.inbound_events', { count: 1000, n: '1000+' })).toMatch(/^1000\+ inbound events /);
    const tr = i18n.getFixedT('tr');
    expect(tr('home.pending.inbound_events', { count: 1, n: '1' })).toBe(
      '1 gelen olay (mesaj, durum, form, arama, izin) ajanınızın işlemesini bekliyor.',
    );
    expect(tr('home.pending.inbound_events', { count: 3, n: '3' })).toBe(
      '3 gelen olay (mesaj, durum, form, arama, izin) ajanınızın işlemesini bekliyor.',
    );
  });
});

it('links all four inbox work kinds to actionable destinations', async () => {
  mockFetch({
    'GET /api/auth/me': me,
    'GET /api/workspace': workspace,
    'GET /api/work/pending': { ...pendingOverdue, items: [
      { kind: 'reply_due', conversation_id: 'conv-1', priority: 2, hint: 'private hint' },
      { kind: 'reopen_question', conversation_id: 'conv-2', priority: 2, hint: 'private hint' },
      { kind: 'merge_suggested', merge_id: 'merge-1', priority: 3, hint: 'private hint' },
      { kind: 'task_due', task_id: 'task-1', priority: 3, hint: 'private hint' },
    ] },
  });
  renderAt('/');
  for (const [copy, href] of [
    [tr.home.pending.reply_due, '/inbox/conv-1'],
    [tr.home.pending.reopen_question, '/inbox/conv-2'],
    [tr.home.pending.merge_suggested, '/inbox/merges?merge=merge-1'],
    [tr.home.pending.task_due, '/inbox?task=task-1'],
  ]) {
    const text = await screen.findByText(copy);
    expect(within(text.closest('li')!).getByRole('link')).toHaveAttribute('href', href);
  }
  expect(screen.queryByText('private hint')).not.toBeInTheDocument();
});
