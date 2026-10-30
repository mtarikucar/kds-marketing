import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { USER_ID, WS_ID } from '@/test/fixtures';
import { inboxAnswers, inboxMe, conversation, context, journey, merge, person } from '@/test/inbox';
import i18n from '@/i18n/config';

/** What the server sends as `status_labels`: the fixed Turkish defaults, all nine stages. */
const turkishDefaults = {
  new: 'Yeni',
  contacted: 'İletişim kuruldu',
  unreachable: 'Ulaşılamadı',
  appointment: 'Randevu',
  met: 'Görüşüldü',
  quoted: 'Teklif verildi',
  pending: 'Beklemede',
  won: 'Kazanıldı',
  lost: 'Kaybedildi',
};

async function openConversation(answers = inboxAnswers) {
  const calls = mockFetch(answers);
  renderAt('/inbox/conv-1');
  await screen.findByRole('textbox', { name: 'Yanıtınız' });
  return calls;
}

describe('Inbox', () => {
  it('renders the workspace status label override returned by journeys.get', async () => {
    await openConversation({
      ...inboxAnswers,
      'GET /api/inbox/journeys/journey-1': {
        journey,
        events: [],
        tasks: [],
        notes: [],
        status_labels: { ...turkishDefaults, contacted: 'İlk temas bekleniyor' },
        status_label_overrides: { contacted: 'İlk temas bekleniyor' },
      },
    });
    const panel = await screen.findByRole('complementary', { name: 'Yolculuk' });
    expect(within(panel).getByText('İlk temas bekleniyor')).toBeInTheDocument();
  });

  it('shows the English stage name in the English panel, not the Turkish server default', async () => {
    await i18n.changeLanguage('en');
    mockFetch({
      ...inboxAnswers,
      'GET /api/inbox/journeys/journey-1': {
        journey,
        events: [],
        tasks: [],
        notes: [],
        status_labels: turkishDefaults,
        status_label_overrides: {},
      },
    });
    renderAt('/inbox/conv-1');
    const panel = await screen.findByRole('complementary', { name: 'Journey' });
    expect(await within(panel).findByText('Contacted')).toBeInTheDocument();
    expect(within(panel).queryByText('İletişim kuruldu')).not.toBeInTheDocument();
  });

  it("keeps the workspace's own stage label in the English panel", async () => {
    await i18n.changeLanguage('en');
    mockFetch({
      ...inboxAnswers,
      'GET /api/inbox/journeys/journey-1': {
        journey,
        events: [],
        tasks: [],
        notes: [],
        status_labels: { ...turkishDefaults, contacted: 'Waiting for first reply' },
        status_label_overrides: { contacted: 'Waiting for first reply' },
      },
    });
    renderAt('/inbox/conv-1');
    const panel = await screen.findByRole('complementary', { name: 'Journey' });
    expect(await within(panel).findByText('Waiting for first reply')).toBeInTheDocument();
    expect(within(panel).queryByText('Contacted')).not.toBeInTheDocument();
  });

  it("explains why a reply was not sent, in the owner's words", async () => {
    const failed = {
      id: 'message-2',
      conversation_id: 'conv-1',
      workspace_id: WS_ID,
      direction: 'outbound',
      author: { human: USER_ID },
      body: 'Merhaba!',
      status: 'failed',
      external_id: null,
      cost_minor: null,
      at: '2026-10-23T10:05:00Z',
      failure_reason: 'permanent: meta: HTTP 400 OAuthException (#131030): Recipient phone number not in allowed list',
    };
    const listed = inboxAnswers['GET /api/inbox/conversations/conv-1/messages'] as { items: unknown[] };
    await openConversation({
      ...inboxAnswers,
      'GET /api/inbox/conversations/conv-1/messages': { items: [...listed.items, failed], next_cursor: null },
    });
    const messages = await screen.findByRole('list', { name: 'Mesajlar' });
    expect(within(messages).getByText(/^Gönderilemedi: alıcı, Meta test numarasının izinli alıcıları/)).toBeInTheDocument();
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

  it('leaves an empty mail subject to the server, which answers the original one', async () => {
    const calls = await openConversation({
      ...inboxAnswers,
      'GET /api/inbox/conversations/conv-1': { ...conversation, kind_key: 'mailbox' },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Yanıtınız' }), 'Teşekkürler.');
    await user.click(screen.getByRole('button', { name: 'Yanıt gönder' }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/reply'))?.body).not.toHaveProperty('subject'));
    await user.type(screen.getByRole('textbox', { name: 'E-posta konusu' }), 'Teklifiniz');
    await user.type(screen.getByRole('textbox', { name: 'Yanıtınız' }), 'Ekte.');
    await user.click(screen.getByRole('button', { name: 'Yanıt gönder' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith('/reply')).slice(-1)[0]?.body).toMatchObject({ subject: 'Teklifiniz' }),
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
      .getAllByRole('link', { name: /Deniz Örnek.*WhatsApp/ })
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
    { id: 'event-4', source: { human: USER_ID }, kind: 'reopened', reason_label: null, at: '2026-10-23T10:03:00Z' },
    { id: 'event-5', source: { human: 'user-9' }, kind: 'reopened', reason_label: null, at: '2026-10-23T10:04:00Z' },
  ];
  await openConversation({
    ...inboxAnswers,
    'GET /api/team': [
      ...(inboxAnswers['GET /api/team'] as object[]),
      {
        membership_id: 'member-2',
        user_id: 'user-2',
        email: 'cem@alpha.example',
        display_name: null,
        role_key: 'rep',
        role_name: 'Rep',
        status: 'removed',
        created_at: '2026-10-23T10:00:00Z',
      },
    ],
    'GET /api/inbox/journeys/journey-1': { journey, events, tasks: [], notes: [] },
  });
  expect(await screen.findByText('Eski fiyat etiketi')).toBeVisible();
  expect(screen.getByText('Sistem')).toBeVisible();
  expect(screen.getByText('Ajan', { exact: true })).toBeVisible();
  // A human is named, never shown as an id: a member (even a former one), you, or "team member".
  expect(await screen.findByText('İnsan · cem@alpha.example')).toBeVisible();
  expect(screen.getByText('İnsan · Siz')).toBeVisible();
  expect(screen.getByText('İnsan · Ekip üyesi')).toBeVisible();
  expect(document.body.textContent).not.toContain('user-2');
});

it('Inbox names an unnamed contact by its channel and the end of its id, never by a uuid', async () => {
  const unnamed = { ...person, display_name: '', first_touch: { ...person.first_touch, source: { channel: 'messenger' } } };
  const messenger = { ...conversation, kind_key: 'messenger' };
  const identity = {
    id: 'identity-1',
    workspace_id: WS_ID,
    person_id: person.id,
    channel: 'messenger',
    value_normalized: '1175657112297652:27325092857145601',
    value_display: '27325092857145601',
    active: true,
    first_seen_at: '2026-10-23T10:00:00Z',
  };
  await openConversation({
    ...inboxAnswers,
    'GET /api/inbox/conversations': { items: [messenger], next_cursor: null },
    'GET /api/inbox/conversations/conv-1': messenger,
    'GET /api/inbox/conversations/conv-1/context': { ...context, person: unnamed },
    'GET /api/inbox/people/person-1': { person: unnamed, identities: [identity], open_journey: journey, conversations: [messenger] },
  });
  const thread = await screen.findByRole('heading', { level: 2, name: 'Messenger kişisi · …5601' });
  expect(thread).toBeVisible();
  expect(await screen.findByRole('link', { name: /Messenger kişisi · …5601/ })).toBeVisible();
  expect(document.body.textContent).not.toContain(person.id);
});
