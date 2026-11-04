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

  it('shows_the_calls_latency', async () => {
    const timed: CallOut = {
      call: {
        ...call,
        latency: {
          turns: 2,
          backchannel_cuts: 0,
          alerts: ['content_p95_over_3s'],
          perceived: { n: 2, p50: 620, p95: 640 },
          content: { n: 2, p50: 3900, p95: 4760 },
          endpoint: { n: 2, p50: 260, p95: 280 },
          stt_final: { n: 2, p50: 310, p95: 330 },
          core_round: { n: 2, p50: 3600, p95: 4000 },
          agent: { n: 2, p50: 3200, p95: 4100 },
          barge_in_stop: { n: 0, p50: null, p95: null },
          transport: { n: 1, p50: 40, p95: 40 },
        },
      },
      turns: [],
    };
    mockFetch({ 'GET /api/auth/me': manager, [`GET /api/calls/${call.id}`]: timed });
    renderAt(`/calls/${call.id}`);
    expect(await screen.findByText(tr.calls.detail.latencyTitle)).toBeInTheDocument();
    expect(screen.getByText('620 / 640 ms')).toBeInTheDocument();
    expect(screen.getByText('— / — ms')).toBeInTheDocument();
    expect(screen.getByText(tr.calls.detail.alerts.content_p95_over_3s)).toBeInTheDocument();
  });

  it('shows_no_latency_for_a_call_without_traces', async () => {
    const untimed: CallOut = {
      ...open,
      call: {
        ...open.call,
        latency: {
          turns: 0,
          backchannel_cuts: 0,
          alerts: [],
          perceived: { n: 0, p50: null, p95: null },
          content: { n: 0, p50: null, p95: null },
          endpoint: { n: 0, p50: null, p95: null },
          stt_final: { n: 0, p50: null, p95: null },
          core_round: { n: 0, p50: null, p95: null },
          agent: { n: 1, p50: 3000, p95: 3000 },
          barge_in_stop: { n: 0, p50: null, p95: null },
          transport: { n: 0, p50: null, p95: null },
        },
      },
    };
    mockFetch({ 'GET /api/auth/me': caller, [`GET /api/calls/${call.id}`]: untimed });
    renderAt(`/calls/${call.id}`);
    await screen.findByRole('list', { name: tr.calls.detail.turns });
    expect(screen.queryByText(tr.calls.detail.latencyTitle)).toBeNull();
  });
});
