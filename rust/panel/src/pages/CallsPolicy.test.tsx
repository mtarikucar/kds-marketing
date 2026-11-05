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
  opening_outbound: "Merhaba, ben Acme'nin dijital asistanıyım.",
  transcript_notice: 'Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.',
  closing: 'Görüşmek üzere, iyi günler.',
  phrases: {
    acknowledgements: ['Hı hı.', 'Anladım.', 'Tamam.', 'Peki.'],
    fillers: ['Bir saniye, hemen bakıyorum.', 'Kontrol ediyorum, kısa bir an.'],
    long_wait: ['Biraz daha zaman alıyor, beklediğiniz için teşekkürler.'],
    not_heard: ['Sizi tam duyamadım, tekrar eder misiniz?'],
    still_there: ['Hâlâ orada mısınız?'],
    fault: ['Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız.'],
  },
};

describe('CallsPolicy', () => {
  it('opens only the first section initially and retains edits when an optional section is closed', async () => {
    const calls = mockFetch({ 'GET /api/auth/me': manager, 'GET /api/calls': [], 'GET /api/calls/policy': stored });
    renderAt('/calls');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Arama ayarları' }));
    expect(await screen.findByLabelText(tr.calls.policy.fields.greeting_inbound)).toBeVisible();
    expect(screen.getByLabelText(tr.calls.policy.fields.holding_default)).not.toBeVisible();
    expect(screen.getByLabelText(tr.calls.policy.fields.max_duration_s)).not.toBeVisible();
    const phrases = screen.getByText(tr.calls.policy.phrasesTitle, { selector: 'summary' });
    await user.click(phrases);
    await user.type(screen.getByLabelText(tr.calls.policy.fields.holding_default), 'Taslak bekletme metni');
    await user.click(phrases);
    expect(screen.getByLabelText(tr.calls.policy.fields.holding_default)).not.toBeVisible();
    await user.click(phrases);
    expect(screen.getByLabelText(tr.calls.policy.fields.holding_default)).toHaveValue('Taslak bekletme metni');
    expect(calls.some(call => call.method === 'PUT')).toBe(false);
  });
  it('saves_policy', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': manager,
      'GET /api/calls': [],
      'GET /api/calls/policy': stored,
      'PUT /api/calls/policy': { ...stored, greeting_inbound: 'Merhaba' },
    });
    renderAt('/calls');
    await user.click(await screen.findByRole('tab', { name: 'Arama ayarları' }));
    const greeting = await screen.findByLabelText(tr.calls.policy.fields.greeting_inbound);
    await user.type(greeting, 'Merhaba');
    await user.click(screen.getByText(tr.calls.policy.phrasesTitle, { selector: 'summary' }));
    await user.type(screen.getByLabelText(tr.calls.policy.fields.holding_default), 'Bir saniye{enter}Hemen bakıyorum');
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { ...stored, greeting_inbound: 'Merhaba', holding_default: ['Bir saniye', 'Hemen bakıyorum'] },
      ]),
    );
  });

  it('saves_openings_and_phrases', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': manager,
      'GET /api/calls': [],
      'GET /api/calls/policy': stored,
      'PUT /api/calls/policy': stored,
    });
    renderAt('/calls');
    await user.click(await screen.findByRole('tab', { name: 'Arama ayarları' }));
    const notice = await screen.findByLabelText(tr.calls.policy.fields.transcript_notice);
    expect(screen.getByLabelText(tr.calls.policy.fields.closing)).toHaveValue(stored.closing);
    await user.clear(notice);
    await user.type(notice, 'Görüşme yazıya dökülür.');
    await user.click(screen.getByText(tr.calls.policy.phrasesTitle, { selector: 'summary' }));
    await user.type(screen.getByLabelText(tr.calls.policy.phrases.fillers), '{enter}Hemen dönüyorum.');
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        {
          ...stored,
          transcript_notice: 'Görüşme yazıya dökülür.',
          phrases: { ...stored.phrases, fillers: [...stored.phrases.fillers, 'Hemen dönüyorum.'] },
        },
      ]),
    );
  });

  it('reloads_the_policy_after_saving', async () => {
    // The save answers the stored policy, whose untouched templates are null or empty: the form
    // shows the policy as read again (the templates filled in), never the raw stored one.
    const user = userEvent.setup();
    const shown: CallPolicy = { ...stored, disclosure_sentence: "ben Acme'nin dijital asistanıyım" };
    const calls = mockFetch({
      'GET /api/auth/me': manager,
      'GET /api/calls': [],
      'GET /api/calls/policy': shown,
      'PUT /api/calls/policy': { ...shown, opening_outbound: null, disclosure_sentence: '' },
    });
    renderAt('/calls');
    await user.click(await screen.findByRole('tab', { name: 'Arama ayarları' }));
    const opening = await screen.findByLabelText(tr.calls.policy.fields.opening_outbound);
    expect(opening).toHaveValue(stored.opening_outbound);
    const reads = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/calls/policy').length;
    const before = reads();
    await user.click(screen.getByRole('button', { name: tr.common.save }));
    await waitFor(() => expect(reads()).toBe(before + 1));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    expect(screen.getByLabelText(tr.calls.policy.fields.opening_outbound)).toHaveValue(stored.opening_outbound);
    expect(screen.getByLabelText(tr.calls.policy.fields.disclosure_sentence)).toHaveValue(shown.disclosure_sentence);
  });
});
