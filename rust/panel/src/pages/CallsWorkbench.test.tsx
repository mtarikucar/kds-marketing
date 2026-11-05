import { expect, it } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CallPolicy, CallView } from '@/api/calls';
import { me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';
import tr from '@/i18n/tr.json';

const caller = {
  ...me,
  memberships: me.memberships.map((member) => ({ ...member, permissions: [...member.permissions, 'calls.work' as const] })),
};
const manager = {
  ...caller,
  memberships: caller.memberships.map((member) => ({ ...member, permissions: [...member.permissions, 'calls.manage' as const] })),
};
const record: CallView = {
  id: 'call-recorded', capability_id: 'cap-1', direction: 'outbound', purpose: 'service', person_id: 'person-1', journey_id: null,
  mode: { kind: 'human', rep_extension: '101' }, state: 'ended', counterpart: '+90 5** *** ** 67',
  started_at: '2026-10-22T08:00:00Z', answered_at: null, ended_at: '2026-10-22T08:01:00Z', end_cause: null,
  outcome: 'connected', summary: null, duration_s: 60, cost_minor: null, recording: { state: 'off' },
};
const policy: CallPolicy = {
  greeting_inbound: '', voicemail_text: '', recording_announcement: '', disclose_assistant: true, disclosure_sentence: '', holding_default: [],
  max_duration_s: 360, slow_agent_s: 4, holding_again_s: 10, fallback_after_s: 20, caller_silence_s: 6, caller_silence_close_s: 15,
  handoff_extension: null, estimated_minor_per_minute: 0, opening_outbound: null, transcript_notice: null, closing: null,
  phrases: { acknowledgements: [], fillers: [], long_wait: [], not_heard: [], still_there: [], fault: [] },
};

it('separates open calls from ended calls awaiting an outcome and gives managers the correct next action', async () => {
  const openStates = ['planned', 'dialing', 'ringing', 'live', 'holding', 'ending'] as const;
  const openCalls = openStates.map((state, index): CallView => ({
    ...record, id: `call-${state}`, state, counterpart: `+90 5** *** ** ${20 + index}`, outcome: null, ended_at: null,
  }));
  const unfinished: CallView = { ...record, id: 'call-unrecorded', counterpart: '+90 5** *** ** 99', outcome: null };
  const requests = mockFetch({
    'GET /api/auth/me': manager, 'GET /api/calls': [...openCalls, unfinished, record], 'GET /api/calls/policy': policy,
  });
  renderAt('/calls');
  await screen.findByRole('table', { name: tr.calls.title });
  const user = userEvent.setup();
  const queues = screen.getByRole('group', { name: 'Arama iş kuyruğu' });

  await user.click(within(queues).getByRole('button', { name: 'Sonuç bekleyenler' }));
  const unfinishedTable = screen.getByRole('table', { name: tr.calls.title });
  expect(within(unfinishedTable).getAllByRole('row')).toHaveLength(2);
  expect(within(unfinishedTable).getByText(unfinished.counterpart)).toBeInTheDocument();
  expect(within(unfinishedTable).getByRole('link', { name: 'Sonuç kaydet' })).toHaveAttribute('href', '/calls/call-unrecorded');
  expect(within(unfinishedTable).queryByText(record.counterpart)).not.toBeInTheDocument();

  await user.click(within(queues).getByRole('button', { name: 'Açık aramalar' }));
  const openTable = screen.getByRole('table', { name: tr.calls.title });
  expect(within(openTable).getAllByRole('row')).toHaveLength(openStates.length + 1);
  for (const call of openCalls) expect(within(openTable).getByText(call.counterpart)).toBeInTheDocument();
  expect(within(openTable).queryByRole('link', { name: 'Sonuç kaydet' })).not.toBeInTheDocument();
  expect(requests.filter((request) => request.method === 'GET' && request.path === '/api/calls')).toHaveLength(1);
});

it('combines search, queue and direction, then restores all loaded calls without refetching or promising restricted actions', async () => {
  const pending: CallView = { ...record, id: 'inbound-pending', direction: 'inbound', outcome: null, summary: 'İzmir randevusu için bilgi verildi' };
  const active: CallView = { ...record, id: 'outbound-live', state: 'live', outcome: null, counterpart: '+90 5** *** ** 42', mode: { kind: 'human', rep_extension: '202' } };
  const answered: CallView = { ...record, id: 'answered', counterpart: '+90 5** *** ** 73', mode: { kind: 'agent' } };
  const requests = mockFetch({ 'GET /api/auth/me': caller, 'GET /api/calls': [pending, active, answered] });
  renderAt('/calls');
  await screen.findByRole('table', { name: tr.calls.title });
  const user = userEvent.setup();
  const search = screen.getByRole('searchbox', { name: 'Numara, dahili veya özet ara' });
  const queues = screen.getByRole('group', { name: 'Arama iş kuyruğu' });
  const directions = screen.getByRole('group', { name: tr.calls.columns.direction });

  await user.type(search, 'izmir');
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
  expect(screen.getByText(pending.summary!)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Sonuç kaydet' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('table')).getByRole('link', { name: 'Aramayı incele' })).toHaveAttribute('href', '/calls/inbound-pending');

  await user.click(within(queues).getByRole('button', { name: 'Sonuç bekleyenler' }));
  await user.click(within(directions).getByRole('button', { name: tr.calls.directions.outbound }));
  expect(screen.getByText('Bu filtrelerle eşleşen arama yok')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: tr.calls.showAll }));
  expect(search).toHaveValue('');
  expect(within(queues).getByRole('button', { name: 'Tüm aramalar' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(directions).getByRole('button', { name: tr.inbox.queue.all })).toHaveAttribute('aria-pressed', 'true');
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);

  await user.type(search, '202');
  expect(within(screen.getByRole('table')).getByText(active.counterpart)).toBeInTheDocument();
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
  await user.clear(search);
  await user.type(search, '73');
  expect(within(screen.getByRole('table')).getByText(answered.counterpart)).toBeInTheDocument();
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
  expect(requests.filter((request) => request.method === 'GET' && request.path === '/api/calls')).toHaveLength(1);
  expect(requests.some((request) => request.method === 'POST')).toBe(false);
  expect(screen.queryByRole('tab', { name: 'Arama ayarları' })).not.toBeInTheDocument();
});

it('loads call settings only when an authorized manager opens the settings tab', async () => {
  const requests = mockFetch({ 'GET /api/auth/me': manager, 'GET /api/calls': [record], 'GET /api/calls/policy': policy });
  renderAt('/calls');
  await screen.findByRole('table', { name: tr.calls.title });
  expect(requests.some((request) => request.path === '/api/calls/policy')).toBe(false);
  expect(screen.queryByLabelText(tr.calls.policy.fields.greeting_inbound)).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'Arama ayarları' }));
  const greeting = await screen.findByLabelText(tr.calls.policy.fields.greeting_inbound);
  await user.type(greeting, 'Kaydedilmemiş karşılama');
  expect(screen.queryByRole('table', { name: tr.calls.title })).not.toBeInTheDocument();
  expect(requests.filter((request) => request.path === '/api/calls/policy')).toHaveLength(1);
  await user.click(screen.getByRole('tab', { name: 'Görüşmeler' }));
  expect(screen.getByRole('table', { name: tr.calls.title })).toBeInTheDocument();
  expect(greeting).not.toBeVisible();
  await user.click(screen.getByRole('tab', { name: 'Arama ayarları' }));
  expect(screen.getByLabelText(tr.calls.policy.fields.greeting_inbound)).toHaveValue('Kaydedilmemiş karşılama');
  expect(requests.filter((request) => request.path === '/api/calls/policy')).toHaveLength(1);
});

it('pages loaded calls, resets the page for a new filter and stays on a valid page after records shrink', async () => {
  const rows: CallView[] = Array.from({ length: 23 }, (_, index) => ({
    ...record, id: `paged-${index}`, counterpart: `+90 5** *** ** ${30 + index}`, outcome: index >= 21 ? null : 'connected',
    summary: index === 22 ? 'Son kayıt' : null,
  }));
  const answers: Record<string, unknown> = { 'GET /api/auth/me': caller, 'GET /api/calls': rows };
  const requests = mockFetch(answers);
  const { client } = renderAt('/calls');
  await screen.findByRole('table', { name: tr.calls.title });
  const user = userEvent.setup();
  const pagination = screen.getByRole('navigation', { name: 'Arama sayfaları' });
  const next = within(pagination).getByRole('button', { name: 'Sonraki' });
  const previous = within(pagination).getByRole('button', { name: 'Önceki' });
  const queues = screen.getByRole('group', { name: 'Arama iş kuyruğu' });
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(11);
  expect(previous).toBeDisabled();
  await user.click(next);
  await user.click(next);
  expect(within(pagination).getByText('21–23 / 23 kayıt')).toBeInTheDocument();
  expect(next).toBeDisabled();

  await user.click(within(queues).getByRole('button', { name: 'Sonuç bekleyenler' }));
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
  expect(previous).toBeDisabled();
  expect(within(pagination).getByText('1–2 / 2 kayıt')).toBeInTheDocument();

  await user.click(within(queues).getByRole('button', { name: 'Tüm aramalar' }));
  await user.click(next);
  const search = screen.getByRole('searchbox', { name: 'Numara, dahili veya özet ara' });
  await user.type(search, 'son kayıt');
  expect(within(screen.getByRole('table')).getByText(rows[22].counterpart)).toBeInTheDocument();
  expect(within(pagination).getByText('1–1 / 1 kayıt')).toBeInTheDocument();
  expect(previous).toBeDisabled();

  await user.clear(search);
  await user.click(next);
  await user.click(next);
  answers['GET /api/calls'] = rows.slice(0, 4);
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls'] }); });
  expect(await within(pagination).findByText('1–4 / 4 kayıt')).toBeInTheDocument();
  expect(previous).toBeDisabled();
  expect(next).toBeDisabled();
  expect(within(screen.getByRole('table')).getByText(rows[0].counterpart)).toBeInTheDocument();

  answers['GET /api/calls'] = rows;
  await act(async () => { await client.invalidateQueries({ queryKey: ['calls'] }); });
  expect(await within(pagination).findByText('1–10 / 23 kayıt')).toBeInTheDocument();
  expect(previous).toBeDisabled();
  // Only the explicit refreshes read again; paging and filtering work on the loaded records.
  expect(requests.filter((request) => request.method === 'GET' && request.path === '/api/calls')).toHaveLength(3);
});
