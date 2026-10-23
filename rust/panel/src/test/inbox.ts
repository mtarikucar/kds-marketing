import { me, WS_ID, USER_ID } from './fixtures';

export const inboxMe = {
  ...me,
  memberships: [
    {
      ...me.memberships[0],
      workspace_status: 'active',
      permissions: [...me.memberships[0].permissions, 'inbox.work', 'inbox.manage'],
    },
  ],
};
export const person = {
  id: 'person-1',
  workspace_id: WS_ID,
  display_name: 'Deniz Örnek',
  company: 'Örnek',
  first_touch: { source: { channel: 'whats_app' }, capability_id: 'cap-1', at: '2026-10-23T10:00:00Z' },
  merged_into: null,
  erased_at: null,
  created_at: '2026-10-23T10:00:00Z',
  updated_at: '2026-10-23T10:00:00Z',
};
export const conversation = {
  id: 'conv-1',
  workspace_id: WS_ID,
  person_id: person.id,
  capability_id: 'cap-1',
  kind_key: 'whatsapp_cloud',
  state: 'ours',
  executor: { human: { user_id: 'another-human' } },
  executor_generation: 2,
  last_inbound_at: '2026-10-23T10:00:00Z',
  last_outbound_at: null,
  created_at: '2026-10-23T10:00:00Z',
  updated_at: '2026-10-23T10:00:00Z',
};
export const journey = {
  id: 'journey-1',
  workspace_id: WS_ID,
  person_id: person.id,
  status: 'contacted',
  owner: USER_ID,
  opened_at: '2026-10-23T10:00:00Z',
  closed_at: null,
  lost_reason: null,
  unreachable_attempts: 0,
  source: { channel: 'whats_app' },
  updated_at: '2026-10-23T10:00:00Z',
};
export const context = {
  person,
  journey,
  events: [],
  open_tasks: [],
  recent_conversations: [],
  strategy_guidance: null,
  prohibitions: ['human_held_for_agent'],
};
export const merge = {
  id: 'merge-1',
  workspace_id: WS_ID,
  source_id: 'person-2',
  target_id: person.id,
  decision: { suggest: ['display_name'] },
  conflicts: ['display_name'],
  status: 'suggested',
  moved_snapshot: null,
  at: '2026-10-23T10:00:00Z',
  applied_by: null,
  undone_at: null,
};
export const inboxAnswers: Record<string, unknown> = {
  'GET /api/auth/me': inboxMe,
  'GET /api/inbox/conversations': { items: [conversation], next_cursor: null },
  'GET /api/inbox/conversations/conv-1': conversation,
  'GET /api/inbox/conversations/conv-1/context': context,
  'GET /api/inbox/conversations/conv-1/messages': {
    items: [
      {
        id: 'message-1',
        conversation_id: 'conv-1',
        workspace_id: WS_ID,
        direction: 'inbound',
        author: 'customer',
        body: 'Merhaba, görüşebilir miyiz?',
        status: 'received',
        external_id: null,
        cost_minor: null,
        at: '2026-10-23T10:00:00Z',
      },
    ],
    next_cursor: null,
  },
  'GET /api/inbox/journeys/journey-1': { journey, events: [], tasks: [], notes: [] },
  'GET /api/inbox/lost-reasons': [
    { workspace_id: WS_ID, key: 'fiyat', label: 'Bütçeye uygun değil', active: true, seeded: true },
  ],
  'GET /api/inbox/merges': [],
  'GET /api/inbox/people': [person],
  'GET /api/inbox/people/person-1': {
    person,
    identities: [],
    open_journey: journey,
    conversations: [conversation],
  },
  'GET /api/inbox/people/person-2': {
    person: { ...person, id: 'person-2', display_name: 'Deniz İkinci' },
    identities: [],
    open_journey: null,
    conversations: [],
  },
  'GET /api/team': [
    {
      membership_id: 'member-1',
      user_id: USER_ID,
      email: 'owner@alpha.example',
      display_name: 'Ada Sahip',
      role_key: 'owner',
      role_name: 'Owner',
      status: 'active',
      created_at: '2026-10-23T10:00:00Z',
    },
  ],
  'GET /api/inbox/tasks': [],
  'GET /api/inbox/people/person-1/consents': { consents: [], suppressions: [] },
  'GET /api/inbox/journeys/journey-1/quotes': [],
  'POST /api/inbox/conversations/conv-1/reply': { message_id: 'reply-1', state: 'sent' },
  'POST /api/inbox/journeys/journey-1/events': { transition: null, effects: [], duplicate: false },
  'POST /api/inbox/conversations/conv-1/unsnooze': conversation,
};
