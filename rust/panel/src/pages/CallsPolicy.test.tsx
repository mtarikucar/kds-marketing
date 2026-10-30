import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { CallPolicy } from '@/api/calls';
import type { MeOut } from '@/api/types';
import { me } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';

const manager: MeOut = {
  ...me,
  memberships: [
    { ...me.memberships[0], permissions: [...me.memberships[0].permissions, 'calls.work', 'calls.manage'] },
  ],
};

const stored: CallPolicy = {
  greeting_inbound: '',
  voicemail_text: '',
  recording_announcement: '',
  disclose_assistant: true,
  disclosure_sentence: '',
  holding_default: [],
  max_duration_s: 360,
  slow_agent_s: 4,
  holding_again_s: 10,
  fallback_after_s: 20,
  caller_silence_s: 6,
  caller_silence_close_s: 15,
  handoff_extension: null,
  estimated_minor_per_minute: 0,
};

describe('CallsPolicy', () => {
  it('saves_policy', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': manager,
      'GET /api/calls': [],
      'GET /api/calls/policy': stored,
      'PUT /api/calls/policy': { ...stored, greeting_inbound: 'Merhaba' },
    });
    renderAt('/calls');
    const greeting = await screen.findByLabelText(tr.calls.policy.fields.greeting_inbound);
    await user.type(greeting, 'Merhaba');
    await user.type(screen.getByLabelText(tr.calls.policy.fields.holding_default), 'Bir saniye{enter}Hemen bakıyorum');
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { ...stored, greeting_inbound: 'Merhaba', holding_default: ['Bir saniye', 'Hemen bakıyorum'] },
      ]),
    );
  });
});
