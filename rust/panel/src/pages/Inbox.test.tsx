import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { inboxAnswers, inboxMe, conversation, context, journey, merge } from '@/test/inbox';

async function openConversation(answers = inboxAnswers) {
  const calls = mockFetch(answers);
  renderAt('/inbox/conv-1');
  await screen.findByRole('textbox', { name: 'Yanıtınız' });
  return calls;
}

describe('Inbox', () => {
  it('renders the workspace status label returned by journeys.get', async () => {
    await openConversation({
      ...inboxAnswers,
      'GET /api/inbox/journeys/journey-1': {
        journey,
        events: [],
        tasks: [],
        notes: [],
        status_labels: { contacted: 'İlk temas bekleniyor' },
      },
    });
    const panel = await screen.findByRole('complementary', { name: 'Yolculuk' });
    expect(within(panel).getByText('İlk temas bekleniyor')).toBeInTheDocument();
  });

  it('human_holder_does_not_disable_panel_reply', async () => {
    const calls = await openConversation();
    const user = userEvent.setup();
    const reply = screen.getByRole('textbox', { name: 'Yanıtınız' });
    expect(reply).toBeEnabled();
    await user.type(reply, 'Elbette.');
    await user.click(screen.getByRole('button', { name: 'Yanıt gönder' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/reply'))?.body).toEqual({
        text: 'Elbette.',
        intent: 'reply',
        request_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
  });

  it('event_forms_match_tool_schema', async () => {
    const calls = await openConversation();
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Olay kaydet' });
    const select = within(form).getByLabelText('Olay');
    const submit = within(form).getByRole('button', { name: 'Olay kaydet' });
    const send = async (kind: string, payload: unknown) => {
      const before = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/events')).length;
      await user.click(submit);
      await waitFor(() =>
        expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/events'))).toHaveLength(
          before + 1,
        ),
      );
      const body = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/events')).slice(-1)[0]?.body;
      expect(body).toEqual({
        kind,
        idempotency_key: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        payload,
      });
      await waitFor(() => expect(submit).toBeEnabled());
    };
    await user.selectOptions(select, 'call_made');
    await user.click(within(form).getByLabelText('Görüşme gerçekleşti'));
    await send('call_made', { connected: true });
    for (const kind of ['appointment_booked', 'meeting_held', 'quote_accepted']) {
      await user.selectOptions(select, kind);
      await send(kind, {});
    }
    await user.selectOptions(select, 'won');
    await user.type(within(form).getByLabelText('Ürün'), 'Danışmanlık');
    await user.type(within(form).getByLabelText('Tutar'), '125');
    await send('won', { product: 'Danışmanlık', amount_minor: 12500, currency: 'TRY' });
    await user.selectOptions(select, 'lost');
    await user.selectOptions(within(form).getByLabelText('Kayıp nedeni'), 'fiyat');
    await send('lost', { reason_key: 'fiyat' });
    await user.selectOptions(select, 'snoozed');
    fireEvent.change(within(form).getByLabelText('Erteleme bitişi (yerel saat)'), {
      target: { value: '2099-12-01T10:30' },
    });
    await send('snoozed', { until: new Date('2099-12-01T10:30').toISOString() });
    const keys = calls
      .filter((c) => c.path.endsWith('/events'))
      .map((c) => (c.body as { idempotency_key: string }).idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('merge_banner_and_confirm', async () => {
    const answers = {
      ...inboxAnswers,
      'GET /api/inbox/merges': [merge],
      'POST /api/inbox/merges/merge-1/apply': { ...merge, status: 'applied' },
      'POST /api/inbox/merges/merge-1/undo': { ...merge, status: 'undone' },
    };
    const calls = await openConversation(answers);
    const user = userEvent.setup();
    const apply = await screen.findByRole('button', { name: 'Birleştir' });
    answers['GET /api/inbox/merges'] = [{ ...merge, status: 'applied' }];
    await user.click(apply);
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/apply'))?.body).toEqual({ keep: 'person-1' }),
    );
    answers['GET /api/inbox/merges'] = [{ ...merge, status: 'applied' }];
    await user.click(await screen.findByRole('button', { name: 'Birleştirmeyi geri al' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Geri al' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'wrong');
    expect(confirm).toBeDisabled();
    expect(calls.some((c) => c.path.endsWith('/undo'))).toBe(false);
    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'GERİ AL');
    await user.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/undo'))?.body).toEqual({ confirm: true }));
  });

  it('queue_switching_and_unsnooze', async () => {
    const snoozed = { ...conversation, state: { snoozed: { until: '2026-12-01T09:00:00Z' } } };
    const calls = await openConversation({ ...inboxAnswers, 'GET /api/inbox/conversations/conv-1': snoozed });
    const user = userEvent.setup();
    for (const [label, queue] of [
      ['Atanmamış', 'unassigned'],
      ['Ertelenmiş', 'snoozed'],
      ['Hepsi', 'all'],
      ['Bizde', 'ours'],
    ]) {
      await user.click(screen.getByRole('button', { name: label }));
      await waitFor(() =>
        expect(
          calls.some(
            (c) =>
              c.path === '/api/inbox/conversations' && new URLSearchParams(c.search).get('queue') === queue,
          ),
        ).toBe(true),
      );
    }
    await user.click(screen.getByRole('button', { name: 'Ertelemeyi kaldır' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/unsnooze'))).toBe(true),
    );
  });

  it('shows the actual reply fence reason', async () => {
    await openConversation({
      ...inboxAnswers,
      'POST /api/inbox/conversations/conv-1/reply': withStatus(403, {
        code: 'FORBIDDEN',
        message: 'internal',
        details: { reason: 'reply_window_closed' },
      }),
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Yanıtınız'), 'Merhaba');
    await user.click(screen.getByRole('button', { name: 'Yanıt gönder' }));
    expect(await screen.findByText('Bu kanalda yanıt süresi doldu.')).toBeVisible();
    expect(screen.getByLabelText('Yanıtınız')).toBeDisabled();
  });

  it.each([true, false])('Lost inbound reopening obeys manager permission (%s)', async (manage) => {
    const lost = { ...journey, status: 'lost' };
    const calls = await openConversation({
      ...inboxAnswers,
      'GET /api/auth/me': manage
        ? inboxMe
        : {
            ...inboxMe,
            memberships: [
              { ...inboxMe.memberships[0], role_key: 'rep', permissions: ['workspace.read', 'inbox.work'] },
            ],
          },
      'GET /api/inbox/conversations/conv-1/context': { ...context, journey: lost, prohibitions: ['lost'] },
      'GET /api/inbox/journeys/journey-1': { journey: lost, events: [], tasks: [], notes: [] },
    });
    expect(screen.getByLabelText('Yanıtınız')).toBeDisabled();
    if (manage) {
      await userEvent.click(await screen.findByRole('button', { name: 'Yeniden aç?' }));
      await waitFor(() =>
        expect(calls.find((c) => c.path.endsWith('/events'))?.body).toEqual({
          kind: 'reopened',
          idempotency_key: expect.any(String),
          payload: {},
        }),
      );
    } else expect(screen.queryByRole('button', { name: 'Yeniden aç?' })).not.toBeInTheDocument();
  });
});

it('Inbox owner, task and note forms send exact bodies', async () => {
  const calls = await openConversation({
    ...inboxAnswers,
    'POST /api/inbox/journeys/journey-1/owner': journey,
    'POST /api/inbox/journeys/journey-1/tasks': {},
    'POST /api/inbox/journeys/journey-1/notes': {},
  });
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Yolculuk sahibi'), '');
  await waitFor(() => expect(calls.find((c) => c.path.endsWith('/owner'))?.body).toEqual({ user_id: null }));
  await user.type(screen.getByLabelText('Görev başlığı'), 'Tekrar ara');
  fireEvent.change(screen.getByLabelText('Son tarih (yerel saat)'), {
    target: { value: '2026-12-01T10:30' },
  });
  await user.click(screen.getByRole('button', { name: 'Görev ekle' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/tasks'))?.body).toEqual({
      title: 'Tekrar ara',
      due_at: new Date('2026-12-01T10:30').toISOString(),
      assignee: null,
    }),
  );
  await user.type(screen.getByLabelText('Yeni not'), 'Öğleden sonra uygun.');
  await user.click(screen.getByRole('button', { name: 'Not ekle' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith('/notes'))?.body).toEqual({ text: 'Öğleden sonra uygun.' }),
  );
});

it('Inbox merges page refuses suggestions and reports guarded undo conflicts', async () => {
  const answers = {
    ...inboxAnswers,
    'GET /api/inbox/merges': [merge, { ...merge, id: 'merge-2', status: 'applied' }],
    'POST /api/inbox/merges/merge-1/refuse': { ...merge, status: 'refused' },
    'POST /api/inbox/merges/merge-2/undo': withStatus(409, {
      code: 'CONFLICT',
      message: 'internal',
      details: { reason: 'edited_after_merge' },
    }),
  };
  const calls = mockFetch(answers);
  renderAt('/inbox/merges');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Reddet' }));
  await waitFor(() =>
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/refuse'))).toBe(true),
  );
  await user.click(screen.getByRole('button', { name: 'Birleştirmeyi geri al' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), 'GERİ AL');
  await user.click(within(dialog).getByRole('button', { name: 'Geri al' }));
  expect(
    await within(dialog).findByText('Korunan kayıt değiştiği için birleştirme geri alınamıyor.'),
  ).toBeVisible();
});

it('Inbox task links resolve the actual journey and allow completion', async () => {
  const task = {
    id: 'task-1',
    journey_id: journey.id,
    title: 'Teklif takibi',
    due_at: '2026-10-23T10:00:00Z',
    assignee: null,
    status: 'open',
  };
  const calls = mockFetch({
    ...inboxAnswers,
    'GET /api/inbox/tasks': [task],
    'GET /api/inbox/journeys/journey-1': { journey, events: [], tasks: [task], notes: [] },
    'POST /api/inbox/tasks/task-1/complete': { ...task, status: 'done' },
  });
  renderAt('/inbox?task=task-1');
  expect(await screen.findByText('Teklif takibi')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Tamamla' }));
  await waitFor(() =>
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/inbox/tasks/task-1/complete')).toBe(
      true,
    ),
  );
});

it('Inbox search opens person conversations', async () => {
  const calls = mockFetch(inboxAnswers);
  renderAt('/inbox');
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Kişi ara'), 'Deniz');
  await waitFor(() =>
    expect(
      calls.some((c) => c.path === '/api/inbox/people' && new URLSearchParams(c.search).get('q') === 'Deniz'),
    ).toBe(true),
  );
  await user.click(await screen.findByRole('link', { name: /Deniz Örnek/ }));
  expect(await screen.findByRole('heading', { name: 'Deniz Örnek' })).toBeVisible();
  expect(
    screen
      .getAllByRole('link', { name: /Deniz Örnek.*whatsapp_cloud/ })
      .some((link) => link.getAttribute('href') === '/inbox/conv-1'),
  ).toBe(true);
});

it('Inbox does not fetch protected resources without InboxWork', async () => {
  const calls = mockFetch({
    ...inboxAnswers,
    'GET /api/auth/me': {
      ...inboxMe,
      memberships: [{ ...inboxMe.memberships[0], permissions: ['workspace.read'] }],
    },
  });
  renderAt('/inbox/conv-1');
  await screen.findByRole('alert');
  expect(calls.filter((c) => c.path.startsWith('/api/inbox/'))).toEqual([]);
});

it('Inbox timeline preserves event actors and historical lost-reason labels', async () => {
  const events = [
    {
      id: 'event-1',
      source: 'system',
      kind: 'message_received',
      reason_label: null,
      at: '2026-10-23T10:00:00Z',
    },
    {
      id: 'event-2',
      source: 'agent',
      kind: { call_made: { connected: true } },
      reason_label: null,
      at: '2026-10-23T10:01:00Z',
    },
    {
      id: 'event-3',
      source: { human: 'user-2' },
      kind: { lost: { reason_key: 'fiyat' } },
      reason_label: 'Eski fiyat etiketi',
      at: '2026-10-23T10:02:00Z',
    },
  ];
  await openConversation({
    ...inboxAnswers,
    'GET /api/inbox/journeys/journey-1': { journey, events, tasks: [], notes: [] },
  });
  expect(await screen.findByText('Eski fiyat etiketi')).toBeVisible();
  expect(screen.getByText('Sistem')).toBeVisible();
  expect(screen.getByText('Ajan', { exact: true })).toBeVisible();
  expect(screen.getByText('İnsan · user-2')).toBeVisible();
});
