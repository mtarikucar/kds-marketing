import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import i18n from '@/i18n/config';
import type { CallView } from '@/api/calls';
import type { MeOut } from '@/api/types';
import { me } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

/** The owner, holding the call permissions. */
export const caller: MeOut = {
  ...me,
  memberships: [
    {
      ...me.memberships[0],
      permissions: [...me.memberships[0].permissions, 'calls.work'],
    },
  ],
};

export const call: CallView = {
  id: '0193b000-0000-7000-8000-0000000000c1',
  capability_id: '0193b000-0000-7000-8000-0000000000c2',
  direction: 'outbound',
  purpose: 'commercial',
  person_id: '0193b000-0000-7000-8000-0000000000c3',
  journey_id: null,
  mode: { kind: 'human', rep_extension: '101' },
  state: 'ended',
  counterpart: '+90 5** *** ** 67',
  started_at: '2026-10-22T08:00:00Z',
  answered_at: '2026-10-22T08:00:10Z',
  ended_at: '2026-10-22T08:01:45Z',
  end_cause: { cause: 'caller_hangup' },
  outcome: 'connected',
  summary: null,
  duration_s: 95,
  cost_minor: 300,
  recording: { state: 'off' },
};

describe('CallsPage', () => {
  it('lists_calls_with_masked_numbers', async () => {
    mockFetch({ 'GET /api/auth/me': caller, 'GET /api/calls': [call] });
    const { container } = renderAt('/calls');
    const table = await screen.findByRole('table', { name: tr.calls.title });
    expect(within(table).getByText('+90 5** *** ** 67')).toBeInTheDocument();
    expect(within(table).getByText('1:35')).toBeInTheDocument();
    expect(within(table).getByText(tr.calls.outcomes.connected)).toBeInTheDocument();
    // No unmasked number anywhere on the page.
    expect(container.innerHTML).not.toMatch(/\+?90\s?5\d{9}/);
    expect(screen.getByRole('link', { name: /2026|22/ })).toHaveAttribute('href', `/calls/${call.id}`);
  });

  it('place_call_dialog_refusal_shows_reason', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': caller,
      'GET /api/calls': [],
      'POST /api/calls': withStatus(409, {
        code: 'CONFLICT',
        message: 'the call is refused: consent_missing',
        details: { reason: 'consent_missing' },
      }),
    });
    renderAt('/calls');
    await user.click(await screen.findByRole('button', { name: tr.calls.place.open }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(tr.calls.place.target), '05321234567');
    await user.type(within(dialog).getByLabelText(tr.calls.place.extension), '101');
    await user.click(within(dialog).getByRole('radio', { name: new RegExp(tr.calls.purposes.commercial) }));
    await user.click(within(dialog).getByRole('button', { name: tr.calls.place.submit }));
    expect(
      await within(dialog).findByText(i18n.t('calls.place.refused', { reason: tr.calls.refusals.consent_missing })),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/calls').map((c) => c.body)).toEqual([
        { purpose: 'commercial', mode: 'human', rep_extension: '101', phone: '05321234567' },
      ]),
    );
  });

  it('asks for the calls permission instead of listing', async () => {
    mockFetch({ 'GET /api/auth/me': me });
    renderAt('/calls');
    expect(await screen.findByText(tr.calls.noPermission)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.calls.place.open })).toBeNull();
  });
});
