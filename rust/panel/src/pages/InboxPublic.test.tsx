import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { WS_ID } from '@/test/fixtures';
import { context, conversation, inboxAnswers, journey, person } from '@/test/inbox';

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/** A comment of the conversation, owed unless `answer` says otherwise. */
function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: WS_ID,
    capability_id: 'cap-ig',
    conversation_id: 'conv-2',
    message_id: `message-${id}`,
    subject_id: 'subject-1',
    kind: 'comment',
    external_id: `c-${id}`,
    parent_external_id: null,
    root_external_id: `c-${id}`,
    created_at: '2026-10-23T10:00:00Z',
    taken_at: '2026-10-23T10:00:00Z',
    deadline: null,
    private_reply_until: inHours(24 * 6 + 3),
    live: false,
    answer: { state: 'awaiting' },
    moderation: 'visible',
    private_reply_message_id: null,
    agent_answers: 0,
    checked_at: null,
    updated_at: '2026-10-23T10:00:00Z',
    ...extra,
  };
}

const subject = {
  id: 'subject-1',
  kind: 'post',
  external_id: 'media-1',
  title: 'Yeni sezon boyama setleri',
  url: 'https://www.instagram.example/p/abc/',
  image_url: null,
  facts: {},
  publication_id: null,
};

const igRules = {
  public: { min: 1, max: 2200 },
  private: { window_s: 604800, max_chars: 1000 },
  one_answer: false,
  moderated: false,
  hide: true,
  delete: true,
};

function entry(row: ReturnType<typeof item>, text: string, owed = true) {
  return {
    item: row,
    subject,
    thread: [{ author: 'them', text, at: row.created_at, external_id: row.external_id }],
    private_reply_until: row.private_reply_until,
    owed,
  };
}

const publicConversation = {
  ...conversation,
  id: 'conv-2',
  capability_id: 'cap-ig',
  kind_key: 'instagram',
  executor: 'agent',
  surface: 'public',
  channel: 'instagram_comment',
  owed_items: 2,
  next_deadline: null,
  held_replies: 0,
};

function answers(publicPart: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    ...inboxAnswers,
    'GET /api/inbox/conversations/conv-2': publicConversation,
    'GET /api/inbox/conversations/conv-2/context': { ...context, public: publicPart },
    'GET /api/inbox/conversations/conv-2/messages': { items: [], next_cursor: null },
    'GET /api/inbox/pending': {
      ours: [],
      reopen_questions: [],
      merges: [],
      tasks_due: [],
      public_due: [],
      approvals: [],
    },
    ...extra,
  };
}

const comments = {
  channel: 'instagram_comment',
  rules: igRules,
  approval_required: false,
  hint: 'agent hint',
  items: [
    entry(item('1'), 'Fiyatı nedir?'),
    {
      ...entry(item('2', { answer: { state: 'answered', by: 'elsewhere', message_id: null, at: '2026-10-23T11:00:00Z' } }), 'Teşekkürler', false),
      thread: [
        { author: 'them', text: 'Teşekkürler', at: '2026-10-23T10:30:00Z', external_id: 'c-2' },
        { author: 'other', text: 'Ben de aldım', at: '2026-10-23T10:40:00Z', external_id: 'c-3' },
      ],
    },
    entry(item('4', { created_at: '2026-10-23T12:00:00Z' }), 'Kargo ne zaman?'),
  ],
};

async function open(publicPart: Record<string, unknown> = comments, extra: Record<string, unknown> = {}) {
  const calls = mockFetch(answers(publicPart, extra));
  renderAt('/inbox/conv-2');
  await screen.findByTestId('public-conversation');
  return calls;
}

describe('A public conversation', () => {
  it('subject_card_shows_post', async () => {
    await open();
    const [first] = screen.getAllByTestId('subject');
    expect(within(first).getByText('Gönderi')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Yeni sezon boyama setleri' })).toHaveAttribute(
      'href',
      'https://www.instagram.example/p/abc/',
    );
  });

  it('items_show_their_state_badges_and_thread', async () => {
    await open();
    const [first, second] = screen.getAllByTestId('public-item');
    expect(within(first).getByText('Bekliyor')).toBeInTheDocument();
    expect(within(second).getByText('Başka yerden yanıtlandı')).toBeInTheDocument();
    expect(within(second).getByText('Ben de aldım')).toBeInTheDocument();
    expect(within(second).getByText('Başka biri')).toBeInTheDocument();
  });

  it('composer_defaults_to_the_oldest_owed_item', async () => {
    const calls = await open();
    const user = userEvent.setup();
    const target = screen.getByRole('combobox', { name: 'Yanıtlanan' });
    expect(target).toHaveValue('1');
    // Only owed items can be answered.
    expect(within(target).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Fiyatı nedir?',
      'Kargo ne zaman?',
    ]);
    await user.type(screen.getByRole('textbox', { name: 'Yanıtınız' }), 'Merhaba, DM attık.');
    await user.click(screen.getByRole('button', { name: 'Yanıtı gönder' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/inbox/conversations/conv-2/reply')?.body).toEqual({
        item_id: '1',
        visibility: 'public',
        text: 'Merhaba, DM attık.',
        request_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        intent: 'reply',
      }),
    );
  });

  it('private_toggle_only_when_allowed_and_shows_time_left', async () => {
    const calls = await open();
    const user = userEvent.setup();
    expect(screen.getByText(/^Özel yanıt hakkı: 6 gün \d+ sa, bir kez$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Özel (DM)' }));
    await user.type(screen.getByRole('textbox', { name: 'Yanıtınız' }), 'Fiyatı DM ile yazdım.');
    await user.click(screen.getByRole('button', { name: 'Yanıtı gönder' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/reply'))?.body).toMatchObject({ visibility: 'private' }),
    );
  });

  it('private_toggle_hidden_once_used_or_closed', async () => {
    await open({
      ...comments,
      items: [entry(item('1', { private_reply_message_id: 'dm-1' }), 'Fiyatı nedir?')],
    });
    expect(screen.queryByRole('button', { name: 'Özel (DM)' })).not.toBeInTheDocument();
  });

  it('character_counter_enforces_surface_bounds', async () => {
    await open({ ...comments, rules: { ...igRules, public: { min: 1, max: 10 } } });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Yanıtınız' }), 'Merhaba dünya!');
    expect(screen.getByTestId('char-count')).toHaveTextContent('14 / 10');
    expect(screen.getByRole('button', { name: 'Yanıtı gönder' })).toBeDisabled();
  });

  it('surface_without_hide_or_private_reply_offers_neither', async () => {
    await open({
      ...comments,
      rules: { ...igRules, private: null, hide: false, delete: false },
      items: [entry(item('1', { deadline: inHours(20) }), 'S bedeni var mı?')],
    });
    expect(screen.queryByRole('button', { name: 'Gizle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Özel (DM)' })).not.toBeInTheDocument();
  });

  it('approval_note_when_required', async () => {
    await open({ ...comments, approval_required: true });
    expect(screen.getByText('Bu hesapta ajanın yanıtları sizin onayınızı bekler.')).toBeInTheDocument();
  });

  it('each_item_action_has_its_own_pending_state', async () => {
    await open(comments, {
      'POST /api/inbox/items/1/hide': delayed(500, { item: item('1', { moderation: 'hidden' }), outcome: 'applied' }),
    });
    const user = userEvent.setup();
    const [first, , third] = screen.getAllByTestId('public-item');
    // Taken before the click: a busy button's name gains its spinner's label.
    const hideFirst = within(first).getByRole('button', { name: 'Gizle' });
    const hideThird = within(third).getByRole('button', { name: 'Gizle' });
    await user.click(hideFirst);
    await waitFor(() => expect(hideFirst).toBeDisabled());
    expect(hideThird).toBeEnabled();
  });

  it('composer_resets_on_item_change', async () => {
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Yanıtınız' }), 'Taslak');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Yanıtlanan' }), '4');
    expect(screen.getByRole('textbox', { name: 'Yanıtınız' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Yanıtlanan' })).toHaveValue('4');
  });

  it('enter_cannot_double_submit', async () => {
    const calls = await open(comments, {
      'POST /api/inbox/conversations/conv-2/reply': delayed(300, { message_id: 'r-1', state: 'sent' }),
    });
    const user = userEvent.setup();
    const reply = screen.getByRole('textbox', { name: 'Yanıtınız' });
    await user.type(reply, 'Merhaba');
    const form = reply.closest('form')!;
    form.requestSubmit();
    form.requestSubmit();
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/reply'))).toHaveLength(1));
  });

  it('delete_needs_typed_confirmation_and_manage', async () => {
    const calls = await open(comments, {
      'POST /api/inbox/items/1/delete': { item: item('1', { moderation: 'deleted' }), outcome: 'applied' },
    });
    const user = userEvent.setup();
    const [first] = screen.getAllByTestId('public-item');
    await user.click(within(first).getByRole('button', { name: 'Sil' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Kalıcı olarak sil' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'SİL');
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/inbox/items/1/delete')?.body).toEqual({ confirm: true }),
    );
  });

  it('delete_is_not_offered_without_manage', async () => {
    const me = inboxAnswers['GET /api/auth/me'] as { memberships: { permissions: string[] }[] };
    const worker = {
      ...me,
      memberships: [
        { ...me.memberships[0], permissions: me.memberships[0].permissions.filter((p) => p !== 'inbox.manage') },
      ],
    };
    await open(comments, { 'GET /api/auth/me': worker });
    expect(screen.queryByRole('button', { name: 'Sil' })).not.toBeInTheDocument();
  });

  it('held_card_approve_edit_discard', async () => {
    const draft = {
      id: 'draft-1',
      conversation_id: 'conv-2',
      workspace_id: WS_ID,
      direction: 'outbound',
      author: 'agent',
      body: 'Merhaba, fiyatı DM ile ilettik.',
      status: 'queued',
      external_id: null,
      cost_minor: null,
      at: '2026-10-23T12:30:00Z',
      item: { item_id: '1', kind: 'comment', answer_state: 'awaiting', visibility: 'public' },
    };
    const calls = await open(comments, {
      'GET /api/inbox/conversations/conv-2/messages': { items: [draft], next_cursor: null },
      'GET /api/inbox/pending': {
        ours: [],
        reopen_questions: [],
        merges: [],
        tasks_due: [],
        public_due: [],
        approvals: [{ outbox_id: 'held-1', conversation_id: 'conv-2', item_id: '1', deadline: null }],
      },
      'POST /api/inbox/replies/held-1/approve': { message_id: 'draft-1', state: 'sent' },
      'POST /api/inbox/replies/held-1/discard': { message_id: 'draft-1', state: 'refused' },
    });
    const user = userEvent.setup();
    const card = await screen.findByTestId('held-reply');
    expect(within(card).getByText('Merhaba, fiyatı DM ile ilettik.')).toBeInTheDocument();
    // The drafter (spec §9).
    expect(within(card).getByText('Ajan')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Onayla' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/inbox/replies/held-1/approve')?.body).toEqual({}),
    );
    await user.click(within(card).getByRole('button', { name: 'Düzenle ve onayla' }));
    const text = within(card).getByRole('textbox', { name: 'Taslak metni' });
    await user.clear(text);
    await user.type(text, 'Merhaba, DM attık.');
    await user.click(within(card).getByRole('button', { name: 'Onayla ve gönder' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/inbox/replies/held-1/approve').at(-1)?.body).toEqual({
        text: 'Merhaba, DM attık.',
      }),
    );
    await user.click(within(card).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/inbox/replies/held-1/discard')).toBe(true),
    );
  });

  it('a_person_and_journey_still_render_for_a_direct_conversation', async () => {
    mockFetch(inboxAnswers);
    renderAt('/inbox/conv-1');
    await screen.findByRole('textbox', { name: 'Yanıtınız' });
    expect(screen.queryByTestId('public-conversation')).not.toBeInTheDocument();
    expect(person.display_name).toBe('Deniz Örnek');
    expect(journey.id).toBe('journey-1');
  });
});
