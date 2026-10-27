import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { CallOut } from '@/api/calls';
import type { MeOut } from '@/api/types';
import { me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';
import { call, caller } from './CallsPage.test';

const manager: MeOut = {
  ...me,
  memberships: [
    { ...me.memberships[0], permissions: [...me.memberships[0].permissions, 'calls.work', 'calls.manage'] },
  ],
};

const open: CallOut = {
  call: { ...call, state: 'live', outcome: null, end_cause: null, ended_at: null, duration_s: null },
  turns: [
    { seq: 0, at: '2026-10-22T08:00:10Z', kind: { kind: 'event', name: 'answered' }, text: '', meta: {} },
    { seq: 1, at: '2026-10-22T08:00:12Z', kind: { kind: 'utterance' }, text: 'Evet, buyurun', meta: { confidence: 0.9 } },
    { seq: 2, at: '2026-10-22T08:00:15Z', kind: { kind: 'say', by: 'agent' }, text: 'Randevunuz yarın 14:00.', meta: { latency_ms: 3000 } },
  ],
};

describe('CallDetail', () => {
  it('renders_turns_timeline', async () => {
    mockFetch({ 'GET /api/auth/me': caller, [`GET /api/calls/${call.id}`]: open });
    renderAt(`/calls/${call.id}`);
    const flow = await screen.findByRole('list', { name: tr.calls.detail.turns });
    const items = within(flow).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-speaker'))).toEqual(['line', 'counterpart', 'agent']);
    expect(within(flow).getByText('Evet, buyurun')).toBeInTheDocument();
    expect(within(flow).getByText(/3\.0/)).toBeInTheDocument();
    // The number stays masked for a caller without calls.manage.
    expect(screen.getByText('+90 5** *** ** 67')).toBeInTheDocument();
  });

  it('end_button_needs_calls_manage', async () => {
    const user = userEvent.setup();
    // Without calls.manage: no way to close the call here.
    mockFetch({ 'GET /api/auth/me': caller, [`GET /api/calls/${call.id}`]: open });
    const first = renderAt(`/calls/${call.id}`);
    await screen.findByRole('list', { name: tr.calls.detail.turns });
    expect(screen.queryByRole('button', { name: tr.calls.detail.end })).toBeNull();
    first.unmount();
    // With it: the outcome is recorded, and the manager sees the number.
    const ended: CallOut = { ...open, call: { ...open.call, state: 'ended', outcome: 'appointment' } };
    const calls = mockFetch({
      'GET /api/auth/me': manager,
      [`GET /api/calls/${call.id}`]: { ...open, call: { ...open.call, counterpart_e164: '+905321234567' } },
      [`POST /api/calls/${call.id}/end`]: ended,
      'GET /api/calls': [],
    });
    renderAt(`/calls/${call.id}`);
    expect(await screen.findByText('+905321234567')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: tr.calls.outcomes.appointment }));
    await user.type(screen.getByLabelText(tr.calls.detail.summary), 'Perşembe 14:00');
    await user.click(screen.getByRole('button', { name: tr.calls.detail.end }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
        { outcome: 'appointment', summary: 'Perşembe 14:00' },
      ]),
    );
  });
});
